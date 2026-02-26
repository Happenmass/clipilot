import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter } from "../agents/adapter.js";
import type { LLMClient } from "../llm/client.js";
import type { ToolCallContent, ToolDefinition } from "../llm/types.js";
import { buildCategoryPathFilter, categoryFromPath } from "../memory/category.js";
import { searchMemory } from "../memory/search.js";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingProvider, HybridSearchConfig, MemoryCategory } from "../memory/types.js";
import type { TmuxBridge } from "../tmux/bridge.js";
import type { StateDetector } from "../tmux/state-detector.js";
import { logger } from "../utils/logger.js";
import type { ContextManager } from "./context-manager.js";
import type { Planner } from "./planner.js";
import type { Signal, SignalRouter } from "./signal-router.js";
import type { Task, TaskGraph, TaskResult } from "./task.js";

export interface MainAgentEvents {
	task_start: [task: Task];
	task_complete: [task: Task, result: TaskResult];
	task_failed: [task: Task, error: string];
	need_human: [task: Task, reason: string];
	log: [message: string];
}

const TERMINAL_TOOLS = new Set(["mark_complete", "mark_failed", "request_replan", "escalate_to_human"]);

const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "send_to_agent",
		description: "Send an instruction prompt to the coding agent. Use this to start a task or give additional instructions.",
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "The instruction prompt to send to the coding agent" },
			},
			required: ["prompt"],
		},
	},
	{
		name: "respond_to_agent",
		description:
			"Respond to an agent waiting for input (y/n prompts, menu selections, text input). Formats: 'Enter', 'Escape', 'y', 'n', 'arrow:down:N', 'keys:K1,K2,...', or plain text.",
		parameters: {
			type: "object",
			properties: {
				value: { type: "string", description: "The response value to send" },
			},
			required: ["value"],
		},
	},
	{
		name: "fetch_more",
		description: "Fetch more lines from the tmux pane to see the full output. Use when the current pane content seems truncated.",
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
		description: "Mark the current task as successfully completed.",
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
		description: "Mark the current task as failed.",
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string", description: "Why the task failed" },
			},
			required: ["reason"],
		},
	},
	{
		name: "request_replan",
		description: "Request the planner to create a new plan for remaining tasks. Use when the current approach is fundamentally blocked.",
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string", description: "Why replanning is needed" },
			},
			required: ["reason"],
		},
	},
	{
		name: "escalate_to_human",
		description: "Escalate the current situation to a human operator. Use for dangerous operations or when you are uncertain.",
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
];

export class MainAgent extends EventEmitter<MainAgentEvents> {
	private contextManager: ContextManager;
	private signalRouter: SignalRouter;
	private llmClient: LLMClient;
	private planner: Planner;
	private adapter: AgentAdapter;
	private bridge: TmuxBridge;
	private stateDetector: StateDetector;
	private taskGraph: TaskGraph;
	private goal: string;
	private paneTarget: string | null = null;
	private memoryStore: MemoryStore | null = null;
	private embeddingProvider: EmbeddingProvider | null = null;
	private searchConfig: HybridSearchConfig = {
		enabled: true,
		vectorWeight: 0.7,
		textWeight: 0.3,
		candidateMultiplier: 3,
		temporalDecay: { enabled: true, halfLifeDays: 30 },
	};

	constructor(opts: {
		contextManager: ContextManager;
		signalRouter: SignalRouter;
		llmClient: LLMClient;
		planner: Planner;
		adapter: AgentAdapter;
		bridge: TmuxBridge;
		stateDetector: StateDetector;
		taskGraph: TaskGraph;
		goal: string;
		memoryStore?: MemoryStore;
		embeddingProvider?: EmbeddingProvider | null;
		searchConfig?: Partial<HybridSearchConfig>;
	}) {
		super();
		this.contextManager = opts.contextManager;
		this.signalRouter = opts.signalRouter;
		this.llmClient = opts.llmClient;
		this.planner = opts.planner;
		this.adapter = opts.adapter;
		this.bridge = opts.bridge;
		this.stateDetector = opts.stateDetector;
		this.taskGraph = opts.taskGraph;
		this.goal = opts.goal;
		this.memoryStore = opts.memoryStore ?? null;
		this.embeddingProvider = opts.embeddingProvider ?? null;
		if (opts.searchConfig) {
			this.searchConfig = { ...this.searchConfig, ...opts.searchConfig };
		}
	}

	setPaneTarget(paneTarget: string): void {
		this.paneTarget = paneTarget;
	}

