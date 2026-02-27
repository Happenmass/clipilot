import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import type { SkillEntry } from "./types.js";

export interface SkillFilterConfig {
	disabled?: string[];
}

/**
 * Filter skills based on config disable list and when-conditions.
 * Order: disable list first, then when-conditions.
 */
export function filterSkills(skills: SkillEntry[], config: SkillFilterConfig, workspaceDir: string): SkillEntry[] {
	const disabledSet = new Set(config.disabled ?? []);

	return skills.filter((skill) => {
		// 1. Config disable list (checked first)
		if (disabledSet.has(skill.name)) {
			return false;
		}

		// 2. When-conditions
		if (skill.when) {
			if (!evaluateWhenCondition(skill.when, workspaceDir)) {
				return false;
			}
		}

		return true;
	});
}

function evaluateWhenCondition(when: NonNullable<SkillEntry["when"]>, workspaceDir: string): boolean {
	// All specified conditions must pass

	if (when.files && when.files.length > 0) {
		for (const file of when.files) {
			if (!existsSync(join(workspaceDir, file))) {
				return false;
			}
		}
	}

	if (when.os && when.os.length > 0) {
		if (!when.os.includes(platform())) {
			return false;
		}
	}

	if (when.env && when.env.length > 0) {
		for (const envVar of when.env) {
			if (!process.env[envVar]) {
				return false;
			}
		}
	}

	return true;
}
