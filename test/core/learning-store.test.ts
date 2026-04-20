import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../../src/persistence/conversation-store.js";

describe("learning tables schema", () => {
	let tmpDir: string;
	let db: Database.Database;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-learning-schema-"));
		db = new Database(join(tmpDir, "test.sqlite"));
		db.pragma("journal_mode = WAL");
		new ConversationStore(db); // triggers schema creation
	});

	afterEach(async () => {
		db.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("creates learning_entries table", () => {
		const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_entries'").get();
		expect(row).toBeDefined();
	});

	it("creates learning_messages table with cascade delete", () => {
		const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_messages'").get();
		expect(row).toBeDefined();

		db.prepare(`INSERT INTO learning_entries
			(id, title, status, source_type, source_agents, agent_prompts, summary_json, diff_stats, diff_blob_path, created_at, updated_at)
			VALUES ('lrn_x','t','active','agent','[]','[]','{}','{}','/tmp/x.diff', 1, 1)`).run();
		db.prepare(
			`INSERT INTO learning_messages (entry_id, role, content, created_at) VALUES ('lrn_x','user','hi', 1)`,
		).run();
		db.prepare(`DELETE FROM learning_entries WHERE id='lrn_x'`).run();
		const msgCount = db.prepare(`SELECT COUNT(*) AS n FROM learning_messages WHERE entry_id='lrn_x'`).get() as {
			n: number;
		};
		expect(msgCount.n).toBe(0);
	});

	it("creates the status+updated_at index", () => {
		const row = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_learning_entries_status_updated'")
			.get();
		expect(row).toBeDefined();
	});

	it("enforces NOT NULL on required columns", () => {
		expect(() =>
			db
				.prepare(
					`INSERT INTO learning_entries (id, status, source_type, source_agents, agent_prompts, summary_json, diff_stats, diff_blob_path, created_at, updated_at)
			 VALUES ('lrn_y','active','agent','[]','[]','{}','{}','/tmp/y.diff', 1, 1)`,
				)
				.run(),
		).toThrow(/NOT NULL/i); // title is missing
	});

	it("allows memory_flushed_at to default to NULL", () => {
		db.prepare(`INSERT INTO learning_entries
			(id, title, status, source_type, source_agents, agent_prompts, summary_json, diff_stats, diff_blob_path, created_at, updated_at)
			VALUES ('lrn_z','t','active','agent','[]','[]','{}','{}','/tmp/z.diff', 1, 1)`).run();
		const row = db.prepare(`SELECT memory_flushed_at FROM learning_entries WHERE id='lrn_z'`).get() as {
			memory_flushed_at: number | null;
		};
		expect(row.memory_flushed_at).toBeNull();
	});
});
