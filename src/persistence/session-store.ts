import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_sessions (
	session_id   TEXT PRIMARY KEY,
	pane_target  TEXT NOT NULL,
	working_dir  TEXT NOT NULL,
	created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

export interface PersistedSession {
	sessionId: string;
	paneTarget: string;
	workingDir: string;
	createdAt: number;
	takenOver: boolean;
}

export class SessionStore {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
		this.db.exec(SCHEMA_SQL);
		// Migrate: add taken_over column if missing (backward-compatible)
		try {
			this.db.exec("ALTER TABLE chat_sessions ADD COLUMN taken_over INTEGER NOT NULL DEFAULT 0");
		} catch {
			// Column already exists — ignore
		}
		logger.info("session-store", "Table initialized");
	}

	/**
	 * Persist (upsert) a session entry.
	 */
	saveSession(sessionId: string, entry: { paneTarget: string; workingDir: string }): void {
		this.db
			.prepare("INSERT OR REPLACE INTO chat_sessions (session_id, pane_target, working_dir) VALUES (?, ?, ?)")
			.run(sessionId, entry.paneTarget, entry.workingDir);
	}

	/**
	 * Remove a session from the store.
	 */
	deleteSession(sessionId: string): void {
		this.db.prepare("DELETE FROM chat_sessions WHERE session_id = ?").run(sessionId);
	}

	/**
	 * Update the taken_over flag for a session.
	 */
	setTakenOver(sessionId: string, takenOver: boolean): void {
		this.db.prepare("UPDATE chat_sessions SET taken_over = ? WHERE session_id = ?").run(takenOver ? 1 : 0, sessionId);
	}

	/**
	 * Load all persisted sessions ordered by creation time (oldest first).
	 */
	loadSessions(): PersistedSession[] {
		const rows = this.db
			.prepare(
				"SELECT session_id, pane_target, working_dir, created_at, taken_over FROM chat_sessions ORDER BY created_at ASC",
			)
			.all() as Array<{
			session_id: string;
			pane_target: string;
			working_dir: string;
			created_at: number;
			taken_over: number;
		}>;

		return rows.map((row) => ({
			sessionId: row.session_id,
			paneTarget: row.pane_target,
			workingDir: row.working_dir,
			createdAt: row.created_at,
			takenOver: row.taken_over === 1,
		}));
	}
}
