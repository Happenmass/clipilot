import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContextManager } from "../../src/core/context-manager.js";
import { MainAgent } from "../../src/core/main-agent.js";
import { SignalRouter } from "../../src/core/signal-router.js";
import type { AgentAdapter, AgentCharacteristics } from "../../src/agents/adapter.js";
import type { LLMClient } from "../../src/llm/client.js";
import type { TmuxBridge } from "../../src/tmux/bridge.js";
import type { StateDetector } from "../../src/tmux/state-detector.js";
import type { PromptLoader } from "../../src/llm/prompt-loader.js";

/**
 * Integration test: simulates the full Goal → executeGoal → GoalResult flow
 * through the MainAgent architecture.
 *
 * Components wired together:
 *   ContextManager (real) ← SignalRouter (real) ← MainAgent (real)
 *   LLMClient, Adapter, Bridge, StateDetector, PromptLoader (mocked)
 */

function createMockPromptLoader(): PromptLoader {
	return {
		getRaw: vi.fn().mockReturnValue(
			"You are the Main Agent. Goal: {{goal}}\nHistory: {{compressed_history}}\nMemory: {{memory}}\nCapabilities: {{agent_capabilities}}",
		),
		resolve: vi.fn().mockReturnValue("compressor prompt"),
		load: vi.fn().mockResolvedValue(undefined),
		setGlobalContext: vi.fn(),
	} as any;
}

function createMockLLMClient(responses: any[]) {
	let callCount = 0;
	return {
		complete: vi.fn().mockImplementation(() => {
			const response = responses[callCount] ?? {
				content: "No more responses",
				contentBlocks: [{ type: "text", text: "No more responses" }],
				usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
				stopReason: "end_turn",
				model: "test",
			};
			callCount++;
			return Promise.resolve(response);
		}),
		completeJson: vi.fn(),
		getModel: vi.fn().mockReturnValue("test-model"),
	} as any;
}

