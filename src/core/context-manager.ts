import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import type { LLMMessage, ToolCallContent } from "../llm/types.js";
import type { MemoryStore } from "../memory/store.js";
import { logger } from "../utils/logger.js";

// ─── Types ──────────────────────────────────────────────

export interface LLMUsage {
	inputTokens: number;
	outputTokens: number;
}

export interface ContextManagerConfig {
	llmClient: LLMClient;
	promptLoader: PromptLoader;
	contextWindowLimit?: number;
	compressionThreshold?: number;
	/** Memory flush threshold (ratio of contextWindowLimit). Must be < compressionThreshold. Default 0.6. */
	flushThreshold?: number;
	/** MemoryStore for flush writes (optional — flush disabled if not provided) */
	memoryStore?: MemoryStore;
}

// ─── ContextManager ─────────────────────────────────────

export class ContextManager {
	private llmClient: LLMClient;
	private promptLoader: PromptLoader;
	private contextWindowLimit: number;
	private compressionThreshold: number;
	private flushThreshold: number;

	private promptTemplate: string;
	private modules: Map<string, string> = new Map();
	private conversation: LLMMessage[] = [];

	// Hybrid token counting
	private lastKnownTokenCount = 0;
	private pendingChars = 0;

	// Memory Flush state
	private memoryStore: MemoryStore | null;
	private compactionCount = 0;
	private lastFlushCompactionCount = -1;

	constructor(config: ContextManagerConfig) {
		this.llmClient = config.llmClient;
		this.promptLoader = config.promptLoader;
		this.contextWindowLimit = config.contextWindowLimit ?? 128000;
		this.compressionThreshold = config.compressionThreshold ?? 0.7;
		this.flushThreshold = config.flushThreshold ?? 0.6;
		this.memoryStore = config.memoryStore ?? null;

		// Validate flush < compress invariant
		if (this.flushThreshold >= this.compressionThreshold) {
			throw new Error(
				`flushThreshold (${this.flushThreshold}) must be less than compressionThreshold (${this.compressionThreshold})`,
			);
		}

		this.promptTemplate = this.promptLoader.getRaw("main-agent");
	}

	// ─── System Prompt ────────────────────────────────────

	getSystemPrompt(): string {
		let prompt = this.promptTemplate;
		for (const [key, value] of this.modules) {
			prompt = prompt.replaceAll(`{{${key}}}`, value);
		}
		// Clear any remaining unreplaced variables
		prompt = prompt.replace(/\{\{[\w-]+\}\}/g, "");
		return prompt;
	}

	updateModule(key: string, value: string): void {
		this.modules.set(key, value);
	}

	// ─── Conversation Management ──────────────────────────

	addMessage(message: LLMMessage): void {
		this.conversation.push(message);
		// Accumulate chars for hybrid token counting
		if (typeof message.content === "string") {
			this.pendingChars += message.content.length;
		} else {
			this.pendingChars += JSON.stringify(message.content).length;
		}
	}

	getMessages(): LLMMessage[] {
		return this.conversation;
	}

	getConversationLength(): number {
		return this.conversation.length;
	}

	// ─── prepareForLLM (Layer 1) ──────────────────────────

	/**
	 * Prepare system prompt and messages for LLM call.
	 * Deep-clones the conversation, applies transformContext, and returns
	 * the transformed data. Original conversation is NOT modified.
	 */
	prepareForLLM(): { system: string; messages: LLMMessage[] } {
		const system = this.getSystemPrompt();
		const cloned = structuredClone(this.conversation);
		const transformed = this.transformContext(cloned);
		return { system, messages: transformed };
	}

	/**
	 * Apply tool result context guard (Layer 1):
	 * 1. Truncate any single tool result > 50% of context budget
	 * 2. Replace oldest tool results when total > 75% of context window
	 */
	private transformContext(messages: LLMMessage[]): LLMMessage[] {
		const singleCap = this.contextWindowLimit * 0.5;
		const singleCapChars = singleCap * 4; // tokens → chars

		// Step 1: Truncate oversized single tool results
		for (const msg of messages) {
			if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > singleCapChars) {
				msg.content = msg.content.slice(0, singleCapChars) + "\n...[truncated]";
			}
		}

		// Step 2: Budget overflow compaction (75% cap)
		const budgetCap = this.contextWindowLimit * 0.75;
		let totalTokens = this.estimateTokens(this.getSystemPrompt()) + this.estimateTokens(messages);

		if (totalTokens > budgetCap) {
			// Compact oldest tool results first
			for (const msg of messages) {
				if (totalTokens <= budgetCap) break;
				if (msg.role === "tool" && typeof msg.content === "string" && msg.content !== COMPACTED_PLACEHOLDER) {
					const freed = Math.ceil(msg.content.length / 4);
					msg.content = COMPACTED_PLACEHOLDER;
					totalTokens -= freed - Math.ceil(COMPACTED_PLACEHOLDER.length / 4);
				}
			}
		}

