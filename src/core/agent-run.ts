import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentRunsDir } from "../utils/config.js";
import type { LogEntry } from "../utils/logger.js";

export type AgentRunStatus = "executing" | "paused" | "completed" | "failed" | "aborted";

export interface AgentRunData {
	id: string;
	goal: string;
	status: AgentRunStatus;
	agentType: string;
	summary?: string;
	logs: LogEntry[];
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
}

export class AgentRun {
	id: string;
	goal: string;
	status: AgentRunStatus;
	agentType: string;
	summary?: string;
	logs: LogEntry[] = [];
	startedAt: number;
	updatedAt: number;
	completedAt?: number;

	constructor(goal: string, agentType: string) {
		this.id = randomUUID().split("-")[0];
		this.goal = goal;
		this.status = "executing";
		this.agentType = agentType;
		this.startedAt = Date.now();
		this.updatedAt = Date.now();
	}

	addLog(entry: LogEntry): void {
		this.logs.push(entry);
		this.updatedAt = Date.now();
	}

	setStatus(status: AgentRunStatus): void {
		this.status = status;
		this.updatedAt = Date.now();
		if (status === "completed" || status === "failed" || status === "aborted") {
			this.completedAt = Date.now();
		}
	}

	async save(): Promise<string> {
		const agentRunsDir = await getAgentRunsDir();
		const agentRunDir = join(agentRunsDir, this.id);
		await mkdir(agentRunDir, { recursive: true });

		const filePath = join(agentRunDir, "state.json");
		const data: AgentRunData = {
			id: this.id,
			goal: this.goal,
			status: this.status,
			agentType: this.agentType,
			summary: this.summary,
			logs: this.logs,
			startedAt: this.startedAt,
			updatedAt: this.updatedAt,
			completedAt: this.completedAt,
		};

		await writeFile(filePath, JSON.stringify(data, null, "\t"), "utf-8");
		return filePath;
	}

	static async load(runId: string): Promise<AgentRun> {
		const agentRunsDir = await getAgentRunsDir();
		const filePath = join(agentRunsDir, runId, "state.json");
		const raw = await readFile(filePath, "utf-8");
		const data: AgentRunData = JSON.parse(raw);

		const agentRun = new AgentRun(data.goal, data.agentType);
		agentRun.id = data.id;
		agentRun.status = data.status;
		agentRun.summary = data.summary;
		agentRun.logs = data.logs;
		agentRun.startedAt = data.startedAt;
		agentRun.updatedAt = data.updatedAt;
		agentRun.completedAt = data.completedAt;

		return agentRun;
	}
}
