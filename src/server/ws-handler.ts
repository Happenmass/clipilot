import type { WebSocket } from "ws";
import type { MainAgent } from "../core/main-agent.js";
import type { ChatBroadcaster } from "./chat-broadcaster.js";
import type { CommandRouter } from "./command-router.js";
import { logger } from "../utils/logger.js";

/**
 * Handles a single WebSocket connection:
 * - Registers client with ChatBroadcaster
 * - Sends current state on connect
 * - Routes incoming messages to MainAgent or CommandRouter
 * - Cleans up on disconnect
 */
export function handleWebSocket(
	ws: WebSocket,
	opts: {
		mainAgent: MainAgent;
		broadcaster: ChatBroadcaster;
		commandRouter: CommandRouter;
	},
): void {
	const { mainAgent, broadcaster, commandRouter } = opts;

	// Register client
	broadcaster.addClient(ws);

	// Send current state on connect
	ws.send(JSON.stringify({ type: "state", state: mainAgent.state }));

	ws.on("message", async (data) => {
		let parsed: any;
		try {
			parsed = JSON.parse(data.toString());
		} catch {
			logger.warn("ws-handler", `Invalid JSON received: ${data.toString().slice(0, 200)}`);
			return;
		}

		if (!parsed.type) {
			logger.warn("ws-handler", "Message missing type field");
			return;
		}

		switch (parsed.type) {
			case "message": {
				const content = parsed.content as string;
				if (!content || typeof content !== "string") {
					logger.warn("ws-handler", "Message missing content field");
					return;
				}
				// Fire-and-forget: handleMessage manages its own lifecycle
				mainAgent.handleMessage(content).catch((err) => {
					logger.error("ws-handler", `handleMessage error: ${err.message}`);
					broadcaster.broadcast({
						type: "system",
						message: `处理消息时出错: ${err.message}`,
					});
				});
				break;
			}

			case "command": {
				const name = parsed.name as string;
				if (!name || typeof name !== "string") {
					logger.warn("ws-handler", "Command missing name field");
					return;
				}
				commandRouter.handle(name).catch((err) => {
					logger.error("ws-handler", `Command error: ${err.message}`);
					broadcaster.broadcast({
						type: "system",
						message: `指令执行出错: ${err.message}`,
					});
				});
				break;
			}

			default:
				logger.warn("ws-handler", `Unknown message type: ${parsed.type}`);
		}
	});

	ws.on("close", () => {
		broadcaster.removeClient(ws);
	});

	ws.on("error", (err) => {
		logger.error("ws-handler", `WebSocket error: ${err.message}`);
		broadcaster.removeClient(ws);
	});
}
