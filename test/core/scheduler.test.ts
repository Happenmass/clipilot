import { describe, it, expect, vi, beforeEach } from "vitest";
import { Scheduler } from "../../src/core/scheduler.js";
import { TaskGraph, type Task } from "../../src/core/task.js";
import type { TmuxBridge } from "../../src/tmux/bridge.js";
import type { StateDetector } from "../../src/tmux/state-detector.js";
import type { Planner } from "../../src/core/planner.js";
import type { AgentAdapter, AgentCharacteristics } from "../../src/agents/adapter.js";

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
	return {
		status: "pending",
		description: "",
		dependencies: [],
		attempts: 0,
		maxAttempts: 3,
		estimatedComplexity: "low",
		createdAt: Date.now(),
		...overrides,
	};
}

function createMockAdapter(): AgentAdapter {
	return {
		name: "mock",
		displayName: "Mock Agent",
		launch: vi.fn().mockResolvedValue("mock-session:0.0"),
		sendPrompt: vi.fn().mockResolvedValue(undefined),
		sendResponse: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn().mockResolvedValue(undefined),
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
	return {} as TmuxBridge;
}

function createMockStateDetector(): StateDetector {
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
		startMonitoring: vi.fn((_pane: string, _ctx: string) => {
			// Simulate immediate completion
			for (const cb of callbacks) {
				cb({ status: "completed", confidence: 1, detail: "done" }, ">");
			}
		}),
		stopMonitoring: vi.fn(),
		analyzeState: vi.fn(),
		deepAnalyze: vi.fn(),
		// Expose callbacks for testing
		_callbacks: callbacks,
	} as any;
}

function createMockPlanner(): Planner {
	return {
		plan: vi.fn(),
		replan: vi.fn(),
		generatePrompt: vi.fn().mockResolvedValue("Do the task"),
	} as any;
}

