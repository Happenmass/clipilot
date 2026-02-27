import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter } from "../agents/adapter.js";
import type { LLMClient } from "../llm/client.js";
import type { ToolCallContent, ToolDefinition } from "../llm/types.js";
import { buildCategoryPathFilter } from "../memory/category.js";
import { searchMemory } from "../memory/search.js";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingProvider, HybridSearchConfig, MemoryCategory } from "../memory/types.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { TmuxBridge } from "../tmux/bridge.js";
import type { StateDetector } from "../tmux/state-detector.js";
import { logger } from "../utils/logger.js";
import type { ContextManager } from "./context-manager.js";
import type { Signal, SignalRouter } from "./signal-router.js";

// ─── Types ──────────────────────────────────────────────

export interface GoalResult {
	success: boolean;
	summary: string;
	filesChanged?: string[];
	errors?: string[];
}

export interface MainAgentEvents {
	goal_start: [goal: string];
	goal_complete: [result: GoalResult];
	goal_failed: [error: string];
	need_human: [reason: string];
	log: [message: string];
}

// ─── Tool definitions ───────────────────────────────────

const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "send_to_agent",
		description:
			"Send an instruction prompt to the coding agent. Use this to start a task or give additional instructions.",
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
		description:
			"Fetch more lines from the tmux pane to see the full output. Use when the current pane content seems truncated.",
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
			"Mark the current goal as successfully completed. Only call this when the overall goal has been fully achieved.",
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
		description: "Mark the current goal as failed. Use when the goal cannot be accomplished.",
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string", description: "Why the goal failed" },
			},
			required: ["reason"],
		},
	},
	{
		name: "escalate_to_human",
		description:
			"Escalate the current situation to a human operator. Use for dangerous operations or when you are uncertain.",
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
				name: { type: "string", description: 'The skill name (e.g. "openspec", "commit")' },
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
						'Session name (will be prefixed with "clipilot-" if not already). If omitted, auto-generated from the goal.',
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
];

// ─── MainAgent ──────────────────────────────────────────

export class MainAgent extends EventEmitter<MainAgentEvents> {
	private contextManager: ContextManager;
	private signalRouter: SignalRouter;
	private llmClient: LLMClient;
	private adapter: AgentAdapter;
	private bridge: TmuxBridge;
	private stateDetector: StateDetector;
	private goal: string;
	private paneTarget: string | null = null;
	private memoryStore: MemoryStore | null = null;
	private embeddingProvider: EmbeddingProvider | null = null;
	private skillRegistry: SkillRegistry | null = null;
	private debug: boolean;
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
		adapter: AgentAdapter;
		bridge: TmuxBridge;
		stateDetector: StateDetector;
		goal: string;
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
		this.goal = opts.goal;
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

	async executeGoal(goal: string): Promise<GoalResult> {
		this.goal = goal;
		this.emit("goal_start", goal);
		this.emit("log", `Starting goal: ${goal}`);

		// Inject goal into system prompt
		this.contextManager.updateModule("goal", goal);

		// Inject GOAL message into conversation
		const goalMessage = `[GOAL] ${goal}\n\nYou are an autonomous agent. Analyze this goal, create a tmux session, send instructions to the coding agent, monitor progress, and adapt as needed. Call mark_complete when the entire goal is achieved.`;
		this.contextManager.addMessage({ role: "user", content: goalMessage });

		// Run the main execution loop
		const result = await this.runMainLoop();

		// Emit result events
		if (result.success) {
			this.emit("goal_complete", result);
		} else {
			this.emit("goal_failed", result.summary);
		}

		// Forward events to SignalRouter for TUI consumption
		if (result.success) {
			this.signalRouter.emit("goal_complete", { success: result.success, summary: result.summary });
		} else {
			this.signalRouter.emit("goal_failed", result.summary);
		}

		return result;
	}

	private async runMainLoop(): Promise<GoalResult> {
		while (true) {
			// Check abort
			if (this.signalRouter.isAborted()) {
				return { success: false, summary: "Aborted by user" };
			}

			// Wait while paused
			while (this.signalRouter.isPaused() && !this.signalRouter.isAborted()) {
				await sleep(500);
			}
			if (this.signalRouter.isAborted()) {
				return { success: false, summary: "Aborted by user" };
			}

			// Run tool-use loop
			const result = await this.runToolUseLoop();
			if (result) {
				return result;
			}

			// No terminal tool called and no more tool calls.
			// If we have a pane target, wait for signals from the agent.
			if (this.paneTarget) {
				const signalResult = await this.waitForSignal();
				if (signalResult) {
					return signalResult;
				}
				// Signal injected into conversation, continue main loop
			}
			// If no pane target and no tool calls, the LLM is thinking — loop continues
		}
	}

	private async waitForSignal(): Promise<GoalResult | null> {
		return new Promise<GoalResult | null>((resolve) => {
			let resolved = false;

			const handleSignal = async (signal: Signal) => {
				if (resolved) return;

				// Inject signal into conversation and let LLM decide
				const content = this.formatSignal(signal);
				this.contextManager.addMessage({ role: "user", content });
				this.emit("log", `Signal: ${signal.analysis?.status ?? signal.type} — ${signal.analysis?.detail ?? ""}`);

				// Stop monitoring temporarily to run tool-use loop
				this.signalRouter.stopMonitoring();
				resolved = true;

				// Run tool-use loop with signal context
				const result = await this.runToolUseLoop();
				if (result) {
					resolve(result);
				} else {
					// No terminal tool — resolve null to continue main loop
					resolve(null);
				}
			};

			this.signalRouter.onSignal(handleSignal);
			this.signalRouter.startMonitoring(this.paneTarget!, this.goal);
		});
	}

