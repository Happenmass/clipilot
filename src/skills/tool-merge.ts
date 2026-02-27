import type { ToolDefinition } from "../llm/types.js";
import { logger } from "../utils/logger.js";
import type { SkillEntry } from "./types.js";

/**
 * Extract ToolDefinitions from main-agent-tool skills and merge with built-in tools.
 * Rejects skill tools that collide with built-in tool names.
 */
export function mergeSkillTools(builtinTools: ToolDefinition[], skills: SkillEntry[]): ToolDefinition[] {
	const builtinNames = new Set(builtinTools.map((t) => t.name));
	const merged = [...builtinTools];

	for (const skill of skills) {
		if (skill.type !== "main-agent-tool" || !skill.tool) continue;

		if (builtinNames.has(skill.tool.name)) {
			logger.warn(
				"skill-tools",
				`Skill "${skill.name}" tried to register tool "${skill.tool.name}" which collides with a built-in tool. Skipping.`,
			);
			continue;
		}

		merged.push({
			name: skill.tool.name,
			description: skill.tool.description,
			parameters: skill.tool.parameters,
		});
	}

	return merged;
}
