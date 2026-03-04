import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AgentAdapter } from "../agents/adapter.js";
import type { LLMClient } from "../llm/client.js";
import type { LLMMessage, LLMStreamEvent, MessageContent, ToolCallContent, ToolDefinition } from "../llm/types.js";
import { buildCategoryPathFilter } from "../memory/category.js";
import { searchMemory } from "../memory/search.js";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingProvider, HybridSearchConfig, MemoryCategory } from "../memory/types.js";
import type { ChatBroadcaster } from "../server/chat-broadcaster.js";
import { MessageQueue } from "../server/message-queue.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { TmuxBridge } from "../tmux/bridge.js";
import type { StateDetector } from "../tmux/state-detector.js";
import { logger } from "../utils/logger.js";
import type { ContextManager } from "./context-manager.js";
import type { Signal, SignalRouter } from "./signal-router.js";

// ─── Types ──────────────────────────────────────────────

export type AgentState = "idle" | "executing";

export interface MainAgentEvents {
	state_change: [state: AgentState];
	log: [message: string];
}

// ─── Tool definitions ───────────────────────────────────

const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "send_to_agent",
		description:
			"Send an instruction prompt to the coding agent and wait for the agent to finish. Returns the agent's final status and pane content. This tool blocks until the agent completes, encounters an error, or times out.",
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "The instruction prompt to send to the coding agent" },
				summary: {
					type: "string",
					description:
						"A brief human-readable summary of the current action for the chat interface (e.g., 'Asking agent to add JWT auth to auth/login.ts')",
				},
			},
			required: ["prompt", "summary"],
		},
	},
	{
		name: "respond_to_agent",
		description:
			"Respond to an agent waiting for input and wait for the agent to finish. Formats: 'Enter', 'Escape', 'y', 'n', 'arrow:down:N', 'keys:K1,K2,...', or plain text. Returns the agent's final status and pane content after it settles.",
		parameters: {
			type: "object",
			properties: {
				value: { type: "string", description: "The response value to send" },
				summary: {
					type: "string",
					description:
						"A brief human-readable summary of this response for the chat interface (e.g., 'Confirming dependency installation')",
				},
			},
			required: ["value", "summary"],
		},
	},
	{
		name: "fetch_more",
		description:
			"Fetch more lines from the tmux pane to see additional output history. Only use this AFTER the agent has finished working (i.e., after send_to_agent or respond_to_agent has returned), when the returned content is clearly truncated or missing earlier context. Do NOT use this to poll for agent progress.",
		parameters: {
			type: "object",
			properties: {
				lines: { type: "number", description: "Number of lines to capture (e.g. 200, 300, 500)" },
			},
			required: ["lines"],
		},
	},
	{
		name: "mark_complete",
		description:
			"Mark the current task as successfully completed and return to idle state. Call this when you have finished executing the user's request.",
		parameters: {
			type: "object",
			properties: {
				summary: { type: "string", description: "Brief summary of what was accomplished" },
			},
			required: ["summary"],
		},
	},
	{
		name: "mark_failed",
		description:
			"Mark the current task as failed and return to idle state. Use when the task cannot be accomplished.",
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string", description: "Why the task failed" },
			},
			required: ["reason"],
		},
	},
	{
		name: "escalate_to_human",
		description:
			"Escalate the current situation to the human operator and return to idle state. Use when proceeding autonomously would be riskier than pausing: destructive/irreversible operations, ambiguous user intent, major architectural trade-offs, scope expansion beyond the original request, security-sensitive changes, or production/shared resource modifications.",
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string", description: "Why human intervention is needed" },
			},
			required: ["reason"],
		},
	},
	{
		name: "memory_search",
		description:
			"Search project memory for relevant information. Use this before answering questions about prior work, decisions, dates, people, preferences, or todos.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query text (natural language)" },
				maxResults: { type: "number", description: "Maximum results to return (default 10)" },
				minScore: { type: "number", description: "Minimum relevance score 0-1 (default 0.1)" },
				category: {
					type: "string",
					description:
						'Optional category filter: "core", "preferences", "people", "todos", "daily", "legacy", "topic"',
				},
			},
			required: ["query"],
		},
	},
	{
		name: "memory_get",
		description:
			"Read a specific memory file. Optionally specify a line range. Use after memory_search to read full context around a search hit.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: 'Relative path (e.g. "memory/core.md")' },
				from: { type: "number", description: "1-indexed start line (optional)" },
				lines: { type: "number", description: "Number of lines to read (optional)" },
			},
			required: ["path"],
		},
	},
	{
		name: "memory_write",
		description:
			"Write content to a memory file. Only memory/*.md files are allowed. Creates the file if it does not exist, appends if it does.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: 'Relative path (e.g. "memory/core.md")' },
				content: { type: "string", description: "Content to write or append" },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "read_skill",
		description:
			"Read the full instructions of a skill by name. Use this when you need detailed guidance on how to use a specific skill (e.g., command usage, workflow, tips).",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: 'The skill name (e.g. "commit")' },
			},
			required: ["name"],
		},
	},
	{
		name: "create_session",
		description:
			'Create a tmux session with the "clipilot-" prefix and launch the coding agent in it. Must be called before send_to_agent/respond_to_agent/fetch_more. On naming conflict, returns an error so you can retry with a different name.',
		parameters: {
			type: "object",
			properties: {
				session_name: {
					type: "string",
					description:
						'Session name (will be prefixed with "clipilot-" if not already). If omitted, auto-generated.',
				},
				working_dir: {
					type: "string",
					description: "Working directory for the agent. Defaults to process.cwd() if omitted.",
				},
			},
		},
	},
	{
		name: "list_clipilot_sessions",
		description:
			"List all tmux sessions with the clipilot- prefix. Useful for checking existing sessions before creating a new one.",
		parameters: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "exit_agent",
		description:
			"Exit the current coding agent process. Returns the captured tmux output and a session id (if available) that can be used to resume the agent later with --resume. Use this when you need to terminate the agent cleanly.",
		parameters: {
			type: "object",
			properties: {
				summary: {
					type: "string",
					description:
						"A brief human-readable summary of why the agent is being exited (e.g., 'Exiting agent to save session for later')",
				},
			},
			required: ["summary"],
		},
	},
	{
		name: "exec_command",
		description:
			"Execute a bash command directly for read-only reconnaissance. Use for reading files, browsing directories, searching code, and checking environment info. NEVER use for modifications, tests, builds, git operations, or any command with side effects — those MUST go through send_to_agent.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The bash command to execute (read-only operations only)" },
				summary: {
					type: "string",
					description:
						"Very brief summary of the action for chat UI, max 20 chars (e.g., '查看目录结构', '搜索配置文件', 'Check deps')",
				},
				cwd: {
					type: "string",
					description:
						"Working directory for execution. Defaults to session working directory if a session exists, otherwise process.cwd().",
				},
				timeout: {
					type: "number",
					description: "Timeout in milliseconds (default: 30000)",
				},
			},
			required: ["command", "summary"],
		},
	},
];

