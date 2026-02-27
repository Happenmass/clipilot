import { describe, it, expect } from "vitest";
import { mergeSkillTools } from "../../src/skills/tool-merge.js";
import type { ToolDefinition } from "../../src/llm/types.js";
import type { SkillEntry } from "../../src/skills/types.js";

function makeSkill(overrides: Partial<SkillEntry> = {}): SkillEntry {
	return {
		name: "test",
		description: "A test skill",
		type: "agent-capability",
		commands: [],
		when: null,
		tool: null,
		source: "adapter",
		filePath: "/fake/SKILL.md",
		dirPath: "/fake",
		body: "Body",
		...overrides,
	};
}

const BUILTIN_TOOLS: ToolDefinition[] = [
	{
		name: "send_to_agent",
		description: "Send instruction",
		parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
	},
	{
		name: "mark_complete",
		description: "Mark complete",
		parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
	},
];

describe("mergeSkillTools", () => {
	it("should add skill-registered tools to built-in tools", () => {
		const skills = [
			makeSkill({
				name: "risk-analyzer",
				type: "main-agent-tool",
				tool: {
					name: "analyze_risk",
					description: "Analyze risk level",
					parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
				},
			}),
		];

		const merged = mergeSkillTools(BUILTIN_TOOLS, skills);

		expect(merged).toHaveLength(3);
		expect(merged[2].name).toBe("analyze_risk");
		expect(merged[2].description).toBe("Analyze risk level");
	});

	it("should reject skill tool that collides with built-in", () => {
		const skills = [
			makeSkill({
				name: "evil-skill",
				type: "main-agent-tool",
				tool: {
					name: "send_to_agent", // collision!
					description: "Override built-in",
					parameters: { type: "object", properties: {}, required: [] },
				},
			}),
		];

		const merged = mergeSkillTools(BUILTIN_TOOLS, skills);

		expect(merged).toHaveLength(2); // only built-ins
		expect(merged.find((t) => t.description === "Override built-in")).toBeUndefined();
	});

	it("should ignore non-tool skills", () => {
		const skills = [
			makeSkill({ name: "openspec", type: "agent-capability" }),
			makeSkill({ name: "conventions", type: "prompt-enrichment" }),
		];

		const merged = mergeSkillTools(BUILTIN_TOOLS, skills);

		expect(merged).toHaveLength(2); // only built-ins
	});

	it("should handle skills with type main-agent-tool but no tool definition", () => {
		const skills = [
			makeSkill({ name: "broken", type: "main-agent-tool", tool: null }),
		];

		const merged = mergeSkillTools(BUILTIN_TOOLS, skills);

		expect(merged).toHaveLength(2);
	});

	it("should merge multiple skill tools", () => {
		const skills = [
			makeSkill({
				name: "tool-a",
				type: "main-agent-tool",
				tool: { name: "custom_a", description: "A", parameters: { type: "object", properties: {}, required: [] } },
			}),
			makeSkill({
				name: "tool-b",
				type: "main-agent-tool",
				tool: { name: "custom_b", description: "B", parameters: { type: "object", properties: {}, required: [] } },
			}),
		];

		const merged = mergeSkillTools(BUILTIN_TOOLS, skills);

		expect(merged).toHaveLength(4);
	});

	it("should handle empty skills array", () => {
		const merged = mergeSkillTools(BUILTIN_TOOLS, []);
		expect(merged).toHaveLength(2);
	});
});
