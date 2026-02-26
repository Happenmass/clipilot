import { describe, it, expect, beforeEach, vi } from "vitest";
import { MainAgent } from "../../src/core/main-agent.js";
import { TaskGraph } from "../../src/core/task.js";
import type { Task } from "../../src/core/task.js";

function createTestTask(overrides?: Partial<Task>): Task {
	return {
		id: "1",
		title: "Test task",
		description: "A test task",
		status: "pending",
		dependencies: [],
		attempts: 0,
		maxAttempts: 3,
		estimatedComplexity: "low",
		createdAt: Date.now(),
		...overrides,
	};
}

function createMockContextManager() {
	return {
		addMessage: vi.fn(),
		getMessages: vi.fn().mockReturnValue([]),
		getSystemPrompt: vi.fn().mockReturnValue("You are the Main Agent"),
		updateModule: vi.fn(),
		shouldCompress: vi.fn().mockReturnValue(false),
		compress: vi.fn(),
		getConversationLength: vi.fn().mockReturnValue(0),
		prepareForLLM: vi.fn().mockReturnValue({
			system: "You are the Main Agent",
			messages: [],
		}),
		reportUsage: vi.fn(),
		shouldRunMemoryFlush: vi.fn().mockReturnValue(false),
		runMemoryFlush: vi.fn(),
		getCurrentTokenEstimate: vi.fn().mockReturnValue(0),
	} as any;
}

function createMockSignalRouter() {
	let handler: any = null;
	return {
		onSignal: vi.fn((h: any) => { handler = h; }),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		notifyPromptSent: vi.fn(),
		notifyNewTask: vi.fn(),
		setTaskGraph: vi.fn(),
		_getHandler: () => handler,
	} as any;
}

function createMockLLMClient(toolCallResponses: any[] = []) {
	let callCount = 0;
	return {
		complete: vi.fn().mockImplementation(() => {
			const response = toolCallResponses[callCount] ?? {
				content: "Thinking...",
				contentBlocks: [{ type: "text", text: "Thinking..." }],
				usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
				stopReason: "end_turn",
				model: "test-model",
			};
			callCount++;
			return Promise.resolve(response);
		}),
	} as any;
}

function createMockAdapter() {
	return {
		name: "test-agent",
		displayName: "Test Agent",
		sendPrompt: vi.fn().mockResolvedValue(undefined),
		sendResponse: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn(),
		getCharacteristics: vi.fn().mockReturnValue({
			waitingPatterns: [],
			completionPatterns: [],
			errorPatterns: [],
			activePatterns: [],
			confirmKey: "Enter",
			abortKey: "C-c",
		}),
	} as any;
}

function createMockBridge() {
	return {
		capturePane: vi.fn().mockResolvedValue({ content: "extended pane content\n".repeat(100), lines: 300, timestamp: Date.now() }),
	} as any;
}

function createMockStateDetector() {
	return {
		setCooldown: vi.fn(),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		onStateChange: vi.fn().mockReturnValue(() => {}),
	} as any;
}

function createMockPlanner() {
	return {
		replan: vi.fn().mockResolvedValue(new TaskGraph()),
	} as any;
}

