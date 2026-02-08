import { logger } from "../../utils/logger.js";
import type {
	LLMProvider,
	LLMMessage,
	LLMResponse,
	LLMStreamEvent,
	CompletionOptions,
	ProviderConfig,
	MessageContent,
	ToolCallContent,
	TextContent,
} from "../types.js";

/**
 * OpenAI-compatible provider.
 * Works with: OpenAI, OpenRouter, Moonshot, MiniMax, DeepSeek, Groq,
 *             Together, xAI, Gemini, Mistral, Ollama, vLLM, LM Studio, etc.
 */
export class OpenAICompatibleProvider implements LLMProvider {
	readonly name: string;
	readonly protocol = "openai-compatible" as const;

	private baseUrl: string;
	private apiKey: string;
	private model: string;
	private headers: Record<string, string>;
	private maxRetries: number;
	private timeout: number;

	constructor(config: ProviderConfig, opts: { model?: string; apiKey?: string; maxRetries?: number; timeout?: number }) {
		this.name = config.name;
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.apiKey = opts.apiKey || process.env[config.apiKeyEnvVar] || "";
		this.model = opts.model || config.defaultModel;
		this.headers = config.headers || {};
		this.maxRetries = opts.maxRetries ?? 3;
		this.timeout = opts.timeout ?? 60000;
	}

	async complete(messages: LLMMessage[], opts?: CompletionOptions): Promise<LLMResponse> {
		const body = this.buildRequestBody(messages, opts, false);

		logger.debug("llm", `[${this.name}] Calling ${this.model} (non-streaming)`);

		const response = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, body, opts?.signal);
		const data = await response.json();