// ─── MainAgent ──────────────────────────────────────────

export class MainAgent extends EventEmitter<MainAgentEvents> {
	private contextManager: ContextManager;
	private signalRouter: SignalRouter;
	private llmClient: LLMClient;
	private adapter: AgentAdapter;
	private bridge: TmuxBridge;
	private stateDetector: StateDetector;
	private broadcaster: ChatBroadcaster;
	private messageQueue = new MessageQueue();
	private pendingUserMessages: string[] = [];
	private isDrainingUserMessages = false;
	private paneTarget: string | null = null;
	private sessionWorkingDir: string = process.cwd();
	private memoryStore: MemoryStore | null = null;
	private embeddingProvider: EmbeddingProvider | null = null;
	private skillRegistry: SkillRegistry | null = null;
	private debug: boolean;
	private firstLLMCall = true;
	private execCommandBroadcastCount = 0;
	private searchConfig: HybridSearchConfig = {
		enabled: true,
		vectorWeight: 0.7,
		textWeight: 0.3,
		candidateMultiplier: 3,
		temporalDecay: { enabled: true, halfLifeDays: 30 },
	};

	// ─── State Machine ─────────────────────────────────
	state: AgentState = "idle";

	constructor(opts: {
		contextManager: ContextManager;
		signalRouter: SignalRouter;
		llmClient: LLMClient;
		adapter: AgentAdapter;
		bridge: TmuxBridge;
		stateDetector: StateDetector;
		broadcaster: ChatBroadcaster;
		memoryStore?: MemoryStore;
		embeddingProvider?: EmbeddingProvider | null;
		searchConfig?: Partial<HybridSearchConfig>;
		skillRegistry?: SkillRegistry;
		debug?: boolean;
	}) {
		super();
		this.contextManager = opts.contextManager;
		this.signalRouter = opts.signalRouter;
		this.llmClient = opts.llmClient;
		this.adapter = opts.adapter;
		this.bridge = opts.bridge;
		this.stateDetector = opts.stateDetector;
		this.broadcaster = opts.broadcaster;
		this.memoryStore = opts.memoryStore ?? null;
		this.embeddingProvider = opts.embeddingProvider ?? null;
		this.skillRegistry = opts.skillRegistry ?? null;
		this.debug = opts.debug ?? false;
		if (opts.searchConfig) {
			this.searchConfig = { ...this.searchConfig, ...opts.searchConfig };
		}
	}