	setTaskGraph(taskGraph: TaskGraph): void {
		this.taskGraph = taskGraph;
		this.signalRouter.setTaskGraph(taskGraph);
		this.contextManager.updateModule("task_graph_summary", this.formatTaskGraph());
	}

	async executeTask(task: Task): Promise<TaskResult> {
		if (!this.paneTarget) {
			return { success: false, summary: "Agent pane not available" };
		}

		this.emit("task_start", task);
		this.emit("log", `Starting task: ${task.title}`);

		// Notify router that a new task is starting
		this.signalRouter.notifyNewTask();

		// Update task graph in system prompt
		this.contextManager.updateModule("task_graph_summary", this.formatTaskGraph());

		// Inject TASK_READY signal
		const taskReadyMessage = `[TASK_READY] Task #${task.id}: ${task.title}\nDescription: ${task.description}\nComplexity: ${task.estimatedComplexity}\nAttempt: ${task.attempts + 1}/${task.maxAttempts}`;
		this.contextManager.addMessage({ role: "user", content: taskReadyMessage });

		// Run LLM to generate and send initial prompt
		const initResult = await this.runToolUseLoop();
		if (initResult) {
			if (initResult.success) {
				this.emit("task_complete", task, initResult);
			} else {
				this.emit("task_failed", task, initResult.summary);
			}
			return initResult;
		}

		// Start monitoring and wait for signals
		return new Promise<TaskResult>((resolve) => {
			let resolved = false;

			const handleSignal = async (signal: Signal) => {
				if (resolved) return;

				if (signal.type === "NOTIFY" && signal.analysis?.status === "completed") {
					// Fast-path auto-completion
					resolved = true;
					this.signalRouter.stopMonitoring();
					const result: TaskResult = { success: true, summary: signal.analysis.detail };
					this.emit("task_complete", task, result);
					resolve(result);
					return;
				}

				if (signal.type === "DECISION_NEEDED") {
					// Inject signal into conversation
					const content = this.formatSignal(signal);
					this.contextManager.addMessage({ role: "user", content });

					// Run tool use loop
					const result = await this.runToolUseLoop();
					if (result && !resolved) {
						resolved = true;
						this.signalRouter.stopMonitoring();
						if (result.success) {
							this.emit("task_complete", task, result);
						} else {
							this.emit("task_failed", task, result.summary);
						}
						resolve(result);
					}
				}
			};

			this.signalRouter.onSignal(handleSignal);
			this.signalRouter.startMonitoring(this.paneTarget!, `${task.title}: ${task.description}`);

			// Timeout after 10 minutes
			setTimeout(() => {
				if (!resolved) {
					resolved = true;
					this.signalRouter.stopMonitoring();
					const result: TaskResult = { success: false, summary: "Task timed out after 10 minutes", errors: ["timeout"] };
					this.emit("task_failed", task, result.summary);
					resolve(result);
				}
			}, 10 * 60 * 1000);
		});
	}

	private async runToolUseLoop(): Promise<TaskResult | null> {
		// Flush-before-compress ordering (Layer 2 → Layer 3)
		if (this.contextManager.shouldRunMemoryFlush()) {
			await this.contextManager.runMemoryFlush();
		}
		if (this.contextManager.shouldCompress()) {
			await this.contextManager.compress();
		}

		const maxIterations = 15; // Increased to accommodate memory tool calls
		for (let i = 0; i < maxIterations; i++) {
			// Use prepareForLLM() for Layer 1 context guard
			const { system, messages } = this.contextManager.prepareForLLM();

			const response = await this.llmClient.complete(
				messages,
				{
					systemPrompt: system,
					tools: TOOL_DEFINITIONS,
					temperature: 0.2,
				},
			);

			// Report actual token usage for hybrid counting
			if (response.usage) {
				this.contextManager.reportUsage({
					inputTokens: response.usage.inputTokens ?? 0,
					outputTokens: response.usage.outputTokens ?? 0,
				});
			}

			// Add assistant response to conversation
			this.contextManager.addMessage({
				role: "assistant",
				content: response.contentBlocks,
			});

			// Extract tool calls
			const toolCalls = response.contentBlocks.filter(
				(b): b is ToolCallContent => b.type === "tool_call",
			);

			if (toolCalls.length === 0) {
				// No tool calls — thinking complete, wait for next signal
				return null;
			}

			for (const toolCall of toolCalls) {
				const result = await this.executeTool(toolCall);

				// Add tool result to conversation
				this.contextManager.addMessage({
					role: "tool",
					content: result.output,
					toolCallId: toolCall.id,
				});

				if (result.terminal) {
					return result.taskResult!;
				}
			}

			// Continue loop to let LLM see tool results
		}

		logger.warn("main-agent", "Tool use loop reached max iterations");
		return null;
	}

