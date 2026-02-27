import type { ToolDefinition } from "../llm/types.js";

export type SkillType = "agent-capability" | "main-agent-tool" | "prompt-enrichment";

export type SkillSource = "adapter" | "workspace";

export interface WhenCondition {
	/** Files that must exist in the workspace */
	files?: string[];
	/** Allowed operating systems */
	os?: string[];
	/** Environment variables that must be set */
	env?: string[];
}

export interface SkillToolDef {
	name: string;
	description: string;
	parameters: ToolDefinition["parameters"];
}

export interface SkillFrontmatter {
	name: string;
	description: string;
	type: SkillType;
	commands: string[];
	when: WhenCondition | null;
	tool: SkillToolDef | null;
}

export interface SkillEntry {
	/** Skill identifier (from frontmatter or directory name) */
	name: string;
	/** Short description for prompt injection */
	description: string;
	/** Skill type */
	type: SkillType;
	/** Associated slash commands */
	commands: string[];
	/** Eligibility conditions */
	when: WhenCondition | null;
	/** Tool definition for main-agent-tool type */
	tool: SkillToolDef | null;
	/** Which source this skill came from */
	source: SkillSource;
	/** Absolute path to SKILL.md */
	filePath: string;
	/** Absolute path to skill directory */
	dirPath: string;
	/** Markdown body content (frontmatter stripped) */
	body: string;
}
