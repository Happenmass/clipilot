import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { MainAgent } from "../core/main-agent.js";
import type { SignalRouter } from "../core/signal-router.js";
import type { ContextManager } from "../core/context-manager.js";
import type { ConversationStore } from "../persistence/conversation-store.js";
import { ChatBroadcaster } from "./chat-broadcaster.js";
import { CommandRouter } from "./command-router.js";
import { handleWebSocket } from "./ws-handler.js";
import { logger } from "../utils/logger.js";

export interface ServerOptions {
	port: number;
	mainAgent: MainAgent;
	signalRouter: SignalRouter;
	contextManager: ContextManager;
	conversationStore: ConversationStore;
	broadcaster: ChatBroadcaster;
}

export interface ServerInstance {
	close: () => Promise<void>;
	port: number;
}

/**
 * Create and start the CLIPilot HTTP + WebSocket server.
 */
export async function startServer(opts: ServerOptions): Promise<ServerInstance> {
	const { port, mainAgent, signalRouter, contextManager, conversationStore, broadcaster } = opts;

	const app = express();
	app.use(express.json());

	// ─── Static files (Chat UI) ─────────────────────────
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const webDir = join(__dirname, "..", "..", "web");
	app.use(express.static(webDir));

	// ─── REST API ───────────────────────────────────────
	app.get("/api/history", (_req, res) => {
		try {
			const messages = conversationStore.loadMessages();
			res.json(messages);
		} catch (err: any) {
			logger.error("server", `Failed to load history: ${err.message}`);
			res.status(500).json({ error: "Failed to load history" });
		}
	});

	app.get("/api/status", (_req, res) => {
		res.json({
			state: mainAgent.state,
			messageCount: conversationStore.getMessageCount(),
			clients: broadcaster.getClientCount(),
		});
	});

	// ─── HTTP server ────────────────────────────────────
	const server = createServer(app);

	// ─── WebSocket server ───────────────────────────────
	const wss = new WebSocketServer({ server, path: "/ws" });

	const commandRouter = new CommandRouter({
		mainAgent,
		signalRouter,
		contextManager,
		broadcaster,
	});

	wss.on("connection", (ws: WebSocket) => {
		handleWebSocket(ws, { mainAgent, broadcaster, commandRouter });
	});

	// ─── Start listening ────────────────────────────────
	return new Promise<ServerInstance>((resolve, reject) => {
		server.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE") {
				logger.error("server", `Port ${port} is already in use`);
				reject(new Error(`Port ${port} is already in use. Use --port to specify a different port.`));
			} else {
				reject(err);
			}
		});

		server.listen(port, () => {
			logger.info("server", `CLIPilot server running at http://localhost:${port}`);
			console.log(`CLIPilot server running at http://localhost:${port}`);

			resolve({
				port,
				close: async () => {
					// Close all WebSocket connections
					for (const client of wss.clients) {
						client.close();
					}
					wss.close();
					await new Promise<void>((res, rej) => {
						server.close((err) => (err ? rej(err) : res()));
					});
					logger.info("server", "Server shut down");
				},
			});
		});
	});
}
