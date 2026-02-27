import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { readSkillDir } from "./reader.js";
import type { SkillEntry } from "./types.js";

const MAX_SKILLS = 50;

export interface DiscoveryOptions {
	adapterSkillsDir?: string;
	workspaceDir?: string;
}

/**
 * Discover skills from adapter-bundled and workspace sources.
 * Workspace skills override adapter-bundled skills with the same name.
 */
export async function discoverSkills(opts: DiscoveryOptions): Promise<SkillEntry[]> {
	const merged = new Map<string, SkillEntry>();

	// Load adapter-bundled skills (low priority)
	if (opts.adapterSkillsDir) {
		const adapterSkills = await scanDirectory(opts.adapterSkillsDir, "adapter");
		for (const skill of adapterSkills) {
			merged.set(skill.name, skill);
		}
	}

	// Load workspace skills (high priority, overrides adapter)
	if (opts.workspaceDir) {
		const workspaceSkillsDir = join(opts.workspaceDir, ".clipilot", "skills");
		const workspaceSkills = await scanDirectory(workspaceSkillsDir, "workspace");
		for (const skill of workspaceSkills) {
			if (merged.has(skill.name)) {
				logger.info("skill-discovery", `Workspace skill "${skill.name}" overrides adapter skill`);
			}
			merged.set(skill.name, skill);
		}
	}

	// Enforce max skills limit
	const all = Array.from(merged.values());
	if (all.length > MAX_SKILLS) {
		logger.warn("skill-discovery", `Discovered ${all.length} skills, limiting to ${MAX_SKILLS}`);
		// Prioritize workspace skills, then adapter by alphabetical order
		const workspace = all.filter((s) => s.source === "workspace");
		const adapter = all.filter((s) => s.source === "adapter").sort((a, b) => a.name.localeCompare(b.name));
		const limited = [...workspace, ...adapter].slice(0, MAX_SKILLS);
		return limited;
	}

	return all;
}

async function scanDirectory(dir: string, source: "adapter" | "workspace"): Promise<SkillEntry[]> {
	const entries: SkillEntry[] = [];

	try {
		const dirStat = await stat(dir);
		if (!dirStat.isDirectory()) return entries;
	} catch {
		return entries; // directory doesn't exist
	}

	let items: string[];
	try {
		items = await readdir(dir);
	} catch {
		return entries;
	}

	for (const item of items) {
		const itemPath = join(dir, item);
		try {
			const itemStat = await stat(itemPath);
			if (!itemStat.isDirectory()) continue;
		} catch {
			continue;
		}

		const result = await readSkillDir(itemPath, source);
		if ("entry" in result) {
			entries.push(result.entry);
		} else {
			logger.warn("skill-discovery", `Skipping ${item}: ${result.error}`);
		}
	}

	return entries;
}
