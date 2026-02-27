import type { SkillEntry } from "./types.js";

const MAX_SUMMARY_CHARS = 2000;

/**
 * Build the agent capabilities summary for prompt injection.
 * Only includes agent-capability and prompt-enrichment skills (not main-agent-tool).
 */
export function buildCapabilitiesSummary(baseCapabilities: string, skills: SkillEntry[]): string {
	const parts: string[] = [];

	// Base capabilities
	parts.push("The coding agent you control supports:");
	for (const line of baseCapabilities.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) {
			parts.push(`- ${trimmed}`);
		}
	}

	// Filter to injectable skill types
	const injectable = skills.filter((s) => s.type === "agent-capability" || s.type === "prompt-enrichment");

	if (injectable.length === 0) {
		return parts.join("\n");
	}

	parts.push("");
	parts.push("### Available Skills");
	parts.push("");

	// Build skill entries with budget awareness
	const header = parts.join("\n");
	let remaining = MAX_SUMMARY_CHARS - header.length;
	let includedCount = 0;

	for (const skill of injectable) {
		const entry = formatSkillEntry(skill);
		if (remaining - entry.length < 0) {
			break;
		}
		parts.push(entry);
		remaining -= entry.length;
		includedCount++;
	}

	// Add truncation notice if not all skills included
	const truncated = injectable.length - includedCount;
	if (truncated > 0) {
		parts.push(`(${truncated} more skills available via read_skill)`);
	}

	return parts.join("\n");
}

function formatSkillEntry(skill: SkillEntry): string {
	const lines: string[] = [];

	lines.push(`**${skill.name}** — ${skill.description}`);

	if (skill.commands.length > 0) {
		lines.push(`  Commands: ${skill.commands.join(", ")}`);
	}

	lines.push(`  Use \`read_skill("${skill.name}")\` for detailed usage.`);
	lines.push("");

	return lines.join("\n");
}
