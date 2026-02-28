import type { ContextManager } from "../core/context-manager.js";
import type { MainAgent } from "../core/main-agent.js";
import type { SignalRouter } from "../core/signal-router.js";
import { logger } from "../utils/logger.js";
import type { ChatBroadcaster } from "./chat-broadcaster.js";
import type { CommandDescriptor, CommandRegistry } from "./command-registry.js";

/** Built-in command descriptors registered at construction time */
const BUILTIN_COMMANDS: CommandDescriptor[] = [
	{ name: "stop", description: "停止当前执行任务", category: "builtin" },
	{ name: "resume", description: "恢复上次中断的执行", category: "builtin" },
	{ name: "clear", description: "清空对话历史", category: "builtin" },
];

/**
 * Routes slash commands (/stop, /resume, /clear) to the appropriate handlers.
 * Commands are dispatched from the WebSocket handler, not through the LLM.
 */
export class CommandRouter {
	private mainAgent: MainAgent;
	private signalRouter: SignalRouter;
	private contextManager: ContextManager;
	private broadcaster: ChatBroadcaster;

	constructor(opts: {
		mainAgent: MainAgent;
		signalRouter: SignalRouter;
		contextManager: ContextManager;
		broadcaster: ChatBroadcaster;
		commandRegistry: CommandRegistry;
	}) {
		this.mainAgent = opts.mainAgent;
		this.signalRouter = opts.signalRouter;
		this.contextManager = opts.contextManager;
		this.broadcaster = opts.broadcaster;

		// Register built-in commands into the central registry
		opts.commandRegistry.registerMany(BUILTIN_COMMANDS);
	}

	async handle(name: string): Promise<void> {
		logger.info("command-router", `Handling command: /${name}`);

		switch (name) {
			case "stop":
				return this.handleStop();
			case "resume":
				return this.handleResume();
			case "clear":
				return this.handleClear();
			default:
				this.broadcaster.broadcast({
					type: "system",
					message: `未知指令: /${name}`,
				});
		}
	}

	private handleStop(): void {
		if (this.mainAgent.state !== "executing") {
			this.broadcaster.broadcast({
				type: "system",
				message: "当前未在执行任务",
			});
			return;
		}
		this.signalRouter.stop();
		// The MainAgent's executeToolLoop will check isStopRequested between rounds
	}

	private async handleResume(): Promise<void> {
		if (this.mainAgent.state === "executing") {
			this.broadcaster.broadcast({
				type: "system",
				message: "当前已在执行中",
			});
			return;
		}
		await this.mainAgent.handleResume();
	}

	private async handleClear(): Promise<void> {
		// Stop first if executing
		if (this.mainAgent.state === "executing") {
			this.signalRouter.stop();
			// Wait briefly for the loop to exit
			await new Promise((resolve) => setTimeout(resolve, 200));
		}

		// Clear context (runs memory flush → clears memory → clears SQLite)
		await this.contextManager.clear();

		// Broadcast clear event to all clients
		this.broadcaster.broadcast({ type: "clear" });
		this.broadcaster.broadcast({
			type: "system",
			message: "对话已清空",
		});

		logger.info("command-router", "Conversation cleared");
	}
}
