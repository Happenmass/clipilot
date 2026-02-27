import { describe, it, expect } from "vitest";
import { parseSkillFile } from "../../src/skills/parser.js";

describe("parseSkillFile", () => {
	it("should parse valid frontmatter with all fields", () => {
		const content = `---
name: openspec
description: "Spec-driven development workflow"
type: agent-capability
commands: [/opsx:new, /opsx:ff, /opsx:apply]
when:
  files: [".openspec.yaml"]
  os: ["darwin", "linux"]
  env: ["EDITOR"]
---

# OpenSpec Skill

Detailed instructions here.`;

		const { frontmatter, body } = parseSkillFile(content);

		expect(frontmatter.name).toBe("openspec");
		expect(frontmatter.description).toBe("Spec-driven development workflow");
		expect(frontmatter.type).toBe("agent-capability");
		expect(frontmatter.commands).toEqual(["/opsx:new", "/opsx:ff", "/opsx:apply"]);
		expect(frontmatter.when).toEqual({
			files: [".openspec.yaml"],
			os: ["darwin", "linux"],
			env: ["EDITOR"],
		});
		expect(body).toBe("# OpenSpec Skill\n\nDetailed instructions here.");
	});

	it("should handle missing frontmatter", () => {
		const content = "# Just a Markdown File\n\nNo frontmatter here.";

		const { frontmatter, body } = parseSkillFile(content);

		expect(frontmatter).toEqual({});
		expect(body).toBe("# Just a Markdown File\n\nNo frontmatter here.");
	});

	it("should handle malformed frontmatter (no closing ---)", () => {
		const content = "---\nname: broken\nThis never ends";

		const { frontmatter, body } = parseSkillFile(content);

		expect(frontmatter).toEqual({});
		expect(body).toBe("---\nname: broken\nThis never ends");
	});

	it("should handle empty frontmatter", () => {
		const content = "---\n---\n\n# Body";

		const { frontmatter, body } = parseSkillFile(content);

		expect(frontmatter).toEqual({});
		expect(body).toBe("# Body");
	});

	it("should parse block-style commands", () => {
		const content = `---
name: test
type: agent-capability
commands:
  - /cmd:one
  - /cmd:two
  - /cmd:three
---

Body`;

		const { frontmatter } = parseSkillFile(content);

		expect(frontmatter.commands).toEqual(["/cmd:one", "/cmd:two", "/cmd:three"]);
	});

	it("should parse inline commands with quotes", () => {
		const content = `---
name: test
type: agent-capability
commands: ["/cmd:one", "/cmd:two"]
---

Body`;

		const { frontmatter } = parseSkillFile(content);

		expect(frontmatter.commands).toEqual(["/cmd:one", "/cmd:two"]);
	});

	it("should ignore invalid type values", () => {
		const content = `---
name: test
type: invalid-type
---

Body`;

		const { frontmatter } = parseSkillFile(content);

		expect(frontmatter.type).toBeUndefined();
		expect(frontmatter.name).toBe("test");
	});

	it("should parse all three valid types", () => {
		for (const type of ["agent-capability", "main-agent-tool", "prompt-enrichment"]) {
			const content = `---\ntype: ${type}\n---\nBody`;
			const { frontmatter } = parseSkillFile(content);
			expect(frontmatter.type).toBe(type);
		}
	});

	it("should parse tool block for main-agent-tool", () => {
		const content = `---
name: risk-analyzer
type: main-agent-tool
tool:
  name: analyze_risk
  description: "Analyze task risk level"
  parameters: {"type":"object","properties":{"task":{"type":"string"}},"required":["task"]}
---

Instructions for risk analysis.`;

		const { frontmatter } = parseSkillFile(content);

		expect(frontmatter.tool).toBeDefined();
		expect(frontmatter.tool!.name).toBe("analyze_risk");
		expect(frontmatter.tool!.description).toBe("Analyze task risk level");
		expect(frontmatter.tool!.parameters.properties).toHaveProperty("task");
	});

	it("should handle tool block with missing required fields", () => {
		const content = `---
name: broken-tool
type: main-agent-tool
tool:
  name: only-name
---

Body`;

		const { frontmatter } = parseSkillFile(content);

		expect(frontmatter.tool).toBeNull();
	});

	it("should handle when block with partial conditions", () => {
		const content = `---
name: test
when:
  os: ["darwin"]
---

Body`;

		const { frontmatter } = parseSkillFile(content);

		expect(frontmatter.when).toEqual({ os: ["darwin"] });
	});

	it("should handle Windows line endings", () => {
		const content = "---\r\nname: test\r\ntype: agent-capability\r\n---\r\n\r\nBody";

		const { frontmatter, body } = parseSkillFile(content);

		expect(frontmatter.name).toBe("test");
		expect(frontmatter.type).toBe("agent-capability");
		expect(body).toBe("Body");
	});

	it("should handle quoted name with single quotes", () => {
		const content = `---\nname: 'my-skill'\n---\nBody`;

		const { frontmatter } = parseSkillFile(content);

		expect(frontmatter.name).toBe("my-skill");
	});

	it("should handle empty commands array", () => {
		const content = `---\nname: test\ncommands: []\n---\nBody`;

		const { frontmatter } = parseSkillFile(content);

		expect(frontmatter.commands).toEqual([]);
	});
});
