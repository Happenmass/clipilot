import type { SkillEntry } from "./types.js";

/**
 * In-memory registry of discovered and filtered skills.
 * Provides lookup by skill name and by registered tool name.
 */
export class SkillRegistry {
	private byName = new Map<string, SkillEntry>();
	private byToolName = new Map<string, SkillEntry>();

	constructor(skills: SkillEntry[]) {
		for (const skill of skills) {
			this.byName.set(skill.name, skill);

			if (skill.type === "main-agent-tool" && skill.tool) {
				this.byToolName.set(skill.tool.name, skill);
			}
		}
	}

	getByName(name: string): SkillEntry | undefined {
		return this.byName.get(name);
	}

	getByToolName(toolName: string): SkillEntry | undefined {
		return this.byToolName.get(toolName);
	}

	getAll(): SkillEntry[] {
		return Array.from(this.byName.values());
	}

	/** Get all skills that register as MainAgent tools */
	getToolSkills(): SkillEntry[] {
		return Array.from(this.byToolName.values());
	}

	get size(): number {
		return this.byName.size;
	}
}
