import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills } from "../../src/skills/discovery.js";

let tmpDir: string;

const SKILL_CONTENT = (name: string, type = "agent-capability") =>
	`---\nname: ${name}\ntype: ${type}\ndescription: "${name} skill"\ncommands: [/${name}]\n---\n\n# ${name}\n\nBody of ${name}.`;

describe("discoverSkills", () => {
	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "clipilot-discovery-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should discover skills from adapter directory", async () => {
		const adapterDir = join(tmpDir, "adapter-skills");
		await mkdir(join(adapterDir, "openspec"), { recursive: true });
		await writeFile(join(adapterDir, "openspec", "SKILL.md"), SKILL_CONTENT("openspec"));

		const skills = await discoverSkills({ adapterSkillsDir: adapterDir });

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("openspec");
		expect(skills[0].source).toBe("adapter");
	});

	it("should discover skills from workspace directory", async () => {
		const workspaceDir = tmpDir;
		await mkdir(join(workspaceDir, ".clipilot", "skills", "custom"), { recursive: true });
		await writeFile(join(workspaceDir, ".clipilot", "skills", "custom", "SKILL.md"), SKILL_CONTENT("custom"));

		const skills = await discoverSkills({ workspaceDir });

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("custom");
		expect(skills[0].source).toBe("workspace");
	});

	it("should discover from both sources", async () => {
		const adapterDir = join(tmpDir, "adapter-skills");
		const workspaceDir = tmpDir;

		await mkdir(join(adapterDir, "openspec"), { recursive: true });
		await writeFile(join(adapterDir, "openspec", "SKILL.md"), SKILL_CONTENT("openspec"));

		await mkdir(join(workspaceDir, ".clipilot", "skills", "custom"), { recursive: true });
		await writeFile(join(workspaceDir, ".clipilot", "skills", "custom", "SKILL.md"), SKILL_CONTENT("custom"));

		const skills = await discoverSkills({ adapterSkillsDir: adapterDir, workspaceDir });

		expect(skills).toHaveLength(2);
		const names = skills.map((s) => s.name).sort();
		expect(names).toEqual(["custom", "openspec"]);
	});

	it("should override adapter skill with workspace skill of same name", async () => {
		const adapterDir = join(tmpDir, "adapter-skills");
		const workspaceDir = tmpDir;

		await mkdir(join(adapterDir, "commit"), { recursive: true });
		await writeFile(
			join(adapterDir, "commit", "SKILL.md"),
			`---\nname: commit\ntype: agent-capability\ndescription: "adapter commit"\n---\nAdapter body`,
		);

		await mkdir(join(workspaceDir, ".clipilot", "skills", "commit"), { recursive: true });
		await writeFile(
			join(workspaceDir, ".clipilot", "skills", "commit", "SKILL.md"),
			`---\nname: commit\ntype: agent-capability\ndescription: "workspace commit"\n---\nWorkspace body`,
		);

		const skills = await discoverSkills({ adapterSkillsDir: adapterDir, workspaceDir });

		expect(skills).toHaveLength(1);
		expect(skills[0].description).toBe("workspace commit");
		expect(skills[0].source).toBe("workspace");
	});

	it("should handle missing adapter directory", async () => {
		const skills = await discoverSkills({ adapterSkillsDir: "/nonexistent/path" });
		expect(skills).toHaveLength(0);
	});

	it("should handle missing workspace skills directory", async () => {
		const skills = await discoverSkills({ workspaceDir: "/nonexistent/workspace" });
		expect(skills).toHaveLength(0);
	});

	it("should skip directories without SKILL.md", async () => {
		const adapterDir = join(tmpDir, "adapter-skills");
		await mkdir(join(adapterDir, "valid"), { recursive: true });
		await writeFile(join(adapterDir, "valid", "SKILL.md"), SKILL_CONTENT("valid"));
		await mkdir(join(adapterDir, "broken"), { recursive: true });
		// No SKILL.md in broken/

		const skills = await discoverSkills({ adapterSkillsDir: adapterDir });

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("valid");
	});

	it("should skip oversized SKILL.md files", async () => {
		const adapterDir = join(tmpDir, "adapter-skills");
		await mkdir(join(adapterDir, "large"), { recursive: true });
		await writeFile(join(adapterDir, "large", "SKILL.md"), "x".repeat(101 * 1024));
		await mkdir(join(adapterDir, "normal"), { recursive: true });
		await writeFile(join(adapterDir, "normal", "SKILL.md"), SKILL_CONTENT("normal"));

		const skills = await discoverSkills({ adapterSkillsDir: adapterDir });

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("normal");
	});

	it("should handle empty directories", async () => {
		const adapterDir = join(tmpDir, "empty-adapter");
		await mkdir(adapterDir, { recursive: true });

		const skills = await discoverSkills({ adapterSkillsDir: adapterDir });
		expect(skills).toHaveLength(0);
	});

	it("should handle no options provided", async () => {
		const skills = await discoverSkills({});
		expect(skills).toHaveLength(0);
	});
});
