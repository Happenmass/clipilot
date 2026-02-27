import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSessionsDir } from "../utils/config.js";
import type { LogEntry } from "../utils/logger.js";

export type SessionStatus = "executing" | "paused" | "completed" | "failed" | "aborted";

export interface SessionData {
	id: string;
	goal: string;
	status: SessionStatus;
	agentType: string;
	autonomyLevel: string;
	summary?: string;
	logs: LogEntry[];
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
}

export class Session {
	id: string;
	goal: string;
	status: SessionStatus;
	agentType: string;
	autonomyLevel: string;
	summary?: string;
	logs: LogEntry[] = [];
	startedAt: number;
	updatedAt: number;
	completedAt?: number;

	constructor(goal: string, agentType: string, autonomyLevel: string) {
		this.id = randomUUID().split("-")[0];
		this.goal = goal;
		this.status = "executing";
		this.agentType = agentType;
		this.autonomyLevel = autonomyLevel;
		this.startedAt = Date.now();
		this.updatedAt = Date.now();
	}

	addLog(entry: LogEntry): void {
		this.logs.push(entry);
		this.updatedAt = Date.now();
	}

	setStatus(status: SessionStatus): void {
		this.status = status;
		this.updatedAt = Date.now();
		if (status === "completed" || status === "failed" || status === "aborted") {
			this.completedAt = Date.now();
		}
	}

	async save(): Promise<string> {
		const sessionsDir = await getSessionsDir();
		const sessionDir = join(sessionsDir, this.id);
		await mkdir(sessionDir, { recursive: true });

		const filePath = join(sessionDir, "state.json");
		const data: SessionData = {
			id: this.id,
			goal: this.goal,
			status: this.status,
			agentType: this.agentType,
			autonomyLevel: this.autonomyLevel,
			summary: this.summary,
			logs: this.logs,
			startedAt: this.startedAt,
			updatedAt: this.updatedAt,
			completedAt: this.completedAt,
		};

		await writeFile(filePath, JSON.stringify(data, null, "\t"), "utf-8");
		return filePath;
	}

	static async load(sessionId: string): Promise<Session> {
		const sessionsDir = await getSessionsDir();
		const filePath = join(sessionsDir, sessionId, "state.json");
		const raw = await readFile(filePath, "utf-8");
		const data: SessionData = JSON.parse(raw);

		const session = new Session(data.goal, data.agentType, data.autonomyLevel);
		session.id = data.id;
		session.status = data.status;
		session.summary = data.summary;
		session.logs = data.logs;
		session.startedAt = data.startedAt;
		session.updatedAt = data.updatedAt;
		session.completedAt = data.completedAt;

		return session;
	}
}