		return this.parseResponse(data);
	}

	async *stream(messages: LLMMessage[], opts?: CompletionOptions): AsyncIterable<LLMStreamEvent> {
		const body = this.buildRequestBody(messages, opts, true);

		logger.debug("llm", `[${this.name}] Streaming ${this.model}`);

		const response = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, body, opts?.signal);

		if (!response.body) {
			throw new Error(`[${this.name}] No response body for streaming`);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let fullText = "";
		const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
		let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		let stopReason = "stop";
		let model = this.model;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith("data: ")) continue;

					const dataStr = trimmed.slice(6);
					if (dataStr === "[DONE]") continue;

					let data: any;
					try {
						data = JSON.parse(dataStr);
					} catch {
						continue;
					}

					if (data.model) model = data.model;
					if (data.usage) {
						usage = {
							inputTokens: data.usage.prompt_tokens || 0,
							outputTokens: data.usage.completion_tokens || 0,
							totalTokens: data.usage.total_tokens || 0,
						};
					}

					const choice = data.choices?.[0];
					if (!choice) continue;

					if (choice.finish_reason) {
						stopReason = choice.finish_reason;
					}

					const delta = choice.delta;
					if (!delta) continue;

					// Text content
					if (delta.content) {
						fullText += delta.content;
						yield { type: "text_delta", delta: delta.content };
					}

					// Tool calls
					if (delta.tool_calls) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index ?? 0;
							if (!toolCalls.has(idx)) {
								toolCalls.set(idx, { id: tc.id || "", name: tc.function?.name || "", arguments: "" });
							}
							const existing = toolCalls.get(idx)!;
							if (tc.id) existing.id = tc.id;
							if (tc.function?.name) existing.name = tc.function.name;
							if (tc.function?.arguments) existing.arguments += tc.function.arguments;

							yield {
								type: "tool_call_delta",
								index: idx,
								id: existing.id || undefined,
								name: existing.name || undefined,
								argumentsDelta: tc.function?.arguments || "",
							};
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		// Build content blocks
		const contentBlocks: MessageContent[] = [];
		if (fullText) {
			contentBlocks.push({ type: "text", text: fullText });
		}
		for (const [, tc] of toolCalls) {
			let args: Record<string, any> = {};
			try {
				args = JSON.parse(tc.arguments);
			} catch {
				// Keep as empty
			}
			contentBlocks.push({ type: "tool_call", id: tc.id, name: tc.name, arguments: args });
		}

		yield {
			type: "done",
			response: {
				content: fullText,
				contentBlocks,
				usage,
				stopReason,
				model,
			},
		};
	}

	// ─── Internal ────────────────────────────────────────

	private buildRequestBody(messages: LLMMessage[], opts?: CompletionOptions, stream = false): any {
		const body: any = {
			model: this.model,
			stream,
			...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
		};

		if (stream) {
			body.stream_options = { include_usage: true };
		}

		if (opts?.temperature !== undefined) {
			body.temperature = opts.temperature;
		}

		if (opts?.responseFormat === "json") {
			body.response_format = { type: "json_object" };
		}

		// Convert messages
		body.messages = this.convertMessages(messages, opts?.systemPrompt);

		// Tools
		if (opts?.tools && opts.tools.length > 0) {
			body.tools = opts.tools.map((t) => ({
				type: "function",
				function: {
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				},
			}));

			if (opts.toolChoice) {
				if (typeof opts.toolChoice === "string") {
					body.tool_choice = opts.toolChoice;
				} else {
					body.tool_choice = { type: "function", function: { name: opts.toolChoice.name } };
				}
			}
		}

		return body;
	}

	private convertMessages(messages: LLMMessage[], systemPrompt?: string): any[] {
		const result: any[] = [];

		// System prompt (from option or from messages)
		const systemMsg = systemPrompt || messages.find((m) => m.role === "system");
		if (systemMsg) {
			result.push({
				role: "system",
				content: typeof systemMsg === "string" ? systemMsg : (systemMsg as LLMMessage).content,
			});
		}

		for (const msg of messages) {
			if (msg.role === "system") continue;

			if (msg.role === "tool") {
				result.push({
					role: "tool",
					tool_call_id: msg.toolCallId,
					content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
				});
				continue;
			}

			if (typeof msg.content === "string") {
				const converted: any = { role: msg.role, content: msg.content };

				// If assistant message with tool calls in contentBlocks, we'd need to handle that
				// For now, simple string content
				result.push(converted);
			} else {
				// Array content — handle multimodal
				const parts: any[] = [];
				const toolCallsParts: any[] = [];

				for (const block of msg.content) {
					switch (block.type) {
						case "text":
							parts.push({ type: "text", text: block.text });
							break;
						case "image":
							parts.push({
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							});
							break;
						case "tool_call":
							toolCallsParts.push({
								id: block.id,
								type: "function",
								function: {
									name: block.name,
									arguments: JSON.stringify(block.arguments),
								},
							});
							break;
						case "thinking":
							// Append thinking as text with markers
							parts.push({ type: "text", text: `<thinking>\n${block.thinking}\n</thinking>` });
							break;
					}
				}

				const converted: any = { role: msg.role };
				if (parts.length > 0) {
					converted.content = parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
				}
				if (toolCallsParts.length > 0) {
					converted.tool_calls = toolCallsParts;
				}
				result.push(converted);
			}
		}

		return result;
	}

	private async fetchWithRetry(url: string, body: any, signal?: AbortSignal): Promise<Response> {
		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					...this.headers,
				};

				if (this.apiKey) {
					headers["Authorization"] = `Bearer ${this.apiKey}`;
				}

				const response = await fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal,
				});

				if (response.ok) {
					return response;
				}

				// Rate limit — retry with backoff
				if (response.status === 429 || response.status >= 500) {
					const retryAfter = response.headers.get("retry-after");
					const delay = retryAfter
						? parseInt(retryAfter, 10) * 1000
						: Math.min(1000 * Math.pow(2, attempt), this.timeout);

					logger.warn("llm", `[${this.name}] ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1})`);
					await new Promise((r) => setTimeout(r, delay));
					continue;
				}

				// Client error — don't retry
				const errorBody = await response.text().catch(() => "");
				throw new Error(`[${this.name}] API error ${response.status}: ${errorBody.substring(0, 500)}`);
			} catch (err: any) {
				if (err.name === "AbortError") throw err;
				lastError = err;

				if (attempt < this.maxRetries) {
					const delay = Math.min(1000 * Math.pow(2, attempt), this.timeout);
					logger.warn("llm", `[${this.name}] Request failed, retrying in ${delay}ms: ${err.message}`);
					await new Promise((r) => setTimeout(r, delay));
				}
			}
		}

		throw lastError || new Error(`[${this.name}] Request failed after ${this.maxRetries} retries`);
	}

	private parseResponse(data: any): LLMResponse {
		const choice = data.choices?.[0];
		const message = choice?.message;

		let text = message?.content || "";
		const contentBlocks: MessageContent[] = [];

		if (text) {
			contentBlocks.push({ type: "text", text });
		}

		// Tool calls
		if (message?.tool_calls) {
			for (const tc of message.tool_calls) {
				let args: Record<string, any> = {};
				try {
					args = JSON.parse(tc.function.arguments);
				} catch {
					// Keep empty
				}
				contentBlocks.push({
					type: "tool_call",
					id: tc.id,
					name: tc.function.name,
					arguments: args,
				});
			}
		}

		return {
			content: text,
			contentBlocks,
			usage: {
				inputTokens: data.usage?.prompt_tokens || 0,
				outputTokens: data.usage?.completion_tokens || 0,
				totalTokens: data.usage?.total_tokens || 0,
			},
			stopReason: choice?.finish_reason || "stop",
			model: data.model || this.model,
		};
	}
}