	private async executeTool(toolCall: ToolCallContent): Promise<{
		output: string;
		terminal: boolean;
		taskResult?: TaskResult;
	}> {
		const { name, arguments: args } = toolCall;
		logger.info("main-agent", `Executing tool: ${name}(${JSON.stringify(args)})`);

		switch (name) {
			case "send_to_agent": {
				const prompt = args.prompt as string;
				await this.adapter.sendPrompt(this.bridge, this.paneTarget!, prompt);
				this.stateDetector.setCooldown(3000);
				this.signalRouter.notifyPromptSent(prompt);
				return { output: "Prompt sent to agent.", terminal: false };
			}

			case "respond_to_agent": {
				const value = args.value as string;
				await this.adapter.sendResponse(this.bridge, this.paneTarget!, value);
				this.stateDetector.setCooldown(3000);
				return { output: `Response "${value}" sent to agent.`, terminal: false };
			}

			case "fetch_more": {
				const lines = args.lines as number;
				const capture = await this.bridge.capturePane(this.paneTarget!, { startLine: -lines });
				return { output: capture.content, terminal: false };
			}

			case "mark_complete": {
				const summary = args.summary as string;
				return {
					output: `Task marked as complete: ${summary}`,
					terminal: true,
					taskResult: { success: true, summary },
				};
			}

			case "mark_failed": {
				const reason = args.reason as string;
				return {
					output: `Task marked as failed: ${reason}`,
					terminal: true,
					taskResult: { success: false, summary: reason, errors: [reason] },
				};
			}

			case "request_replan": {
				const reason = args.reason as string;
				try {
					const currentTask = this.taskGraph.getAllTasks().find((t) => t.status === "running");
					const newGraph = await this.planner.replan(this.goal, this.taskGraph, currentTask!, reason);
					this.setTaskGraph(newGraph);
					this.emit("log", `Replanned: ${reason}`);
					return {
						output: `Replanning complete. New task graph created.`,
						terminal: true,
						taskResult: { success: false, summary: `Replanned: ${reason}` },
					};
				} catch (err: any) {
					return {
						output: `Replanning failed: ${err.message}`,
						terminal: true,
						taskResult: { success: false, summary: `Replan failed: ${err.message}`, errors: [err.message] },
					};
				}
			}

			case "escalate_to_human": {
				const reason = args.reason as string;
				const currentTask = this.taskGraph.getAllTasks().find((t) => t.status === "running");
				if (currentTask) {
					this.emit("need_human", currentTask, reason);
				}
				return {
					output: `Escalated to human: ${reason}`,
					terminal: true,
					taskResult: { success: false, summary: `Escalated: ${reason}` },
				};
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

					const results = await searchMemory(
						this.memoryStore,
						query,
						this.embeddingProvider,
						this.searchConfig,
						{ maxResults, minScore, categoryPathFilter },
					);

					if (results.length === 0) {
						return { output: "No memory results found for this query.", terminal: false };
					}

					const formatted = results.map((r, i) =>
						`[${i + 1}] ${r.path}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n${r.snippet.slice(0, 300)}`,
					).join("\n\n");

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
				const path = args.path as string;
				const from = args.from as number | undefined;
				const lineCount = args.lines as number | undefined;

				try {
					const absPath = join(this.memoryStore.getWorkspaceDir(), path);
					const content = await readFile(absPath, "utf-8");
					const lines = content.split("\n");

					if (from !== undefined) {
						const startIdx = Math.max(0, from - 1); // 1-indexed to 0-indexed
						const count = lineCount ?? lines.length - startIdx;
						const slice = lines.slice(startIdx, startIdx + count);
						return { output: slice.join("\n"), terminal: false };
					}

					return { output: content, terminal: false };
				} catch (err: any) {
					if (err.code === "ENOENT") {
						return { output: `File not found: ${path}`, terminal: false };
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
					return {
						output: `Written to ${result.path} successfully.`,
						terminal: false,
					};
				} catch (err: any) {
					return { output: `Memory write error: ${err.message}`, terminal: false };
				}
			}

			default:
				return {
					output: `Unknown tool: ${name}`,
					terminal: false,
				};
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

	private formatTaskGraph(): string {
		const tasks = this.taskGraph.getAllTasks();
		return tasks
			.map((t) => {
				const icon = t.status === "completed" ? "✓" : t.status === "running" ? "▶" : t.status === "failed" ? "✗" : " ";
				const suffix = t.status === "running" ? " ← current" : "";
				return `[${icon}] #${t.id} ${t.title}${suffix}`;
			})
			.join("\n");
	}
}
