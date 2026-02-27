import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectStorageDir } from "../../src/utils/config.js";

describe("getProjectStorageDir", () => {
	it("returns path under ~/.clipilot/projects/ with basename-hash format", () => {
		const dir = getProjectStorageDir("/Users/test/code/myapp");
		const configDir = join(homedir(), ".clipilot");
		expect(dir.startsWith(join(configDir, "projects"))).toBe(true);
		expect(dir).toMatch(/myapp-[a-f0-9]{6}$/);
	});

	it("produces stable output for same input", () => {
		const a = getProjectStorageDir("/Users/test/code/myapp");
		const b = getProjectStorageDir("/Users/test/code/myapp");
		expect(a).toBe(b);
	});

	it("produces different ids for same-name projects in different paths", () => {
		const a = getProjectStorageDir("/Users/test/work/api");
		const b = getProjectStorageDir("/Users/test/personal/api");
		expect(a).not.toBe(b);
		// Both should start with "api-" but have different hashes
		expect(basename(a)).toMatch(/^api-/);
		expect(basename(b)).toMatch(/^api-/);
	});

	it("uses lowercase basename", () => {
		const dir = getProjectStorageDir("/Users/test/code/MyApp");
		expect(basename(dir)).toMatch(/^myapp-/);
	});

	it("generates correct hash from absolute path", () => {
		const projectDir = "/Users/test/code/myapp";
		const absPath = resolve(projectDir);
		const expectedHash = createHash("sha256").update(absPath).digest("hex").slice(0, 6);
		const dir = getProjectStorageDir(projectDir);
		expect(basename(dir)).toBe(`myapp-${expectedHash}`);
	});
});
