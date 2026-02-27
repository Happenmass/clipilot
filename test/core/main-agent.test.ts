import { describe, it, expect, vi } from "vitest";
import { MainAgent } from "../../src/core/main-agent.js";

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
		onSignal: vi.fn((h: any) => {
			handler = h;
		}),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		notifyPromptSent: vi.fn(),
		resetCaptureExpansion: vi.fn(),
		isPaused: vi.fn().mockReturnValue(false),
		isAborted: vi.fn().mockReturnValue(false),
		pause: vi.fn(),
		resume: vi.fn(),
		abort: vi.fn(),
		emit: vi.fn(),
		on: vi.fn(),
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
		launch: vi.fn().mockResolvedValue("test-session:0.0"),
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
		capturePane: vi.fn().mockResolvedValue({
			content: "extended pane content\n".repeat(100),
			lines: 300,
			timestamp: Date.now(),
		}),
		hasSession: vi.fn().mockResolvedValue(false),
		listClipilotSessions: vi.fn().mockResolvedValue([]),
		createSession: vi.fn().mockResolvedValue(undefined),
	} as any;
}

function createMockStateDetector() {
	return {
		setCooldown: vi.fn(),
		setCharacteristics: vi.fn(),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		onStateChange: vi.fn().mockReturnValue(() => {}),
	} as any;
}

