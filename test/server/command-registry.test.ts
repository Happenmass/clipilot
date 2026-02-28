import { describe, it, expect } from "vitest";
import { CommandRegistry } from "../../src/server/command-registry.js";

describe("CommandRegistry", () => {
	it("should register and retrieve a command", () => {
		const reg = new CommandRegistry();
		reg.register({ name: "stop", description: "Stop execution", category: "builtin" });
		expect(reg.get("stop")).toBeDefined();
		expect(reg.get("stop")!.description).toBe("Stop execution");
	});

	it("should registerMany commands", () => {
		const reg = new CommandRegistry();
		reg.registerMany([
			{ name: "stop", description: "Stop", category: "builtin" },
			{ name: "clear", description: "Clear", category: "builtin" },
		]);
		expect(reg.size).toBe(2);
	});

	it("should return all commands via getAll()", () => {
		const reg = new CommandRegistry();
		reg.register({ name: "stop", description: "Stop", category: "builtin" });
		reg.register({ name: "commit", description: "Commit", category: "skill", skillName: "commit" });
		const all = reg.getAll();
		expect(all).toHaveLength(2);
		expect(all.map((c) => c.name)).toContain("stop");
		expect(all.map((c) => c.name)).toContain("commit");
	});

	it("should report has() correctly", () => {
		const reg = new CommandRegistry();
		reg.register({ name: "stop", description: "Stop", category: "builtin" });
		expect(reg.has("stop")).toBe(true);
		expect(reg.has("nope")).toBe(false);
	});

	it("should search by name substring", () => {
		const reg = new CommandRegistry();
		reg.register({ name: "stop", description: "Stop execution", category: "builtin" });
		reg.register({ name: "commit", description: "Git commit", category: "skill" });
		const results = reg.search("st");
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("stop");
	});

	it("should search by description substring", () => {
		const reg = new CommandRegistry();
		reg.register({ name: "stop", description: "Stop execution", category: "builtin" });
		reg.register({ name: "commit", description: "Git commit", category: "skill" });
		const results = reg.search("git");
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("commit");
	});

	it("should return all commands when search has no query", () => {
		const reg = new CommandRegistry();
		reg.register({ name: "stop", description: "Stop", category: "builtin" });
		reg.register({ name: "clear", description: "Clear", category: "builtin" });
		expect(reg.search()).toHaveLength(2);
		expect(reg.search(undefined)).toHaveLength(2);
	});

	it("should return empty array when search has no matches", () => {
		const reg = new CommandRegistry();
		reg.register({ name: "stop", description: "Stop", category: "builtin" });
		expect(reg.search("zzz")).toHaveLength(0);
	});

	it("should overwrite command with same name on re-register", () => {
		const reg = new CommandRegistry();
		reg.register({ name: "stop", description: "Old", category: "builtin" });
		reg.register({ name: "stop", description: "New", category: "builtin" });
		expect(reg.size).toBe(1);
		expect(reg.get("stop")!.description).toBe("New");
	});

	it("should track size correctly", () => {
		const reg = new CommandRegistry();
		expect(reg.size).toBe(0);
		reg.register({ name: "a", description: "A", category: "builtin" });
		expect(reg.size).toBe(1);
		reg.register({ name: "b", description: "B", category: "skill" });
		expect(reg.size).toBe(2);
	});
});