	setPaneTarget(paneTarget: string): void {
		this.paneTarget = paneTarget;
	}

	getPaneTarget(): string | null {
		return this.paneTarget;
	}

	getSessionWorkingDir(): string {
		return this.sessionWorkingDir;
	}

	// ─── State Management ──────────────────────────────

	private setState(newState: AgentState): void {
		if (this.state !== newState) {
			this.state = newState;
			this.broadcaster.broadcast({ type: "state", state: newState });
			this.emit("state_change", newState);
			logger.info("main-agent", `State: ${newState}`);
		}
	}

	// ─── handleMessage — main entry point ──────────────

	async handleMessage(content: string): Promise<void> {
		if (this.state === "executing") {
			this.enqueueMessageForExecutingState(content);
			return;
		}

		this.pendingUserMessages.push(content);

		if (this.isDrainingUserMessages) {
			this.broadcaster.broadcast({
				type: "system",
				message: "消息已排队，将在当前操作完成后处理",
			});
			return;
		}

		await this.drainPendingUserMessages();
	}

	// ─── Streaming LLM Call ────────────────────────────

	private async streamLLMResponse(): Promise<{
		toolCalls: ToolCallContent[];
		textContent: string;
	}> {
		// Flush-before-compress ordering
		if (this.contextManager.shouldRunMemoryFlush()) {
			await this.contextManager.runMemoryFlush();
		}
		if (this.contextManager.shouldCompress()) {
			await this.contextManager.compress();
		}

		const { system, messages } = this.contextManager.prepareForLLM();

		// Log full prompt on first LLM call
		if (this.firstLLMCall) {
			this.firstLLMCall = false;
			logger.info("main-agent:prompt", "═══ First LLM Call — Full Prompt ═══");
			logger.info("main-agent:prompt", `[System Prompt]\n${system}`);
			for (const msg of messages) {
				const contentStr =
					typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content, null, 2);
				logger.info(
					"main-agent:prompt",
					`[Message role=${msg.role}${msg.toolCallId ? ` toolCallId=${msg.toolCallId}` : ""}]\n${contentStr}`,
				);
			}
			logger.info("main-agent:prompt", "═══ End of First LLM Call Prompt ═══");
		}

		let textContent = "";
		const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();

		const stream = this.llmClient.stream(messages, {
			systemPrompt: system,
			tools: TOOL_DEFINITIONS,
			temperature: 0.2,
		});

		let finalResponse: any = null;

		for await (const event of stream) {
			switch (event.type) {
				case "text_delta":
					textContent += event.delta;
					this.broadcaster.broadcast({ type: "assistant_delta", delta: event.delta });
					break;

				case "tool_call_delta": {
					let acc = toolCallAccumulator.get(event.index);
					if (!acc) {
						acc = { id: event.id ?? "", name: event.name ?? "", args: "" };
						toolCallAccumulator.set(event.index, acc);
					}
					if (event.id) acc.id = event.id;
					if (event.name) acc.name = event.name;
					acc.args += event.argumentsDelta;
					break;
				}

				case "thinking_delta":
					// Ignore thinking deltas in chat mode
					break;

				case "done":
					finalResponse = event.response;
					break;
			}
		}