describe("MainAgent", () => {
	let mockCtx: ReturnType<typeof createMockContextManager>;
	let mockRouter: ReturnType<typeof createMockSignalRouter>;
	let mockLLM: ReturnType<typeof createMockLLMClient>;
	let mockAdapter: ReturnType<typeof createMockAdapter>;
	let mockBridge: ReturnType<typeof createMockBridge>;
	let mockDetector: ReturnType<typeof createMockStateDetector>;

	function setupAgent(toolCallResponses?: any[]) {
		mockCtx = createMockContextManager();
		mockRouter = createMockSignalRouter();
		mockLLM = createMockLLMClient(toolCallResponses);
		mockAdapter = createMockAdapter();
		mockBridge = createMockBridge();
		mockDetector = createMockStateDetector();

		return new MainAgent({
			contextManager: mockCtx,
			signalRouter: mockRouter,
			llmClient: mockLLM,
			adapter: mockAdapter,
			bridge: mockBridge,
			stateDetector: mockDetector,
			goal: "Build a test app",
		});
	}

	describe("executeGoal", () => {
		it("should inject GOAL message into conversation", async () => {
			const agent = setupAgent([
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

			await agent.executeGoal("Build a test app");

			expect(mockCtx.addMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					role: "user",
					content: expect.stringContaining("[GOAL]"),
				}),
			);
		});

		it("should emit goal_start event", async () => {
			const agent = setupAgent([
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

			const startSpy = vi.fn();
			agent.on("goal_start", startSpy);

			await agent.executeGoal("Build a test app");

			expect(startSpy).toHaveBeenCalledWith("Build a test app");
		});

		it("should emit goal_complete on success", async () => {
			const agent = setupAgent([
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

			const completeSpy = vi.fn();
			agent.on("goal_complete", completeSpy);

			const result = await agent.executeGoal("Build a test app");
			expect(result.success).toBe(true);
			expect(result.summary).toBe("All done");
			expect(completeSpy).toHaveBeenCalled();
		});

		it("should emit goal_failed on failure", async () => {
			const agent = setupAgent([
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc1", name: "mark_failed", arguments: { reason: "Cannot do it" } },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
			]);

			const failSpy = vi.fn();
			agent.on("goal_failed", failSpy);

			const result = await agent.executeGoal("Build a test app");
			expect(result.success).toBe(false);
			expect(result.summary).toBe("Cannot do it");
			expect(failSpy).toHaveBeenCalledWith("Cannot do it");
		});

		it("should return aborted when signalRouter is aborted", async () => {
			mockCtx = createMockContextManager();
			mockRouter = createMockSignalRouter();
			mockRouter.isAborted.mockReturnValue(true);
			mockLLM = createMockLLMClient();
			mockAdapter = createMockAdapter();
			mockBridge = createMockBridge();
			mockDetector = createMockStateDetector();

			const agent = new MainAgent({
				contextManager: mockCtx,
				signalRouter: mockRouter,
				llmClient: mockLLM,
				adapter: mockAdapter,
				bridge: mockBridge,
				stateDetector: mockDetector,
				goal: "Build a test app",
			});

			const result = await agent.executeGoal("Build a test app");
			expect(result.success).toBe(false);
			expect(result.summary).toContain("Aborted");
		});
	});

	describe("tool execution", () => {
		it("should handle mark_complete as terminal tool", async () => {
			const agent = setupAgent([
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

			const result = await agent.executeGoal("Test");
			expect(result.success).toBe(true);
			expect(result.summary).toBe("All done");
		});

		it("should handle mark_failed as terminal tool", async () => {
			const agent = setupAgent([
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

			const result = await agent.executeGoal("Test");
			expect(result.success).toBe(false);
			expect(result.summary).toBe("Dependency missing");
		});

		it("should execute send_to_agent and set cooldown", async () => {
			const agent = setupAgent([
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc0", name: "create_session", arguments: {} },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
				{
					content: "",
					contentBlocks: [
						{
							type: "tool_call",
							id: "tc1",
							name: "send_to_agent",
							arguments: { prompt: "implement feature" },
						},
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc2", name: "mark_complete", arguments: { summary: "Done" } },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
			]);

			await agent.executeGoal("Test");

			expect(mockAdapter.sendPrompt).toHaveBeenCalledWith(
				mockBridge,
				"test-session:0.0",
				"implement feature",
			);
			expect(mockDetector.setCooldown).toHaveBeenCalledWith(3000);
			expect(mockRouter.notifyPromptSent).toHaveBeenCalledWith("implement feature");
		});

		it("should return error when send_to_agent called without session", async () => {
			const agent = setupAgent([
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc1", name: "send_to_agent", arguments: { prompt: "do stuff" } },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc2", name: "mark_failed", arguments: { reason: "No session" } },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
			]);

			const result = await agent.executeGoal("Test");
			expect(result.success).toBe(false);

			expect(mockCtx.addMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					role: "tool",
					content: expect.stringContaining("No active session"),
				}),
			);
		});

		it("should handle multi-step tool use (fetch_more then send_to_agent)", async () => {
			const agent = setupAgent([
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc0", name: "create_session", arguments: {} },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc1", name: "fetch_more", arguments: { lines: 300 } },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
				{
					content: "",
					contentBlocks: [
						{
							type: "tool_call",
							id: "tc2",
							name: "send_to_agent",
							arguments: { prompt: "continue" },
						},
					],
					usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
					stopReason: "tool_use",
					model: "test",
				},
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc3", name: "mark_complete", arguments: { summary: "Done" } },
					],
					usage: { inputTokens: 200, outputTokens: 10, totalTokens: 210 },
					stopReason: "tool_use",
					model: "test",
				},
			]);

			const result = await agent.executeGoal("Test");
			expect(result.success).toBe(true);

			expect(mockBridge.capturePane).toHaveBeenCalledWith("test-session:0.0", { startLine: -300 });
			expect(mockAdapter.sendPrompt).toHaveBeenCalledWith(mockBridge, "test-session:0.0", "continue");
		});
	});

	describe("create_session tool", () => {
		it("should create a session and launch the agent", async () => {
			const agent = setupAgent([
				{
					content: "",
					contentBlocks: [
						{
							type: "tool_call",
							id: "tc0",
							name: "create_session",
							arguments: { session_name: "my-task" },
						},
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
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

			const result = await agent.executeGoal("Test");
			expect(result.success).toBe(true);

			expect(mockAdapter.launch).toHaveBeenCalledWith(mockBridge, {
				workingDir: expect.any(String),
				sessionName: "clipilot-my-task",
			});
			expect(mockDetector.setCharacteristics).toHaveBeenCalled();
			expect(agent.getPaneTarget()).toBe("test-session:0.0");
		});

		it("should auto-generate session name when omitted", async () => {
			const agent = setupAgent([
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc0", name: "create_session", arguments: {} },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
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

			await agent.executeGoal("Test");

			expect(mockAdapter.launch).toHaveBeenCalledWith(mockBridge, {
				workingDir: expect.any(String),
				sessionName: expect.stringContaining("clipilot-"),
			});
		});

		it("should return error on naming conflict", async () => {
			const agent = setupAgent([
				{
					content: "",
					contentBlocks: [
						{
							type: "tool_call",
							id: "tc0",
							name: "create_session",
							arguments: { session_name: "existing" },
						},
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
				{
					content: "",
					contentBlocks: [
						{
							type: "tool_call",
							id: "tc1",
							name: "mark_failed",
							arguments: { reason: "Session conflict" },
						},
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
			]);
			mockBridge.hasSession.mockResolvedValue(true);

			const result = await agent.executeGoal("Test");
			expect(result.success).toBe(false);

			expect(mockCtx.addMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					role: "tool",
					content: expect.stringContaining("already exists"),
				}),
			);
			expect(mockAdapter.launch).not.toHaveBeenCalled();
		});
	});

	describe("list_clipilot_sessions tool", () => {
		it("should list sessions with clipilot prefix", async () => {
			const agent = setupAgent([
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc0", name: "list_clipilot_sessions", arguments: {} },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc1", name: "mark_complete", arguments: { summary: "Listed" } },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
			]);
			mockBridge.listClipilotSessions.mockResolvedValue([
				{ name: "clipilot-task-a", windows: 1, created: 1234567890, attached: false },
				{ name: "clipilot-task-b", windows: 2, created: 1234567891, attached: true },
			]);

			const result = await agent.executeGoal("Test");
			expect(result.success).toBe(true);

			expect(mockCtx.addMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					role: "tool",
					content: expect.stringContaining("clipilot-task-a"),
				}),
			);
		});

		it("should handle no sessions found", async () => {
			const agent = setupAgent([
				{
					content: "",
					contentBlocks: [
						{ type: "tool_call", id: "tc0", name: "list_clipilot_sessions", arguments: {} },
					],
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					stopReason: "tool_use",
					model: "test",
				},
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

			await agent.executeGoal("Test");

			expect(mockCtx.addMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					role: "tool",
					content: "No clipilot sessions found.",
				}),
			);
		});
	});

	describe("compression", () => {
		it("should trigger compression when threshold exceeded", async () => {
			const agent = setupAgent([
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

			mockCtx.shouldCompress.mockReturnValue(true);

			await agent.executeGoal("Test");

			expect(mockCtx.compress).toHaveBeenCalled();
		});
	});
});