describe("MainAgent", () => {
	let mainAgent: MainAgent;
	let mockCtx: ReturnType<typeof createMockContextManager>;
	let mockRouter: ReturnType<typeof createMockSignalRouter>;
	let mockLLM: ReturnType<typeof createMockLLMClient>;
	let mockAdapter: ReturnType<typeof createMockAdapter>;
	let mockBridge: ReturnType<typeof createMockBridge>;
	let mockDetector: ReturnType<typeof createMockStateDetector>;
	let mockPlanner: ReturnType<typeof createMockPlanner>;
	let taskGraph: TaskGraph;

	function setupAgent(toolCallResponses?: any[]) {
		mockCtx = createMockContextManager();
		mockRouter = createMockSignalRouter();
		mockLLM = createMockLLMClient(toolCallResponses);
		mockAdapter = createMockAdapter();
		mockBridge = createMockBridge();
		mockDetector = createMockStateDetector();
		mockPlanner = createMockPlanner();
		taskGraph = new TaskGraph();

		mainAgent = new MainAgent({
			contextManager: mockCtx,
			signalRouter: mockRouter,
			llmClient: mockLLM,
			planner: mockPlanner,
			adapter: mockAdapter,
			bridge: mockBridge,
			stateDetector: mockDetector,
			taskGraph,
			goal: "Build a test app",
		});
		mainAgent.setPaneTarget("test:0.0");
	}

	describe("executeTask", () => {
		it("should return error if no pane target", async () => {
			setupAgent();
			mainAgent.setPaneTarget(null as any);
			// Need to set paneTarget to null - use a workaround
			const agent = new MainAgent({
				contextManager: mockCtx,
				signalRouter: mockRouter,
				llmClient: mockLLM,
				planner: mockPlanner,
				adapter: mockAdapter,
				bridge: mockBridge,
				stateDetector: mockDetector,
				taskGraph,
				goal: "test",
			});

			const task = createTestTask();
			const result = await agent.executeTask(task);
			expect(result.success).toBe(false);
			expect(result.summary).toContain("pane not available");
		});

		it("should inject TASK_READY message into conversation", async () => {
			// LLM responds with send_to_agent, then on second call (after send), returns no tool calls
			// Then fast-path completion signal resolves the task
			setupAgent([
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc1", name: "send_to_agent", arguments: { prompt: "Do the task" } },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
				{
					content: "Waiting for agent to complete",
					contentBlocks: [{ type: "text", text: "Waiting" }],
					usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
					stopReason: "end_turn",
					model: "test",
				},
			]);

			const task = createTestTask();
			taskGraph.addTask(task);
			taskGraph.updateStatus("1", "running");

			// Start executeTask but don't await yet
			const resultPromise = mainAgent.executeTask(task);

			// Wait for monitoring to start
			await new Promise((r) => setTimeout(r, 50));

			// Simulate fast-path completion
			const handler = mockRouter._getHandler();
			if (handler) {
				await handler({
					type: "NOTIFY",
					paneContent: "> ",
					analysis: { status: "completed", confidence: 0.95, detail: "Task done" },
				});
			}

			const result = await resultPromise;
			expect(result.success).toBe(true);

			// Check TASK_READY was injected
			expect(mockCtx.addMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					role: "user",
					content: expect.stringContaining("[TASK_READY]"),
				}),
			);
		});
	});

	describe("tool execution", () => {
		it("should execute send_to_agent and set cooldown", async () => {
			setupAgent([
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc1", name: "send_to_agent", arguments: { prompt: "implement feature" } },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
				{
					content: "Done",
					contentBlocks: [{ type: "text", text: "Done" }],
					usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
					stopReason: "end_turn",
					model: "test",
				},
			]);

			const task = createTestTask();
			taskGraph.addTask(task);
			taskGraph.updateStatus("1", "running");

			const resultPromise = mainAgent.executeTask(task);
			await new Promise((r) => setTimeout(r, 50));

			// Resolve via fast-path
			const handler = mockRouter._getHandler();
			if (handler) {
				await handler({
					type: "NOTIFY",
					paneContent: "> ",
					analysis: { status: "completed", confidence: 0.95, detail: "Done" },
				});
			}

			await resultPromise;

			expect(mockAdapter.sendPrompt).toHaveBeenCalledWith(
				mockBridge, "test:0.0", "implement feature",
			);
			expect(mockDetector.setCooldown).toHaveBeenCalledWith(3000);
			expect(mockRouter.notifyPromptSent).toHaveBeenCalledWith("implement feature");
		});

		it("should handle mark_complete as terminal tool", async () => {
			setupAgent([
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc1", name: "mark_complete", arguments: { summary: "All done" } },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
			]);

			const task = createTestTask();
			taskGraph.addTask(task);
			taskGraph.updateStatus("1", "running");

			// mark_complete in TASK_READY response should immediately resolve
			const result = await mainAgent.executeTask(task);
			expect(result.success).toBe(true);
			expect(result.summary).toBe("All done");
		});

		it("should handle mark_failed as terminal tool", async () => {
			setupAgent([
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc1", name: "mark_failed", arguments: { reason: "Dependency missing" } },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
			]);

			const task = createTestTask();
			taskGraph.addTask(task);
			taskGraph.updateStatus("1", "running");

			const result = await mainAgent.executeTask(task);
			expect(result.success).toBe(false);
			expect(result.summary).toBe("Dependency missing");
		});

		it("should handle multi-step tool use (fetch_more then send_to_agent)", async () => {
			setupAgent([
				// Step 1: LLM calls fetch_more
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc1", name: "fetch_more", arguments: { lines: 300 } },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
				// Step 2: LLM sees fetch result, calls send_to_agent
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc2", name: "send_to_agent", arguments: { prompt: "continue" } },
					],
					usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
					stopReason: "tool_use",
					model: "test",
				},
				// Step 3: No more tool calls
				{
					content: "Monitoring",
					contentBlocks: [{ type: "text", text: "Monitoring" }],
					usage: { inputTokens: 200, outputTokens: 10, totalTokens: 210 },
					stopReason: "end_turn",
					model: "test",
				},
			]);

			const task = createTestTask();
			taskGraph.addTask(task);
			taskGraph.updateStatus("1", "running");

			const resultPromise = mainAgent.executeTask(task);
			await new Promise((r) => setTimeout(r, 50));

			const handler = mockRouter._getHandler();
			if (handler) {
				await handler({
					type: "NOTIFY",
					paneContent: "> ",
					analysis: { status: "completed", confidence: 0.95, detail: "Done" },
				});
			}

			const result = await resultPromise;
			expect(result.success).toBe(true);

			// Both fetch_more and send_to_agent should have been called
			expect(mockBridge.capturePane).toHaveBeenCalledWith("test:0.0", { startLine: -300 });
			expect(mockAdapter.sendPrompt).toHaveBeenCalledWith(mockBridge, "test:0.0", "continue");
		});
	});

	describe("compression", () => {
		it("should trigger compression when threshold exceeded", async () => {
			setupAgent([
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc1", name: "mark_complete", arguments: { summary: "Done" } },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
			]);

			// Set shouldCompress to return true on the existing mockCtx
			mockCtx.shouldCompress.mockReturnValue(true);

			const task = createTestTask();
			taskGraph.addTask(task);
			taskGraph.updateStatus("1", "running");

			await mainAgent.executeTask(task);

			expect(mockCtx.compress).toHaveBeenCalled();
		});
	});
});