		// Report usage
		if (finalResponse?.usage) {
			this.contextManager.reportUsage({
				inputTokens: finalResponse.usage.inputTokens ?? 0,
				outputTokens: finalResponse.usage.outputTokens ?? 0,
			});
		}

		// Build tool calls from accumulator
		const toolCalls: ToolCallContent[] = [];
		for (const [, acc] of toolCallAccumulator) {
			let parsedArgs: Record<string, any> = {};
			try {
				parsedArgs = JSON.parse(acc.args);
			} catch {
				logger.warn("main-agent", `Failed to parse tool call args: ${acc.args}`);
			}
			toolCalls.push({
				type: "tool_call",
				id: acc.id,
				name: acc.name,
				arguments: parsedArgs,
			});
		}

		// Debug logging
		if (this.debug && finalResponse) {
			if (textContent) logger.info("main-agent:debug", `[LLM text] ${textContent}`);
			for (const tc of toolCalls) {
				logger.info("main-agent:debug", `[LLM tool_call] ${tc.name}(${JSON.stringify(tc.arguments)})`);
			}
			if (finalResponse.usage) {
				logger.info(
					"main-agent:debug",
					`[LLM usage] input=${finalResponse.usage.inputTokens} output=${finalResponse.usage.outputTokens}`,
				);
			}
		}

