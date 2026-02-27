import { describe, it, expect } from "vitest";
import { SkillRegistry } from "../../src/skills/registry.js";
import type { SkillEntry } from "../../src/skills/types.js";

function makeSkill(overrides: Partial<SkillEntry> = {}): SkillEntry {
	return {
		name: "test",
		description: "A test skill",
		type: "agent-capability",
		commands: ["/test"],
		when: null,
		tool: null,
		source: "adapter",
		filePath: "/fake/SKILL.md",
		dirPath: "/fake",
		body: "Test body",
		...overrides,
	};
}

describe("SkillRegistry", () => {
	it("should lookup skill by name", () => {
		const registry = new SkillRegistry([
			makeSkill({ name: "openspec" }),
			makeSkill({ name: "commit" }),
		]);

		expect(registry.getByName("openspec")?.name).toBe("openspec");
		expect(registry.getByName("commit")?.name).toBe("commit");
	});

	it("should return undefined for unknown name", () => {
		const registry = new SkillRegistry([makeSkill({ name: "openspec" })]);
		expect(registry.getByName("nonexistent")).toBeUndefined();
	});

	it("should lookup skill by tool name", () => {
		const registry = new SkillRegistry([
			makeSkill({
				name: "risk-analyzer",
				type: "main-agent-tool",
				tool: {
					name: "analyze_risk",
					description: "Analyze risk",
					parameters: { type: "object", properties: {}, required: [] },
				},
			}),
		]);

		expect(registry.getByToolName("analyze_risk")?.name).toBe("risk-analyzer");
	});

	it("should return undefined for unknown tool name", () => {
		const registry = new SkillRegistry([makeSkill({ name: "openspec" })]);
		expect(registry.getByToolName("nonexistent")).toBeUndefined();
	});

	it("should not index agent-capability skills by tool name", () => {
		const registry = new SkillRegistry([
			makeSkill({ name: "openspec", type: "agent-capability" }),
		]);
		expect(registry.getByToolName("openspec")).toBeUndefined();
	});

	it("should return all skills", () => {
		const registry = new SkillRegistry([
			makeSkill({ name: "a" }),
			makeSkill({ name: "b" }),
			makeSkill({ name: "c" }),
		]);
		expect(registry.getAll()).toHaveLength(3);
	});

	it("should return tool skills only", () => {
		const registry = new SkillRegistry([
			makeSkill({ name: "normal", type: "agent-capability" }),
			makeSkill({
				name: "tool-skill",
				type: "main-agent-tool",
				tool: {
					name: "custom_tool",
					description: "Custom",
					parameters: { type: "object", properties: {}, required: [] },
				},
			}),
		]);
		expect(registry.getToolSkills()).toHaveLength(1);
		expect(registry.getToolSkills()[0].name).toBe("tool-skill");
	});

	it("should report correct size", () => {
		const registry = new SkillRegistry([makeSkill({ name: "a" }), makeSkill({ name: "b" })]);
		expect(registry.size).toBe(2);
	});

	it("should handle empty skills array", () => {
		const registry = new SkillRegistry([]);
		expect(registry.size).toBe(0);
		expect(registry.getAll()).toEqual([]);
	});
});
