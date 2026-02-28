import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandRouter } from "../../src/server/command-router.js";

function createMockMainAgent(state: "idle" | "executing" = "idle") {
	return {
		state,
		handleMessage: vi.fn().mockResolvedValue(undefined),
		handleResume: vi.fn().mockResolvedValue(undefined),
	} as any;
}

function createMockSignalRouter() {
	return {
		stop: vi.fn(),
		resume: vi.fn(),
		isStopRequested: vi.fn().mockReturnValue(false),
	} as any;
}

function createMockContextManager() {
	return {
		clear: vi.fn().mockResolvedValue(undefined),
	} as any;
}

function createMockBroadcaster() {
	return {
		broadcast: vi.fn(),
	} as any;
}

describe("CommandRouter", () => {
	let mockAgent: ReturnType<typeof createMockMainAgent>;
	let mockRouter: ReturnType<typeof createMockSignalRouter>;
	let mockCtx: ReturnType<typeof createMockContextManager>;
	let mockBroadcaster: ReturnType<typeof createMockBroadcaster>;
	let commandRouter: CommandRouter;

	function setup(agentState: "idle" | "executing" = "idle") {
		mockAgent = createMockMainAgent(agentState);
		mockRouter = createMockSignalRouter();
		mockCtx = createMockContextManager();
		mockBroadcaster = createMockBroadcaster();
		commandRouter = new CommandRouter({
			mainAgent: mockAgent,
			signalRouter: mockRouter,
			contextManager: mockCtx,
			broadcaster: mockBroadcaster,
		});
	}

	describe("/stop", () => {
		it("should call signalRouter.stop() when executing", async () => {
			setup("executing");
			await commandRouter.handle("stop");
			expect(mockRouter.stop).toHaveBeenCalled();
		});

		it("should broadcast message when not executing", async () => {
			setup("idle");
			await commandRouter.handle("stop");
			expect(mockRouter.stop).not.toHaveBeenCalled();
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "当前未在执行任务" }),
			);
		});
	});

	describe("/resume", () => {
		it("should call mainAgent.handleResume() when idle", async () => {
			setup("idle");
			await commandRouter.handle("resume");
			expect(mockAgent.handleResume).toHaveBeenCalled();
		});

		it("should broadcast message when already executing", async () => {
			setup("executing");
			await commandRouter.handle("resume");
			expect(mockAgent.handleResume).not.toHaveBeenCalled();
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "当前已在执行中" }),
			);
		});
	});

	describe("/clear", () => {
		it("should clear context and broadcast clear event when idle", async () => {
			setup("idle");
			await commandRouter.handle("clear");
			expect(mockCtx.clear).toHaveBeenCalled();
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith({ type: "clear" });
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "对话已清空" }),
			);
		});

		it("should stop first then clear when executing", async () => {
			setup("executing");
			await commandRouter.handle("clear");
			expect(mockRouter.stop).toHaveBeenCalled();
			expect(mockCtx.clear).toHaveBeenCalled();
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith({ type: "clear" });
		});
	});

	describe("unknown command", () => {
		it("should broadcast unknown command message", async () => {
			setup("idle");
			await commandRouter.handle("unknown");
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "未知指令: /unknown" }),
			);
		});
	});
});
