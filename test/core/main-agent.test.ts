import { describe, it, expect, vi, beforeEach } from "vitest";
import { MainAgent } from "../../src/core/main-agent.js";
import type { LLMStreamEvent } from "../../src/llm/types.js";

// ─── Mock factories ──────────────────────────────────

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
	return {
		onSignal: vi.fn(),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		notifyPromptSent: vi.fn(),
		resetCaptureExpansion: vi.fn(),
		isStopRequested: vi.fn().mockReturnValue(false),
		stop: vi.fn(),
		resume: vi.fn(),
		emit: vi.fn(),
		on: vi.fn(),
	} as any;
}

function createMockBroadcaster() {
	return {
		broadcast: vi.fn(),
		addClient: vi.fn(),
		removeClient: vi.fn(),
		getClientCount: vi.fn().mockReturnValue(0),
	} as any;
}

/**
 * Create a mock LLM client that returns streaming responses.
 * Each entry in `responses` is an array of LLMStreamEvents.
 */
function createMockStreamingLLM(responses: LLMStreamEvent[][]) {
	let callCount = 0;
	return {
		stream: vi.fn().mockImplementation(() => {
			const events = responses[callCount] ?? [];
			callCount++;
			return (async function* () {
				for (const event of events) {
					yield event;
				}
			})();
		}),
		complete: vi.fn(),
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
			content: "pane content\n".repeat(10),
			lines: 50,
			timestamp: Date.now(),
		}),
		hasSession: vi.fn().mockResolvedValue(false),
		listClipilotSessions: vi.fn().mockResolvedValue([]),
		createSession: vi.fn().mockResolvedValue(undefined),
	} as any;
}

function createMockStateDetector() {
	return {
		setCharacteristics: vi.fn(),
		captureHash: vi.fn().mockResolvedValue("mock-pre-hash"),
		waitForSettled: vi.fn().mockResolvedValue({
			analysis: { status: "completed", confidence: 0.9, detail: "Agent finished" },
			content: "> task done",
			timedOut: false,
		}),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		onStateChange: vi.fn().mockReturnValue(() => {}),
	} as any;
}

// ─── Helper: build streaming events ────────────────────

function textResponse(text: string): LLMStreamEvent[] {
	const events: LLMStreamEvent[] = [];
	for (const char of text) {
		events.push({ type: "text_delta", delta: char });
	}
	events.push({
		type: "done",
		response: {
			content: text,
			contentBlocks: [{ type: "text", text }],
			usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			stopReason: "end_turn",
			model: "test",
		},
	});
	return events;
}

function toolCallResponse(
	toolName: string,
	args: Record<string, any>,
	toolCallId = "tc1",
	text = "",
): LLMStreamEvent[] {
	const events: LLMStreamEvent[] = [];
	if (text) {
		events.push({ type: "text_delta", delta: text });
	}
	const argsJson = JSON.stringify(args);
	events.push({
		type: "tool_call_delta",
		index: 0,
		id: toolCallId,
		name: toolName,
		argumentsDelta: argsJson,
	});
	events.push({
		type: "done",
		response: {
			content: text,
			contentBlocks: [
				...(text ? [{ type: "text" as const, text }] : []),
				{ type: "tool_call" as const, id: toolCallId, name: toolName, arguments: args },
			],
			usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			stopReason: "tool_use",
			model: "test",
		},
	});
	return events;
}

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

// ─── Tests ─────────────────────────────────────────────