		return messages;
	}

	// ─── Hybrid Token Counting ────────────────────────────

	/**
	 * Report actual token usage from LLM API response.
	 * Resets pendingChars and calibrates the token count.
	 */
	reportUsage(usage: LLMUsage): void {
		this.lastKnownTokenCount = usage.inputTokens + usage.outputTokens;
		this.pendingChars = 0;
	}

	/**
	 * Get current token count estimate.
	 * Uses last known count + estimated tokens from pending chars.
	 */
	getCurrentTokenEstimate(): number {
		return this.lastKnownTokenCount + Math.ceil(this.pendingChars / 4);
	}

	// ─── Compression (Layer 3) ────────────────────────────

	shouldCompress(): boolean {
		const totalTokens = this.getCurrentTokenEstimate();
		// Fallback: if no API usage reported yet, use old estimation
		if (this.lastKnownTokenCount === 0) {
			const estimated = this.estimateTokens(this.getSystemPrompt()) + this.estimateTokens(this.conversation);
			return estimated > this.contextWindowLimit * this.compressionThreshold;
		}
		return totalTokens > this.contextWindowLimit * this.compressionThreshold;
	}

	async compress(): Promise<void> {
		const existingHistory = this.modules.get("compressed_history") ?? "";

		logger.info("context-manager", `Compressing conversation (${this.conversation.length} messages)`);

		const input = JSON.stringify({
			existing_history: existingHistory,
			new_conversation: this.conversation.map((m) => ({
				role: m.role,
				content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
			})),
			current_goal: this.modules.get("goal") ?? "",
		});

		const response = await this.llmClient.complete([{ role: "user", content: input }], {
			systemPrompt: this.promptLoader.resolve("history-compressor"),
			temperature: 0,
		});

		this.modules.set("compressed_history", response.content.trim());
		this.conversation = [];
		this.compactionCount++;

		// Reset token counting after compaction
		this.lastKnownTokenCount = 0;
		this.pendingChars = 0;

		// Post-compaction context injection
		this.conversation.push({
			role: "user",
			content: POST_COMPACTION_CONTEXT,
		});

		logger.info("context-manager", "Conversation compressed and reset");
	}

	// ─── Memory Flush (Layer 2) ───────────────────────────

	/**
	 * Check if memory flush should run.
	 * Returns true when:
	 * - Token estimate exceeds flush threshold
	 * - No flush has occurred in the current compaction cycle
	 * - MemoryStore is available
	 */
	shouldRunMemoryFlush(): boolean {
		if (!this.memoryStore) return false;
		if (this.lastFlushCompactionCount === this.compactionCount) return false;

		const tokenEstimate = this.getCurrentTokenEstimate();
		// Fallback for first run before any API usage
		if (this.lastKnownTokenCount === 0) {
			const estimated = this.estimateTokens(this.getSystemPrompt()) + this.estimateTokens(this.conversation);
			return estimated > this.contextWindowLimit * this.flushThreshold;
		}
		return tokenEstimate > this.contextWindowLimit * this.flushThreshold;
	}

	/**
	 * Run memory flush: analyze conversation and persist valuable info.
	 * Uses an independent LLM call that does NOT affect the main conversation.
	 */
	async runMemoryFlush(): Promise<void> {
		if (!this.memoryStore) return;

		logger.info("context-manager", "Running memory flush");

		// Build flush prompt from conversation
		const conversationSummary = this.conversation
			.slice(-30) // Last 30 messages (most recent context)
			.map((m) => {
				const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
				return `[${m.role}] ${content.slice(0, 500)}`;
			})
			.join("\n\n");

		const flushPrompt = `Review the following recent conversation and extract valuable information to persist to memory files.\n\n${conversationSummary}`;

		try {
			const flushSystemPrompt = this.promptLoader.resolve("memory-flush");

			const response = await this.llmClient.complete([{ role: "user", content: flushPrompt }], {
				systemPrompt: flushSystemPrompt,
				tools: [
					{
						name: "memory_write",
						description: "Write content to a memory file",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string", description: "Relative path" },
								content: { type: "string", description: "Content to append" },
							},
							required: ["path", "content"],
						},
					},
				],
				temperature: 0,
			});

			// Execute any memory_write tool calls
			const toolCalls = response.contentBlocks.filter((b): b is ToolCallContent => b.type === "tool_call");

			for (const call of toolCalls) {
				if (call.name === "memory_write") {
					const path = call.arguments.path as string;
					const content = call.arguments.content as string;
					try {
						await this.memoryStore.write({ path, content });
						logger.info("context-manager", `Flush wrote to ${path}`);
					} catch (err: any) {
						logger.warn("context-manager", `Flush write failed: ${err.message}`);
					}
				}
			}
		} catch (err: any) {
			logger.warn("context-manager", `Memory flush failed: ${err.message}`);
		}

		// Always update flush counter (even if nothing was written)
		this.lastFlushCompactionCount = this.compactionCount;
		logger.info("context-manager", "Memory flush complete");
	}

	// ─── Token Estimation (private) ───────────────────────

	private estimateTokens(input: string | LLMMessage[]): number {
		if (typeof input === "string") {
			return Math.ceil(input.length / 4);
		}
		let totalChars = 0;
		for (const msg of input) {
			if (typeof msg.content === "string") {
				totalChars += msg.content.length;
			} else {
				totalChars += JSON.stringify(msg.content).length;
			}
		}
		return Math.ceil(totalChars / 4);
	}
}

// ─── Constants ──────────────────────────────────────────

const COMPACTED_PLACEHOLDER = "[compacted: tool output removed to free context]";

const POST_COMPACTION_CONTEXT = `[CONTEXT_RECOVERY] The conversation history has been compressed. Key context is preserved in the compressed_history section of the system prompt. Continue working toward the goal. Use memory_search if you need to recall prior decisions or context.`;