	private async runToolUseLoop(): Promise<GoalResult | null> {
		// Flush-before-compress ordering (Layer 2 → Layer 3)
		if (this.contextManager.shouldRunMemoryFlush()) {
			await this.contextManager.runMemoryFlush();
		}
		if (this.contextManager.shouldCompress()) {
			await this.contextManager.compress();
		}

		// Unbounded loop — exits only via terminal tool or no more tool calls
		while (true) {
			// Check abort before each LLM call
			if (this.signalRouter.isAborted()) {
				return { success: false, summary: "Aborted by user" };
			}

			// Use prepareForLLM() for Layer 1 context guard
			const { system, messages } = this.contextManager.prepareForLLM();

			const response = await this.llmClient.complete(messages, {
				systemPrompt: system,
				tools: TOOL_DEFINITIONS,
				temperature: 0.2,
			});

			// Report actual token usage for hybrid counting
			if (response.usage) {
				this.contextManager.reportUsage({
					inputTokens: response.usage.inputTokens ?? 0,
					outputTokens: response.usage.outputTokens ?? 0,
				});
			}

			// Debug: log every LLM response
			if (this.debug) {
				for (const block of response.contentBlocks) {
					if (block.type === "text") {
						logger.info("main-agent:debug", `[LLM text] ${block.text}`);
					} else if (block.type === "tool_call") {
						logger.info("main-agent:debug", `[LLM tool_call] ${block.name}(${JSON.stringify(block.arguments)})`);
					} else if (block.type === "thinking") {
						logger.info("main-agent:debug", `[LLM thinking] ${block.thinking}`);
					}
				}
				if (response.usage) {
					logger.info(
						"main-agent:debug",
						`[LLM usage] input=${response.usage.inputTokens} output=${response.usage.outputTokens}`,
					);
				}
			}

			// Add assistant response to conversation
			this.contextManager.addMessage({
				role: "assistant",
				content: response.contentBlocks,
			});

			// Extract tool calls
			const toolCalls = response.contentBlocks.filter((b): b is ToolCallContent => b.type === "tool_call");

			if (toolCalls.length === 0) {
				// No tool calls — thinking complete, return null to let caller handle
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
					return result.goalResult!;
				}
			}

			// Check context thresholds between iterations
			if (this.contextManager.shouldRunMemoryFlush()) {
				await this.contextManager.runMemoryFlush();
			}
			if (this.contextManager.shouldCompress()) {
				await this.contextManager.compress();
			}

			// Continue loop to let LLM see tool results
		}
	}

	private async executeTool(toolCall: ToolCallContent): Promise<{
		output: string;
		terminal: boolean;
		goalResult?: GoalResult;
	}> {
		const { name, arguments: args } = toolCall;
		logger.info("main-agent", `Executing tool: ${name}(${JSON.stringify(args)})`);

		switch (name) {
			case "send_to_agent": {
				if (!this.paneTarget) {
					return { output: "Error: No active session. Call create_session first.", terminal: false };
				}
				const prompt = args.prompt as string;
				await this.adapter.sendPrompt(this.bridge, this.paneTarget, prompt);
				this.stateDetector.setCooldown(3000);
				this.signalRouter.notifyPromptSent(prompt);
				return { output: "Prompt sent to agent.", terminal: false };
			}

			case "respond_to_agent": {
				if (!this.paneTarget) {
					return { output: "Error: No active session. Call create_session first.", terminal: false };
				}
				const value = args.value as string;
				await this.adapter.sendResponse(this.bridge, this.paneTarget, value);
				this.stateDetector.setCooldown(3000);
				return { output: `Response "${value}" sent to agent.`, terminal: false };
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
				this.emit("log", `Goal completed: ${summary}`);
				return {
					output: `Goal marked as complete: ${summary}`,
					terminal: true,
					goalResult: { success: true, summary },
				};
			}

			case "mark_failed": {
				const reason = args.reason as string;
				this.emit("log", `Goal failed: ${reason}`);
				return {
					output: `Goal marked as failed: ${reason}`,
					terminal: true,
					goalResult: { success: false, summary: reason, errors: [reason] },
				};
			}

			case "escalate_to_human": {
				const reason = args.reason as string;
				this.emit("need_human", reason);
				this.emit("log", `Escalated to human: ${reason}`);
				return {
					output: `Escalated to human: ${reason}`,
					terminal: true,
					goalResult: { success: false, summary: `Escalated: ${reason}` },
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
					sessionName = generateSessionName(this.goal);
				} else if (!sessionName.startsWith("clipilot-")) {
					sessionName = `clipilot-${sessionName}`;
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
						workingDir: process.cwd(),
						sessionName,
					});
					this.stateDetector.setCharacteristics(this.adapter.getCharacteristics());
					logger.info("main-agent", `Session created: ${sessionName}, pane: ${this.paneTarget}`);
					return {
						output: `Session "${sessionName}" created. Agent launched in ${this.paneTarget}. You can now use send_to_agent.`,
						terminal: false,
					};
				} catch (err: any) {
					return {
						output: `Failed to create session: ${err.message}`,
						terminal: false,
					};
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

			default: {
				// Check if this is a skill-registered tool
				if (this.skillRegistry) {
					const skillForTool = this.skillRegistry.getByToolName(name);
					if (skillForTool) {
						return { output: skillForTool.body, terminal: false };
					}
				}
				return {
					output: `Unknown tool: ${name}`,
					terminal: false,
				};
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

function generateSessionName(goal: string): string {
	const slug = goal
		.replace(/[^\w\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 30)
		.replace(/-$/, "");
	return `clipilot-${slug || "session"}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