function createMockAdapter(): AgentAdapter {
	return {
		name: "mock",
		displayName: "Mock Agent",
		launch: vi.fn().mockResolvedValue("test-session:0.0"),
		sendPrompt: vi.fn().mockResolvedValue(undefined),
		sendResponse: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
		getCharacteristics: vi.fn().mockReturnValue({
			waitingPatterns: [/^>\s*$/m],
			completionPatterns: [/^>\s*$/m],
			errorPatterns: [/Error:/i],
			activePatterns: [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
			confirmKey: "y",
			abortKey: "Escape",
		} satisfies AgentCharacteristics),
	};
}

function createMockBridge(): TmuxBridge {
	return {
		capturePane: vi.fn().mockResolvedValue({
			content: "mock pane content\n".repeat(50),
			lines: 50,
			timestamp: Date.now(),
		}),
		hasSession: vi.fn().mockResolvedValue(false),
		listClipilotSessions: vi.fn().mockResolvedValue([]),
	} as any;
}

function createMockStateDetector() {
	const callbacks: Array<(analysis: any, content: string) => void> = [];
	return {
		setCharacteristics: vi.fn(),
		setCooldown: vi.fn(),
		onStateChange: vi.fn((cb: any) => {
			callbacks.push(cb);
			return () => {
				const idx = callbacks.indexOf(cb);
				if (idx >= 0) callbacks.splice(idx, 1);
			};
		}),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		analyzeState: vi.fn(),
		deepAnalyze: vi.fn(),
		_callbacks: callbacks,
	} as any;
}

/** Helper: create a tool call response */
function toolCall(id: string, name: string, args: Record<string, any>) {
	return {
		content: "",
		contentBlocks: [{ type: "tool_call", id, name, arguments: args }],
		usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
		stopReason: "tool_use",
		model: "test",
	};
}

/** Helper: create an end_turn response (no tool calls) */
function endTurn(text = "Waiting") {
	return {
		content: text,
		contentBlocks: [{ type: "text", text }],
		usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
		stopReason: "end_turn",
		model: "test",
	};
}

describe("Integration: Goal-driven execution end-to-end", () => {
	let promptLoader: ReturnType<typeof createMockPromptLoader>;
	let adapter: AgentAdapter;
	let bridge: ReturnType<typeof createMockBridge>;
	let stateDetector: ReturnType<typeof createMockStateDetector>;

	beforeEach(() => {
		promptLoader = createMockPromptLoader();
		adapter = createMockAdapter();
		bridge = createMockBridge();
		stateDetector = createMockStateDetector();
	});

	it("should complete a goal via create_session → send_to_agent → signal → mark_complete", async () => {
		const llmClient = createMockLLMClient([
			toolCall("tc0", "create_session", {}),
			toolCall("tc1", "send_to_agent", { prompt: "Implement the feature" }),
			endTurn("Waiting for agent"),
			// After signal injection, LLM decides the goal is complete
			toolCall("tc2", "mark_complete", { summary: "Feature implemented successfully" }),
		]);

		const contextManager = new ContextManager({ llmClient, promptLoader });
		contextManager.updateModule("goal", "Build a feature");

		const signalRouter = new SignalRouter(stateDetector as any, bridge, contextManager);

		const mainAgent = new MainAgent({
			contextManager,
			signalRouter,
			llmClient,
			adapter,
			bridge,
			stateDetector: stateDetector as any,
			goal: "Build a feature",
		});

		const events: string[] = [];
		mainAgent.on("goal_start", (g) => events.push(`start:${g}`));
		mainAgent.on("goal_complete", (r) => events.push(`complete:${r.summary}`));

		const resultPromise = mainAgent.executeGoal("Build a feature");
		await new Promise((r) => setTimeout(r, 100));

		// Simulate signal from StateDetector (completed state → DECISION_NEEDED)
		for (const cb of stateDetector._callbacks) {
			cb(
				{ status: "completed", confidence: 0.95, detail: "Agent finished the task" },
				"> ",
			);
		}

		const result = await resultPromise;

		expect(result.success).toBe(true);
		expect(result.summary).toBe("Feature implemented successfully");
		expect(adapter.launch).toHaveBeenCalledTimes(1);
		expect(adapter.sendPrompt).toHaveBeenCalledWith(bridge, "test-session:0.0", "Implement the feature");
		expect(stateDetector.setCooldown).toHaveBeenCalledWith(3000);
		expect(events).toContain("start:Build a feature");
		expect(events).toContain("complete:Feature implemented successfully");
	});

	it("should complete a goal via mark_complete tool (terminal tool, no signal needed)", async () => {
		const llmClient = createMockLLMClient([
			toolCall("tc1", "mark_complete", { summary: "Goal achieved directly" }),
		]);

		const contextManager = new ContextManager({ llmClient, promptLoader });
		const signalRouter = new SignalRouter(stateDetector as any, bridge, contextManager);
		const mainAgent = new MainAgent({
			contextManager,
			signalRouter,
			llmClient,
			adapter,
			bridge,
			stateDetector: stateDetector as any,
			goal: "Quick goal",
		});

		const result = await mainAgent.executeGoal("Quick goal");

		expect(result.success).toBe(true);
		expect(result.summary).toBe("Goal achieved directly");
	});

	it("should handle multi-step tool use: create_session → fetch_more → send_to_agent → monitor → complete", async () => {
		const llmClient = createMockLLMClient([
			toolCall("tc0", "create_session", {}),
			toolCall("tc1", "fetch_more", { lines: 200 }),
			toolCall("tc2", "send_to_agent", { prompt: "Fix the bug based on the error I see" }),
			endTurn("Monitoring agent..."),
			// After signal injection
			toolCall("tc3", "mark_complete", { summary: "Bug fixed" }),
		]);

		const contextManager = new ContextManager({ llmClient, promptLoader });
		const signalRouter = new SignalRouter(stateDetector as any, bridge, contextManager);
		const mainAgent = new MainAgent({
			contextManager,
			signalRouter,
			llmClient,
			adapter,
			bridge,
			stateDetector: stateDetector as any,
			goal: "Fix bugs",
		});

		const resultPromise = mainAgent.executeGoal("Fix bugs");
		await new Promise((r) => setTimeout(r, 100));

		// Simulate completion from StateDetector
		for (const cb of stateDetector._callbacks) {
			cb(
				{ status: "completed", confidence: 0.95, detail: "Bug fixed" },
				"> ",
			);
		}

		const result = await resultPromise;

		expect(result.success).toBe(true);
		expect(result.summary).toBe("Bug fixed");
		expect(bridge.capturePane).toHaveBeenCalledWith("test-session:0.0", { startLine: -200 });
		expect(adapter.sendPrompt).toHaveBeenCalledWith(
			bridge,
			"test-session:0.0",
			"Fix the bug based on the error I see",
		);
	});

	it("should handle goal failure via mark_failed tool", async () => {
		const llmClient = createMockLLMClient([
			toolCall("tc1", "mark_failed", { reason: "Cannot resolve dependency" }),
		]);

		const contextManager = new ContextManager({ llmClient, promptLoader });
		const signalRouter = new SignalRouter(stateDetector as any, bridge, contextManager);
		const mainAgent = new MainAgent({
			contextManager,
			signalRouter,
			llmClient,
			adapter,
			bridge,
			stateDetector: stateDetector as any,
			goal: "Attempt something",
		});

		const failSpy = vi.fn();
		mainAgent.on("goal_failed", failSpy);

		const result = await mainAgent.executeGoal("Attempt something");

		expect(result.success).toBe(false);
		expect(result.summary).toBe("Cannot resolve dependency");
		expect(failSpy).toHaveBeenCalledWith("Cannot resolve dependency");
	});

	it("should handle escalate_to_human as terminal tool", async () => {
		const llmClient = createMockLLMClient([
			toolCall("tc1", "escalate_to_human", { reason: "Need permission to delete files" }),
		]);

		const contextManager = new ContextManager({ llmClient, promptLoader });
		const signalRouter = new SignalRouter(stateDetector as any, bridge, contextManager);
		const mainAgent = new MainAgent({
			contextManager,
			signalRouter,
			llmClient,
			adapter,
			bridge,
			stateDetector: stateDetector as any,
			goal: "Cleanup project",
		});

		const humanSpy = vi.fn();
		mainAgent.on("need_human", humanSpy);

		const result = await mainAgent.executeGoal("Cleanup project");

		expect(result.success).toBe(false);
		expect(result.summary).toContain("Need permission to delete files");
		expect(humanSpy).toHaveBeenCalledWith("Need permission to delete files");
	});
});