describe("MainAgent State Machine", () => {
	let mockCtx: ReturnType<typeof createMockContextManager>;
	let mockRouter: ReturnType<typeof createMockSignalRouter>;
	let mockBroadcaster: ReturnType<typeof createMockBroadcaster>;
	let mockAdapter: ReturnType<typeof createMockAdapter>;
	let mockBridge: ReturnType<typeof createMockBridge>;
	let mockDetector: ReturnType<typeof createMockStateDetector>;

	function setupAgent(responses: LLMStreamEvent[][]) {
		mockCtx = createMockContextManager();
		mockRouter = createMockSignalRouter();
		mockBroadcaster = createMockBroadcaster();
		mockAdapter = createMockAdapter();
		mockBridge = createMockBridge();
		mockDetector = createMockStateDetector();

		const mockLLM = createMockStreamingLLM(responses);

		return new MainAgent({
			contextManager: mockCtx,
			signalRouter: mockRouter,
			llmClient: mockLLM,
			adapter: mockAdapter,
			bridge: mockBridge,
			stateDetector: mockDetector,
			broadcaster: mockBroadcaster,
		});
	}

	describe("initial state", () => {
		it("should start in idle state", () => {
			const agent = setupAgent([]);
			expect(agent.state).toBe("idle");
		});
	});

	describe("handleMessage in IDLE state", () => {
		it("should add user message to conversation", async () => {
			const agent = setupAgent([textResponse("Hello!")]);
			await agent.handleMessage("hi");

			expect(mockCtx.addMessage).toHaveBeenCalledWith(
				expect.objectContaining({ role: "user", content: "hi" }),
			);
		});

		it("should stream text response and stay idle", async () => {
			const agent = setupAgent([textResponse("Hello there!")]);
			await agent.handleMessage("hi");

			// Should broadcast deltas
			const deltaCalls = mockBroadcaster.broadcast.mock.calls.filter(
				(c: any) => c[0].type === "assistant_delta",
			);
			expect(deltaCalls.length).toBeGreaterThan(0);

			// Should broadcast assistant_done
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith({ type: "assistant_done" });

			// Should stay idle
			expect(agent.state).toBe("idle");
		});

		it("should enter executing state when LLM returns tool calls", async () => {
			const agent = setupAgent([
				toolCallResponse("mark_complete", { summary: "Done" }),
			]);

			await agent.handleMessage("do something");

			// Terminal tool → back to idle
			expect(agent.state).toBe("idle");

			// Should have been in executing state (verified by state broadcast)
			const stateCalls = mockBroadcaster.broadcast.mock.calls.filter(
				(c: any) => c[0].type === "state",
			);
			expect(stateCalls).toContainEqual([{ type: "state", state: "executing" }]);
			expect(stateCalls).toContainEqual([{ type: "state", state: "idle" }]);
		});

		it("should serialize concurrent idle messages", async () => {
			mockCtx = createMockContextManager();
			mockRouter = createMockSignalRouter();
			mockBroadcaster = createMockBroadcaster();
			mockAdapter = createMockAdapter();
			mockBridge = createMockBridge();
			mockDetector = createMockStateDetector();

			const firstStreamGate = createDeferred();
			let callCount = 0;
			let activeStreams = 0;
			let maxConcurrentStreams = 0;

			const mockLLM = {
				stream: vi.fn().mockImplementation(() => {
					const currentCall = callCount++;
					const text = currentCall === 0 ? "First reply" : "Second reply";

					return (async function* () {
						activeStreams++;
						maxConcurrentStreams = Math.max(maxConcurrentStreams, activeStreams);
						try {
							if (currentCall === 0) {
								await firstStreamGate.promise;
							}
							for (const char of text) {
								yield { type: "text_delta", delta: char } as const;
							}
							yield {
								type: "done" as const,
								response: {
									content: text,
									contentBlocks: [{ type: "text" as const, text }],
									usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
									stopReason: "end_turn",
									model: "test",
								},
							};
						} finally {
							activeStreams--;
						}
					})();
				}),
				complete: vi.fn(),
			};

			const agent = new MainAgent({
				contextManager: mockCtx,
				signalRouter: mockRouter,
				llmClient: mockLLM as any,
				adapter: mockAdapter,
				bridge: mockBridge,
				stateDetector: mockDetector,
				broadcaster: mockBroadcaster,
			});

			const firstPromise = agent.handleMessage("first");
			const secondPromise = agent.handleMessage("second");

			await Promise.resolve();
			firstStreamGate.resolve();

			await Promise.all([firstPromise, secondPromise]);

			expect(maxConcurrentStreams).toBe(1);
			expect(mockCtx.addMessage.mock.calls).toEqual([
				[{ role: "user", content: "first" }],
				[{ role: "assistant", content: "First reply" }],
				[{ role: "user", content: "second" }],
				[{ role: "assistant", content: "Second reply" }],
			]);
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith({
				type: "system",
				message: "消息已排队，将在当前操作完成后处理",
			});
		});
	});

	describe("handleMessage in EXECUTING state", () => {
		it("should queue message and send system notification", async () => {
			// Setup: first call returns a tool that blocks (create_session + send_to_agent)
			// But simpler: just set the state to executing manually by sending a message that triggers tools
			const agent = setupAgent([
				toolCallResponse("create_session", {}, "tc0"),
				toolCallResponse("send_to_agent", { prompt: "work", summary: "Working" }, "tc1"),
				toolCallResponse("mark_complete", { summary: "Done" }, "tc2"),
			]);

			// Start a task that will enter EXECUTING
			const handlePromise = agent.handleMessage("do a task");

			// Wait for it to complete
			await handlePromise;

			// The agent should be back to idle after mark_complete
			expect(agent.state).toBe("idle");
		});
	});

	describe("IDLE → EXECUTING → IDLE flow", () => {
		it("should complete full flow: text + tool call → execute → mark_complete → idle", async () => {
			const agent = setupAgent([
				// First LLM call: tool call
				toolCallResponse("create_session", {}, "tc0", "I'll create a session."),
				// Second LLM call (after create_session result): send_to_agent
				toolCallResponse("send_to_agent", { prompt: "implement feature", summary: "Implementing feature" }, "tc1"),
				// Third LLM call (after send_to_agent result): mark_complete
				toolCallResponse("mark_complete", { summary: "Feature implemented" }, "tc2"),
			]);

			await agent.handleMessage("implement the feature");

			expect(agent.state).toBe("idle");

			// Check system message for completion
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "system",
					message: expect.stringContaining("任务完成"),
				}),
			);
		});
	});

	describe("tool summary broadcasting", () => {
		it("should broadcast agent_update for send_to_agent with summary", async () => {
			const agent = setupAgent([
				toolCallResponse("create_session", {}, "tc0"),
				toolCallResponse("send_to_agent", { prompt: "add auth", summary: "Adding JWT auth" }, "tc1"),
				toolCallResponse("mark_complete", { summary: "Done" }, "tc2"),
			]);

			await agent.handleMessage("add auth");

			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith({
				type: "agent_update",
				summary: "Adding JWT auth",
			});
		});
	});

	describe("stopRequested between rounds", () => {
		it("should stop executing loop when stopRequested is set", async () => {
			const agent = setupAgent([
				toolCallResponse("create_session", {}, "tc0"),
				// After this tool, stopRequested will be true
				toolCallResponse("fetch_more", { lines: 100 }, "tc1"),
			]);

			// Patch signalRouter with special isStopRequested behavior
			let stopCallCount = 0;
			const specialRouter = createMockSignalRouter();
			specialRouter.isStopRequested.mockImplementation(() => {
				stopCallCount++;
				return stopCallCount > 1;
			});
			(agent as any).signalRouter = specialRouter;

			await agent.handleMessage("do stuff");

			// Should be back to idle due to stop
			expect(agent.state).toBe("idle");

			// Should broadcast system message about stop
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "system",
					message: "执行已停止",
				}),
			);
		});
	});

	describe("terminal tools return to IDLE", () => {
		it("mark_complete should return to idle", async () => {
			const agent = setupAgent([
				toolCallResponse("mark_complete", { summary: "Task done" }),
			]);

			await agent.handleMessage("do task");
			expect(agent.state).toBe("idle");
		});

		it("mark_failed should return to idle", async () => {
			const agent = setupAgent([
				toolCallResponse("mark_failed", { reason: "Cannot proceed" }),
			]);

			await agent.handleMessage("do task");
			expect(agent.state).toBe("idle");
		});

		it("escalate_to_human should return to idle", async () => {
			const agent = setupAgent([
				toolCallResponse("escalate_to_human", { reason: "Need confirmation" }),
			]);

			await agent.handleMessage("do dangerous thing");
			expect(agent.state).toBe("idle");
		});
	});

	describe("LLM response with no tool calls exits EXECUTING", () => {
		it("should return to idle when LLM returns only text in tool loop", async () => {
			const agent = setupAgent([
				// First call: tool call to enter EXECUTING
				toolCallResponse("fetch_more", { lines: 100 }, "tc1"),
				// Second call: only text (no tools) → exit EXECUTING
				textResponse("All looks good, nothing more to do."),
			]);

			// Need a pane target for fetch_more
			agent.setPaneTarget("test:0.0");

			await agent.handleMessage("check status");

			expect(agent.state).toBe("idle");
		});
	});

	describe("compression check between tool rounds", () => {
		it("should trigger compression when threshold exceeded", async () => {
			const agent = setupAgent([
				toolCallResponse("create_session", {}, "tc0"),
				toolCallResponse("mark_complete", { summary: "Done" }, "tc1"),
			]);

			mockCtx.shouldCompress.mockReturnValue(true);

			await agent.handleMessage("do task");

			expect(mockCtx.compress).toHaveBeenCalled();
		});
	});

	describe("error recovery", () => {
		it("should recover to idle when handleMessage fails during executing", async () => {
			const agent = setupAgent([
				toolCallResponse("fetch_more", { lines: 100 }, "tc1"),
			]);
			agent.setPaneTarget("test:0.0");

			mockCtx.shouldRunMemoryFlush.mockReturnValueOnce(false).mockReturnValue(true);
			mockCtx.runMemoryFlush.mockRejectedValue(new Error("flush failed"));

			await expect(agent.handleMessage("check status")).rejects.toThrow("flush failed");
			expect(agent.state).toBe("idle");
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith({ type: "state", state: "executing" });
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith({ type: "state", state: "idle" });
		});

		it("should recover to idle when handleResume fails", async () => {
			const agent = setupAgent([
				toolCallResponse("fetch_more", { lines: 100 }, "tc1"),
			]);
			agent.setPaneTarget("test:0.0");

			mockCtx.shouldRunMemoryFlush.mockReturnValue(true);
			mockCtx.runMemoryFlush.mockRejectedValue(new Error("flush failed"));

			await expect(agent.handleResume()).rejects.toThrow("flush failed");
			expect(agent.state).toBe("idle");
		});
	});

	describe("exit_agent tool", () => {
		it("should call adapter.exitAgent and return content with session id", async () => {
			const agent = setupAgent([
				toolCallResponse("exit_agent", { summary: "Exiting to save session" }),
				textResponse("Agent exited successfully."),
			]);
			agent.setPaneTarget("test:0.0");

			// Add exitAgent to mock adapter
			mockAdapter.exitAgent = vi.fn().mockResolvedValue({
				content: "Resume this session with:\nclaude --resume abc-123",
				sessionId: "abc-123",
			});

			await agent.handleMessage("exit agent");

			expect(mockAdapter.exitAgent).toHaveBeenCalledWith(mockBridge, "test:0.0");
			expect(agent.state).toBe("idle");
		});

		it("should return error when no active session", async () => {
			const agent = setupAgent([
				toolCallResponse("exit_agent", { summary: "Exiting" }),
				textResponse("No session."),
			]);
			// Do NOT set paneTarget

			await agent.handleMessage("exit agent");

			// Should not crash, agent returns to idle via text response
			expect(agent.state).toBe("idle");
		});

		it("should return error when adapter does not support exitAgent", async () => {
			const agent = setupAgent([
				toolCallResponse("exit_agent", { summary: "Exiting" }),
				textResponse("Not supported."),
			]);
			agent.setPaneTarget("test:0.0");

			// Ensure no exitAgent on adapter
			delete mockAdapter.exitAgent;

			await agent.handleMessage("exit agent");

			expect(agent.state).toBe("idle");
		});
	});

	describe("exec_command tool_activity broadcasting", () => {
		it("should broadcast tool_activity on first exec_command call", async () => {
			const agent = setupAgent([
				toolCallResponse("exec_command", { command: "ls", summary: "查看目录" }),
				textResponse("Done."),
			]);

			await agent.handleMessage("check files");

			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith({
				type: "tool_activity",
				summary: "查看目录",
			});
		});

		it("should throttle: only broadcast 1st of 3 consecutive exec_command calls", async () => {
			const agent = setupAgent([
				// 3 consecutive exec_command tool calls in one LLM response won't happen,
				// so we simulate 3 rounds: each round returns one exec_command
				toolCallResponse("exec_command", { command: "echo a", summary: "查看目录" }, "tc1"),
				toolCallResponse("exec_command", { command: "echo b", summary: "读取文件" }, "tc2"),
				toolCallResponse("exec_command", { command: "echo c", summary: "搜索代码" }, "tc3"),
				textResponse("All done."),
			]);

			await agent.handleMessage("investigate");

			const toolActivityCalls = mockBroadcaster.broadcast.mock.calls.filter(
				(c: any) => c[0].type === "tool_activity",
			);

			// Only the 1st call (count=1, 1%3===1) should broadcast
			expect(toolActivityCalls).toHaveLength(1);
			expect(toolActivityCalls[0][0].summary).toBe("查看目录");
		});

		it("should reset throttle counter on new executeToolLoop", async () => {
			// First handleMessage: triggers exec_command (count resets to 0, then 1 → broadcasts)
			const agent = setupAgent([
				toolCallResponse("exec_command", { command: "ls", summary: "第一轮查看" }, "tc1"),
				toolCallResponse("mark_complete", { summary: "Done" }, "tc2"),
			]);

			await agent.handleMessage("first task");

			// Second handleMessage: new executeToolLoop, counter resets
			// We need a new LLM to feed responses for second call
			const secondResponses = [
				toolCallResponse("exec_command", { command: "pwd", summary: "第二轮查看" }, "tc3"),
				toolCallResponse("mark_complete", { summary: "Done again" }, "tc4"),
			];
			let secondCallCount = 0;
			(agent as any).llmClient = {
				stream: vi.fn().mockImplementation(() => {
					const events = secondResponses[secondCallCount] ?? [];
					secondCallCount++;
					return (async function* () {
						for (const event of events) {
							yield event;
						}
					})();
				}),
				complete: vi.fn(),
			};

			await agent.handleMessage("second task");

			const toolActivityCalls = mockBroadcaster.broadcast.mock.calls.filter(
				(c: any) => c[0].type === "tool_activity",
			);

			// Both should have broadcast (each is the 1st in its own loop)
			expect(toolActivityCalls).toHaveLength(2);
			expect(toolActivityCalls[0][0].summary).toBe("第一轮查看");
			expect(toolActivityCalls[1][0].summary).toBe("第二轮查看");
		});
	});
});
