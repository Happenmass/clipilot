import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseSkillFile } from "./parser.js";
import type { SkillEntry, SkillSource } from "./types.js";

const MAX_FILE_SIZE = 100 * 1024; // 100KB

export interface ReadSkillResult {
	entry: SkillEntry;
}

export interface ReadSkillError {
	error: string;
	dirPath: string;
}

/**
 * Read and parse a single SKILL.md from a skill directory.
 * Returns a fully populated SkillEntry or an error.
 */
export async function readSkillDir(dirPath: string, source: SkillSource): Promise<ReadSkillResult | ReadSkillError> {
	const filePath = join(dirPath, "SKILL.md");
	const dirName = basename(dirPath);

	try {
		const fileStat = await stat(filePath);
		if (fileStat.size > MAX_FILE_SIZE) {
			return { error: `SKILL.md exceeds ${MAX_FILE_SIZE / 1024}KB limit`, dirPath };
		}

		const content = await readFile(filePath, "utf-8");
		const { frontmatter, body } = parseSkillFile(content);

		const entry: SkillEntry = {
			name: frontmatter.name || dirName,
			description: frontmatter.description || extractFirstParagraph(body),
			type: frontmatter.type || "agent-capability",
			commands: frontmatter.commands || [],
			when: frontmatter.when ?? null,
			tool: frontmatter.tool ?? null,
			source,
			filePath,
			dirPath,
			body,
		};

		return { entry };
	} catch (err: any) {
		if (err.code === "ENOENT") {
			return { error: `SKILL.md not found in ${dirName}`, dirPath };
		}
		return { error: `Failed to read SKILL.md: ${err.message}`, dirPath };
	}
}

/** Extract the first non-empty paragraph from markdown body as description fallback */
function extractFirstParagraph(body: string): string {
	const lines = body.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		// Skip headings and empty lines
		if (trimmed && !trimmed.startsWith("#")) {
			return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
		}
	}
	return "";
}