describe("Scheduler", () => {
	let adapter: AgentAdapter;
	let bridge: TmuxBridge;
	let stateDetector: ReturnType<typeof createMockStateDetector>;
	let planner: Planner;

	beforeEach(() => {
		adapter = createMockAdapter();
		bridge = createMockBridge();
		stateDetector = createMockStateDetector();
		planner = createMockPlanner();
	});

	it("should launch agent only once for multiple tasks", async () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "1", title: "Task 1" }));
		graph.addTask(makeTask({ id: "2", title: "Task 2" }));
		graph.addTask(makeTask({ id: "3", title: "Task 3" }));

		const agents = new Map([["mock", adapter]]);
		const scheduler = new Scheduler(
			graph,
			bridge,
			stateDetector as any,
			planner,
			agents,
			{ maxParallel: 1, autonomyLevel: "high", defaultAgent: "mock", goal: "test goal" },
		);

		await scheduler.start();

		// launch() should be called exactly once
		expect(adapter.launch).toHaveBeenCalledTimes(1);

		// sendPrompt() should be called once per task
		expect(adapter.sendPrompt).toHaveBeenCalledTimes(3);

		// All three calls should use the same paneTarget
		const calls = (adapter.sendPrompt as any).mock.calls;
		expect(calls[0][1]).toBe("mock-session:0.0");
		expect(calls[1][1]).toBe("mock-session:0.0");
		expect(calls[2][1]).toBe("mock-session:0.0");
	});

	it("should call shutdown after all tasks complete", async () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "1", title: "Task 1" }));

		const agents = new Map([["mock", adapter]]);
		const scheduler = new Scheduler(
			graph,
			bridge,
			stateDetector as any,
			planner,
			agents,
			{ maxParallel: 1, autonomyLevel: "high", defaultAgent: "mock", goal: "test goal" },
		);

		await scheduler.start();

		expect(adapter.shutdown).toHaveBeenCalledTimes(1);
		expect(adapter.shutdown).toHaveBeenCalledWith(bridge, "mock-session:0.0");
	});

	it("should set cooldown after each sendPrompt", async () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "1", title: "Task 1" }));

		const agents = new Map([["mock", adapter]]);
		const scheduler = new Scheduler(
			graph,
			bridge,
			stateDetector as any,
			planner,
			agents,
			{ maxParallel: 1, autonomyLevel: "high", defaultAgent: "mock", goal: "test goal" },
		);

		await scheduler.start();

		expect(stateDetector.setCooldown).toHaveBeenCalledWith(3000);
	});

	it("should keep pane alive after task failure", async () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "1", title: "Task 1", maxAttempts: 1 }));
		graph.addTask(makeTask({ id: "2", title: "Task 2", maxAttempts: 1 }));

		// Make first task fail (no retry since maxAttempts=1), second succeed
		let callCount = 0;
		stateDetector.startMonitoring = vi.fn((_pane: string, _ctx: string) => {
			callCount++;
			for (const cb of stateDetector._callbacks) {
				if (callCount === 1) {
					cb({ status: "error", confidence: 0.9, detail: "error occurred", suggestedAction: { type: "escalate" } }, "Error: something");
				} else {
					cb({ status: "completed", confidence: 1, detail: "done" }, ">");
				}
			}
		});

		const agents = new Map([["mock", adapter]]);
		const scheduler = new Scheduler(
			graph,
			bridge,
			stateDetector as any,
			planner,
			agents,
			{ maxParallel: 1, autonomyLevel: "high", defaultAgent: "mock", goal: "test goal" },
		);

		await scheduler.start();

		// launch still only called once despite failure
		expect(adapter.launch).toHaveBeenCalledTimes(1);
		// sendPrompt called for both tasks (first failed, second succeeded)
		expect(adapter.sendPrompt).toHaveBeenCalledTimes(2);
	});

	it("should skip shutdown if adapter does not implement it", async () => {
		const adapterNoShutdown = createMockAdapter();
		delete (adapterNoShutdown as any).shutdown;

		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "1", title: "Task 1" }));

		const agents = new Map([["mock", adapterNoShutdown]]);
		const scheduler = new Scheduler(
			graph,
			bridge,
			stateDetector as any,
			planner,
			agents,
			{ maxParallel: 1, autonomyLevel: "high", defaultAgent: "mock", goal: "test goal" },
		);

		// Should not throw
		await scheduler.start();
		expect(graph.getTask("1")?.status).toBe("completed");
	});

	it("should trigger Layer 2 analysis when waiting_input has no value", async () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "1", title: "Task 1" }));

		// Layer 2 analyzeState returns a value for the interaction
		stateDetector.analyzeState = vi.fn().mockResolvedValue({
			status: "waiting_input",
			confidence: 0.9,
			detail: "Menu selection needed",
			suggestedAction: { type: "send_keys", value: "Enter" },
		});

		// startMonitoring emits waiting_input WITHOUT a value (Layer 1.5 style)
		// then on next poll emits completed
		let monitorCallCount = 0;
		stateDetector.startMonitoring = vi.fn((_pane: string, _ctx: string) => {
			monitorCallCount++;
			for (const cb of stateDetector._callbacks) {
				if (monitorCallCount === 1) {
					// First: waiting_input with no value
					cb(
						{ status: "waiting_input", confidence: 0.6, detail: "Agent waiting", suggestedAction: { type: "send_keys" } },
						"Do you want to proceed?\n❯ 1. Yes\n  2. No",
					);
					// Then immediately complete (simulating the response worked)
					cb({ status: "completed", confidence: 1, detail: "done" }, ">");
				} else {
					cb({ status: "completed", confidence: 1, detail: "done" }, ">");
				}
			}
		});

		const agents = new Map([["mock", adapter]]);
		const scheduler = new Scheduler(
			graph,
			bridge,
			stateDetector as any,
			planner,
			agents,
			{ maxParallel: 1, autonomyLevel: "high", defaultAgent: "mock", goal: "test goal" },
		);

		await scheduler.start();

		// analyzeState should have been called (Layer 2 triggered)
		expect(stateDetector.analyzeState).toHaveBeenCalled();
		// sendResponse should have been called with the LLM-provided value
		expect(adapter.sendResponse).toHaveBeenCalledWith(bridge, "mock-session:0.0", "Enter");
		// cooldown should be set after sendResponse
		expect(stateDetector.setCooldown).toHaveBeenCalledWith(3000);
	});

	it("should escalate after 3 failed waiting_input retries", async () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "1", title: "Task 1", maxAttempts: 1 }));

		// Layer 2 always returns a value but the interaction never resolves
		stateDetector.analyzeState = vi.fn().mockResolvedValue({
			status: "waiting_input",
			confidence: 0.8,
			detail: "Menu still showing",
			suggestedAction: { type: "send_keys", value: "Enter" },
		});

		// Emit waiting_input 4 times (3 retries + 1 that triggers escalation),
		// then complete to avoid hanging
		stateDetector.startMonitoring = vi.fn((_pane: string, _ctx: string) => {
			for (const cb of stateDetector._callbacks) {
				// 4 waiting_input events: first 3 get auto-responded, 4th triggers escalation
				for (let i = 0; i < 4; i++) {
					cb(
						{ status: "waiting_input", confidence: 0.6, detail: "Still waiting", suggestedAction: { type: "send_keys" } },
						"Menu prompt",
					);
				}
				// Finally complete to resolve the promise
				cb({ status: "completed", confidence: 1, detail: "done" }, ">");
			}
		});

		const needHumanSpy = vi.fn();
		const agents = new Map([["mock", adapter]]);
		const scheduler = new Scheduler(
			graph,
			bridge,
			stateDetector as any,
			planner,
			agents,
			{ maxParallel: 1, autonomyLevel: "high", defaultAgent: "mock", goal: "test goal" },
		);
		scheduler.on("need_human", needHumanSpy);

		await scheduler.start();

		// sendResponse should be called exactly 3 times (the limit)
		expect(adapter.sendResponse).toHaveBeenCalledTimes(3);
		// need_human should have been emitted for the 4th attempt
		expect(needHumanSpy).toHaveBeenCalled();
		const reason = needHumanSpy.mock.calls[0][1];
		expect(reason).toContain("3");
	});
});
