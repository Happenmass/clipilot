import type Database from "better-sqlite3";

export type ExecutionPhase = "planned" | "settled" | "persisted";

export type ExecutionVerificationStatus = "verified" | "unverified" | "insufficient_evidence";

export interface ExecutionPaneSnippet {
	content: string;
	ansiContent?: string;
	lines: number;
	capturedAt: number;
}

export interface ExecutionWorkspaceEvidence {
	workingDir: string;
	available: boolean;
	changedFiles: string[];
	diffStat?: string;
	diffSummary?: string[];
}

export interface ExecutionPersistenceEvidence {
	memoryWrites: string[];
	agentResumeId?: string;
	agentResumable?: boolean;
	conversationPersisted: boolean;
}

export interface ExecutionTestEvidence {
	status: "passed" | "failed" | "unknown" | "not_run";
	summary: string;
	command?: string;
}

export interface ExecutionVerificationEvidence {
	status: ExecutionVerificationStatus;
	summary: string;
}

export interface ExecutionEvent {
	id: string;
	runId: string;
	phase: ExecutionPhase;
	toolName: string;
	summary?: string;
	workspace?: ExecutionWorkspaceEvidence;
	pane?: ExecutionPaneSnippet;
	persistence?: ExecutionPersistenceEvidence;
	test?: ExecutionTestEvidence;
	verification?: ExecutionVerificationEvidence;
	createdAt: number;
}

interface ExecutionEventRow {
	event_json: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	run_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	event_json TEXT NOT NULL
);
`;

export interface ExecutionEventStoreOptions {
	maxEvents?: number;
	db?: Database.Database;
}

export class ExecutionEventStore {
	private events: ExecutionEvent[] = [];
	private maxEvents: number;
	private db: Database.Database | null;

	constructor(options: number | ExecutionEventStoreOptions = 100) {
		if (typeof options === "number") {
			this.maxEvents = options;
			this.db = null;
			return;
		}

		this.maxEvents = options.maxEvents ?? 100;
		this.db = options.db ?? null;
		if (this.db) {
			this.db.exec(SCHEMA_SQL);
		}
	}

	add(event: ExecutionEvent): void {
		if (this.db) {
			this.db
				.prepare("INSERT OR REPLACE INTO execution_events (id, run_id, created_at, event_json) VALUES (?, ?, ?, ?)")
				.run(event.id, event.runId, event.createdAt, JSON.stringify(event));

			// Keep only the newest N events.
			this.db
				.prepare(
					`
DELETE FROM execution_events
WHERE seq NOT IN (
	SELECT seq FROM execution_events ORDER BY seq DESC LIMIT ?
)
`,
				)
				.run(this.maxEvents);
			return;
		}

		this.events.push(event);
		if (this.events.length > this.maxEvents) {
			this.events.splice(0, this.events.length - this.maxEvents);
		}
	}

	listRecent(limit = 50): ExecutionEvent[] {
		const safeLimit = Math.max(0, Math.floor(limit));
		if (this.db) {
			const rows = this.db
				.prepare("SELECT event_json FROM execution_events ORDER BY seq DESC LIMIT ?")
				.all(safeLimit) as ExecutionEventRow[];
			return rows
				.reverse()
				.map((row) => {
					try {
						return JSON.parse(row.event_json) as ExecutionEvent;
					} catch {
						return null;
					}
				})
				.filter((event): event is ExecutionEvent => Boolean(event));
		}

		return this.events.slice(-limit);
	}

	clear(): void {
		if (this.db) {
			this.db.exec("DELETE FROM execution_events");
			return;
		}

		this.events = [];
	}
}