		return { toolCalls, textContent };
	}

	// ─── Tool Execution Loop (EXECUTING state) ─────────

	private async executeToolLoop(initialToolCalls: ToolCallContent[]): Promise<void> {
		this.execCommandBroadcastCount = 0;
		let toolCalls = initialToolCalls;

		while (true) {
			// Execute all tool calls
			for (const toolCall of toolCalls) {
				const result = await this.executeTool(toolCall);

				// Add tool result to conversation
				this.contextManager.addMessage({
					role: "tool",
					content: result.output,
					toolCallId: toolCall.id,
				});

				// Terminal tool → back to IDLE
				if (result.terminal) {
					this.setState("idle");
					return;
				}
			}

			// ─── Between-round checks ──────────────────

			// 1. Check stopRequested
			if (this.signalRouter.isStopRequested()) {
				this.signalRouter.resume(); // Clear the flag
				this.setState("idle");
				this.broadcaster.broadcast({
					type: "system",
					message: "执行已停止",
				});
				return;
			}

			// 2. Drain MessageQueue
			if (!this.messageQueue.isEmpty()) {
				const queued = this.messageQueue.drain();
				for (const msg of queued) {
					this.contextManager.addMessage({
						role: "user",
						content: `[HUMAN] ${msg}`,
					});
				}
			}

			// 3. Check context thresholds
			if (this.contextManager.shouldRunMemoryFlush()) {
				await this.contextManager.runMemoryFlush();
			}
			if (this.contextManager.shouldCompress()) {
				await this.contextManager.compress();
			}

			// 4. Next LLM call
			const { toolCalls: nextToolCalls, textContent } = await this.streamLLMResponse();

			if (nextToolCalls.length === 0) {
				// No more tool calls — add text response and back to IDLE
				if (textContent) {
					this.contextManager.addMessage({ role: "assistant", content: textContent });
				}
				this.broadcaster.broadcast({ type: "assistant_done" });
				this.setState("idle");
				return;
			}

			// Has tool calls — add assistant message and continue loop
			const assistantBlocks = this.buildAssistantBlocks(textContent, nextToolCalls);
			this.contextManager.addMessage({ role: "assistant", content: assistantBlocks });
			this.broadcaster.broadcast({ type: "assistant_done" });

			toolCalls = nextToolCalls;
		}
	}

	// ─── Resume (after /stop) ──────────────────────────

	async handleResume(): Promise<void> {
		if (this.state === "executing") return;

		try {
			this.contextManager.addMessage({
				role: "user",
				content: "[RESUME] 继续执行之前的任务",
			});

			this.setState("executing");

			const { toolCalls, textContent } = await this.streamLLMResponse();

			if (toolCalls.length > 0) {
				const assistantBlocks = this.buildAssistantBlocks(textContent, toolCalls);
				this.contextManager.addMessage({ role: "assistant", content: assistantBlocks });
				this.broadcaster.broadcast({ type: "assistant_done" });
				await this.executeToolLoop(toolCalls);
			} else {
				if (textContent) {
					this.contextManager.addMessage({ role: "assistant", content: textContent });
				}
				this.broadcaster.broadcast({ type: "assistant_done" });
				this.setState("idle");
			}
		} catch (err: any) {
			this.recoverFromExecutionError("handleResume", err);
			throw err;
		}
	}

	private async drainPendingUserMessages(): Promise<void> {
		if (this.isDrainingUserMessages) return;

		this.isDrainingUserMessages = true;
		try {
			while (this.pendingUserMessages.length > 0) {
				if (this.state === "executing") {
					this.flushPendingMessagesToExecutionQueue();
					return;
				}

				const nextContent = this.pendingUserMessages.shift();
				if (!nextContent) continue;

				await this.processUserMessage(nextContent);
			}
		} finally {
			this.isDrainingUserMessages = false;
		}
	}

	private async processUserMessage(content: string): Promise<void> {
		try {
			// IDLE state — process immediately
			this.contextManager.addMessage({ role: "user", content });

			// Stream LLM response
			const { toolCalls, textContent } = await this.streamLLMResponse();

			if (toolCalls.length > 0) {
				// LLM wants to use tools — enter EXECUTING state
				this.setState("executing");
				this.flushPendingMessagesToExecutionQueue();

				// Add assistant message to conversation
				const assistantBlocks = this.buildAssistantBlocks(textContent, toolCalls);
				this.contextManager.addMessage({ role: "assistant", content: assistantBlocks });
				this.broadcaster.broadcast({ type: "assistant_done" });

				// Execute tools and enter self-loop
				await this.executeToolLoop(toolCalls);
			} else {
				// Pure text response — stay IDLE
				this.contextManager.addMessage({ role: "assistant", content: textContent });
				this.broadcaster.broadcast({ type: "assistant_done" });
			}
		} catch (err: any) {
			this.recoverFromExecutionError("handleMessage", err);
			throw err;
		}
	}

	private enqueueMessageForExecutingState(content: string): void {
		this.messageQueue.enqueue(content);
		this.broadcaster.broadcast({
			type: "system",
			message: "消息已排队，将在当前操作完成后处理",
		});
	}

	private flushPendingMessagesToExecutionQueue(): void {
		if (this.pendingUserMessages.length === 0) return;

		const pending = this.pendingUserMessages.splice(0);
		for (const message of pending) {
			this.messageQueue.enqueue(message);
		}
	}

	private recoverFromExecutionError(source: string, err: Error): void {
		if (this.state === "executing") {
			this.setState("idle");
		}
		logger.error("main-agent", `${source} error: ${err.message}`);
	}

	private resolveMemoryGetTarget(rawPath: string): { storageDir: string; relativePath: string } {
		if (!this.memoryStore) {
			throw new Error("Memory store not available.");
		}

		const normalizedPath = rawPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
		if (normalizedPath.startsWith("memory/")) {
			return {
				storageDir: this.memoryStore.getStorageDir(),
				relativePath: normalizedPath,
			};
		}

		const slashIdx = normalizedPath.indexOf("/");
		if (slashIdx <= 0) {
			return {
				storageDir: this.memoryStore.getStorageDir(),
				relativePath: normalizedPath,
			};
		}

		const projectId = normalizedPath.slice(0, slashIdx);
		const relativePath = normalizedPath.slice(slashIdx + 1);
		if (!relativePath.startsWith("memory/")) {
			return {
				storageDir: this.memoryStore.getStorageDir(),
				relativePath,
			};
		}

		return {
			storageDir: join(dirname(this.memoryStore.getStorageDir()), projectId),
			relativePath,
		};
	}

	// ─── Helper: build assistant content blocks ────────

	private buildAssistantBlocks(text: string, toolCalls: ToolCallContent[]): MessageContent[] {
		const blocks: MessageContent[] = [];
		if (text) {
			blocks.push({ type: "text", text });
		}
		for (const tc of toolCalls) {
			blocks.push(tc);
		}
		return blocks;
	}

	// ─── Tool Execution ────────────────────────────────

	private async executeTool(toolCall: ToolCallContent): Promise<{
		output: string;
		terminal: boolean;
	}> {
		const { name, arguments: args } = toolCall;
		logger.info("main-agent", `Executing tool: ${name}(${JSON.stringify(args)})`);

		switch (name) {
			case "send_to_agent": {
				if (!this.paneTarget) {
					return { output: "Error: No active session. Call create_session first.", terminal: false };
				}
				const prompt = args.prompt as string;
				const summary = args.summary as string;

				// Broadcast agent update with summary
				this.broadcaster.broadcast({ type: "agent_update", summary });

				const sendPreHash = await this.stateDetector.captureHash(this.paneTarget);
				await this.adapter.sendPrompt(this.bridge, this.paneTarget, prompt);
				this.signalRouter.notifyPromptSent(prompt);
				const sendResult = await this.stateDetector.waitForSettled(this.paneTarget, "", {
					preHash: sendPreHash,
					isAborted: () => this.signalRouter.isStopRequested(),
				});
				const sendStatus = sendResult.timedOut ? "timeout" : sendResult.analysis.status;
				return {
					output: `[Agent ${sendStatus}] (${sendResult.analysis.detail})\n${sendResult.content}`,
					terminal: false,
				};
			}

			case "respond_to_agent": {
				if (!this.paneTarget) {
					return { output: "Error: No active session. Call create_session first.", terminal: false };
				}
				const value = args.value as string;
				const summary = args.summary as string;

				// Broadcast agent update with summary
				this.broadcaster.broadcast({ type: "agent_update", summary });

				const respondPreHash = await this.stateDetector.captureHash(this.paneTarget);
				await this.adapter.sendResponse(this.bridge, this.paneTarget, value);
				const respondResult = await this.stateDetector.waitForSettled(this.paneTarget, "", {
					preHash: respondPreHash,
					isAborted: () => this.signalRouter.isStopRequested(),
				});
				const respondStatus = respondResult.timedOut ? "timeout" : respondResult.analysis.status;
				return {
					output: `[Agent ${respondStatus}] (${respondResult.analysis.detail})\n${respondResult.content}`,
					terminal: false,
				};
			}

			case "fetch_more": {
				if (!this.paneTarget) {
					return { output: "Error: No active session. Call create_session first.", terminal: false };
				}
				const lines = args.lines as number;
				const capture = await this.bridge.capturePane(this.paneTarget, { startLine: -lines });
				return { output: capture.content, terminal: false };
			}

			case "mark_complete": {
				const summary = args.summary as string;
				this.emit("log", `Task completed: ${summary}`);
				this.broadcaster.broadcast({ type: "system", message: `任务完成: ${summary}` });
				return { output: `Task marked as complete: ${summary}`, terminal: true };
			}

			case "mark_failed": {
				const reason = args.reason as string;
				this.emit("log", `Task failed: ${reason}`);
				this.broadcaster.broadcast({ type: "system", message: `任务失败: ${reason}` });
				return { output: `Task marked as failed: ${reason}`, terminal: true };
			}

			case "escalate_to_human": {
				const reason = args.reason as string;
				this.emit("log", `Escalated to human: ${reason}`);
				this.broadcaster.broadcast({ type: "system", message: `需要人工介入: ${reason}` });
				return { output: `Escalated to human: ${reason}`, terminal: true };
			}

			case "memory_search": {
				if (!this.memoryStore) {
					return { output: "Memory store not available.", terminal: false };
				}
				const query = args.query as string;
				const maxResults = args.maxResults as number | undefined;
				const minScore = args.minScore as number | undefined;
				const category = args.category as MemoryCategory | undefined;

				try {
					let categoryPathFilter: string[] | undefined;
					if (category) {
						const trackedPaths = this.memoryStore.getTrackedFilePaths();
						categoryPathFilter = buildCategoryPathFilter(category, trackedPaths);
					}

					const results = await searchMemory(this.memoryStore, query, this.embeddingProvider, this.searchConfig, {
						maxResults,
						minScore,
						categoryPathFilter,
					});

					if (results.length === 0) {
						return { output: "No memory results found for this query.", terminal: false };
					}

					const formatted = results
						.map(
							(r, i) =>
								`[${i + 1}] ${r.path}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n${r.snippet.slice(0, 300)}`,
						)
						.join("\n\n");

					return { output: formatted, terminal: false };
				} catch (err: any) {
					logger.warn("main-agent", `memory_search failed: ${err.message}`);
					return { output: `Memory search error: ${err.message}`, terminal: false };
				}
			}

			case "memory_get": {
				if (!this.memoryStore) {
					return { output: "Memory store not available.", terminal: false };
				}
				const rawPath = args.path as string;
				const from = args.from as number | undefined;
				const lineCount = args.lines as number | undefined;
				const { storageDir, relativePath: memGetPath } = this.resolveMemoryGetTarget(rawPath);

				try {
					const absPath = join(storageDir, memGetPath);
					const content = await readFile(absPath, "utf-8");
					const lines = content.split("\n");

					if (from !== undefined) {
						const startIdx = Math.max(0, from - 1);
						const count = lineCount ?? lines.length - startIdx;
						const slice = lines.slice(startIdx, startIdx + count);
						return { output: slice.join("\n"), terminal: false };
					}

					return { output: content, terminal: false };
				} catch (err: any) {
					if (err.code === "ENOENT") {
						return { output: `File not found: ${rawPath}`, terminal: false };
					}
					return { output: `Error reading file: ${err.message}`, terminal: false };
				}
			}

			case "memory_write": {
				if (!this.memoryStore) {
					return { output: "Memory store not available.", terminal: false };
				}
				const path = args.path as string;
				const content = args.content as string;

				try {
					const result = await this.memoryStore.write({ path, content });
					return { output: `Written to ${result.path} successfully.`, terminal: false };
				} catch (err: any) {
					return { output: `Memory write error: ${err.message}`, terminal: false };
				}
			}

			case "read_skill": {
				if (!this.skillRegistry) {
					return { output: "Skill registry not available.", terminal: false };
				}
				const skillName = args.name as string;
				const skill = this.skillRegistry.getByName(skillName);
				if (!skill) {
					return { output: `Skill not found: ${skillName}`, terminal: false };
				}
				return { output: skill.body, terminal: false };
			}

			case "create_session": {
				let sessionName = args.session_name as string | undefined;
				if (!sessionName) {
					sessionName = generateSessionName("chat");
				} else if (!sessionName.startsWith("clipilot-")) {
					sessionName = `clipilot-${sessionName}`;
				}

				const workingDir = (args.working_dir as string | undefined) ?? process.cwd();

				try {
					const dirStat = await stat(workingDir);
					if (!dirStat.isDirectory()) {
						return { output: `Error: "${workingDir}" is not a directory.`, terminal: false };
					}
				} catch {
					return { output: `Error: Directory "${workingDir}" does not exist.`, terminal: false };
				}

				const exists = await this.bridge.hasSession(sessionName);
				if (exists) {
					return {
						output: `Error: Session "${sessionName}" already exists. Choose a different name or use list_clipilot_sessions to see existing sessions.`,
						terminal: false,
					};
				}

				try {
					this.paneTarget = await this.adapter.launch(this.bridge, {
						workingDir,
						sessionName,
					});
					this.sessionWorkingDir = workingDir;
					this.stateDetector.setCharacteristics(this.adapter.getCharacteristics());
					logger.info(
						"main-agent",
						`Session created: ${sessionName}, pane: ${this.paneTarget}, cwd: ${workingDir}`,
					);
					return {
						output: `Session "${sessionName}" created in ${workingDir}. Agent launched in ${this.paneTarget}. You can now use send_to_agent.`,
						terminal: false,
					};
				} catch (err: any) {
					return { output: `Failed to create session: ${err.message}`, terminal: false };
				}
			}

			case "list_clipilot_sessions": {
				try {
					const sessions = await this.bridge.listClipilotSessions();
					if (sessions.length === 0) {
						return { output: "No clipilot sessions found.", terminal: false };
					}
					const formatted = sessions
						.map((s) => `- ${s.name} (windows: ${s.windows}, attached: ${s.attached})`)
						.join("\n");
					return { output: `Found ${sessions.length} clipilot session(s):\n${formatted}`, terminal: false };
				} catch (err: any) {
					return { output: `Error listing sessions: ${err.message}`, terminal: false };
				}
			}

			case "exit_agent": {
				if (!this.paneTarget) {
					return { output: "Error: No active session.", terminal: false };
				}
				const exitSummary = args.summary as string;
				this.broadcaster.broadcast({ type: "agent_update", summary: exitSummary });

				if (!this.adapter.exitAgent) {
					return { output: "Error: Current adapter does not support exitAgent.", terminal: false };
				}

				const exitResult = await this.adapter.exitAgent(this.bridge, this.paneTarget);
				const parts = [`[Agent exited]\n${exitResult.content}`];
				if (exitResult.sessionId) {
					parts.push(`\nSession ID: ${exitResult.sessionId}`);
					parts.push(`Working directory: ${this.sessionWorkingDir}`);
				}
				return { output: parts.join("\n"), terminal: false };
			}

			case "exec_command": {
				const command = args.command as string;
				const execSummary = args.summary as string;
				const cwd = (args.cwd as string | undefined) ?? this.sessionWorkingDir;
				const timeout = (args.timeout as number | undefined) ?? 30000;
				const MAX_OUTPUT = 10000;

				// Throttled broadcast: emit tool_activity on 1st, 4th, 7th, ... call
				this.execCommandBroadcastCount++;
				if (this.execCommandBroadcastCount % 3 === 1) {
					this.broadcaster.broadcast({ type: "tool_activity", summary: execSummary });
				}

				try {
					const execFileAsync = promisify(execFile);
					const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
						cwd,
						timeout,
						maxBuffer: 1024 * 1024,
					});
					let output = stdout + (stderr ? `\n${stderr}` : "");
					if (output.length > MAX_OUTPUT) {
						const totalLen = output.length;
						output = `${output.slice(0, MAX_OUTPUT)}\n\n[Output truncated: ${totalLen} chars total, showing first ${MAX_OUTPUT}]`;
					}
					return { output: output || "(no output)", terminal: false };
				} catch (err: any) {
					if (err.killed || err.signal === "SIGTERM") {
						return {
							output: `[exec_command timeout after ${timeout}ms]\nCommand: ${command}`,
							terminal: false,
						};
					}
					if (err.code !== undefined && typeof err.code === "number") {
						let output = `[exit code: ${err.code}]\n${err.stderr || ""}${err.stdout || ""}`.trim();
						if (output.length > MAX_OUTPUT) {
							const totalLen = output.length;
							output = `${output.slice(0, MAX_OUTPUT)}\n\n[Output truncated: ${totalLen} chars total, showing first ${MAX_OUTPUT}]`;
						}
						return { output, terminal: false };
					}
					return { output: `exec_command error: ${err.message}`, terminal: false };
				}
			}

			default: {
				if (this.skillRegistry) {
					const skillForTool = this.skillRegistry.getByToolName(name);
					if (skillForTool) {
						return { output: skillForTool.body, terminal: false };
					}
				}
				return { output: `Unknown tool: ${name}`, terminal: false };
			}
		}
	}

	private formatSignal(signal: Signal): string {
		const parts: string[] = [`[${signal.type}]`];

		if (signal.analysis) {
			parts.push(`Status: ${signal.analysis.status} (confidence: ${signal.analysis.confidence})`);
			parts.push(`Detail: ${signal.analysis.detail}`);
		}

		if (signal.message) {
			parts.push(`Message: ${signal.message}`);
		}

		parts.push(`--- Pane Content ---\n${signal.paneContent}`);

		return parts.join("\n");
	}
}

function generateSessionName(prefix: string): string {
	const slug = prefix
		.replace(/[^\w\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 30)
		.replace(/-$/, "");
	return `clipilot-${slug || "session"}`;
}
