import type { WebSocket } from "ws";
import { logger } from "../utils/logger.js";

export interface ChatMessage {
	type: string;
	[key: string]: any;
}

/**
 * Manages WebSocket client connections and broadcasts messages to all clients.
 */
export class ChatBroadcaster {
	private clients: Set<WebSocket> = new Set();

	addClient(ws: WebSocket): void {
		this.clients.add(ws);
		logger.info("chat-broadcaster", `Client connected (total: ${this.clients.size})`);
	}

	removeClient(ws: WebSocket): void {
		this.clients.delete(ws);
		logger.info("chat-broadcaster", `Client disconnected (total: ${this.clients.size})`);
	}

	/** Max buffered bytes before a stalled client is terminated (1 MB) */
	private static readonly MAX_BUFFERED_AMOUNT = 1024 * 1024;

	broadcast(message: ChatMessage): void {
		const data = JSON.stringify(message);
		for (const client of this.clients) {
			if (client.readyState === 1) {
				// WebSocket.OPEN — skip or terminate if backpressure is too high
				if (client.bufferedAmount > ChatBroadcaster.MAX_BUFFERED_AMOUNT) {
					logger.warn("chat-broadcaster", `Terminating stalled client (buffered: ${client.bufferedAmount})`);
					client.terminate();
					this.clients.delete(client);
					continue;
				}
				client.send(data);
			} else {
				// Prune non-OPEN clients
				this.clients.delete(client);
			}
		}
	}

	getClientCount(): number {
		return this.clients.size;
	}
}
