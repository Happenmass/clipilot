import type { MemoryCategory } from "./types.js";

// ─── Category Mapping ───────────────────────────────────

const KNOWN_CATEGORY_FILES: Record<string, MemoryCategory> = {
	"memory/core.md": "core",
	"memory/preferences.md": "preferences",
	"memory/people.md": "people",
	"memory/todos.md": "todos",
};

const DATE_PATTERN = /^memory\/\d{4}-\d{2}-\d{2}\.md$/;
const LEGACY_FILES = new Set(["MEMORY.md", "memory.md"]);

/**
 * Infer memory category from file path without additional metadata.
 *
 * Mapping:
 * - memory/core.md → "core"
 * - memory/preferences.md → "preferences"
 * - memory/people.md → "people"
 * - memory/todos.md → "todos"
 * - memory/YYYY-MM-DD.md → "daily"
 * - MEMORY.md / memory.md → "legacy"
 * - Other memory/*.md → "topic"
 */
export function categoryFromPath(relPath: string): MemoryCategory {
	const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");

	// Legacy root files
	if (LEGACY_FILES.has(normalized)) return "legacy";

	// Known category files
	const known = KNOWN_CATEGORY_FILES[normalized];
	if (known) return known;

	// Date-named files
	if (DATE_PATTERN.test(normalized)) return "daily";

	// Any other memory/*.md → topic
	if (normalized.startsWith("memory/") && normalized.endsWith(".md")) return "topic";

	// Fallback (should not normally reach here if isMemoryPath was checked)
	return "topic";
}

/**
 * Check if a category is evergreen (no temporal decay applied).
 * Only "daily" category is subject to temporal decay.
 */
export function isEvergreenCategory(category: MemoryCategory): boolean {
	return category !== "daily";
}

/**
 * Build a SQL path filter for a given category.
 * Returns an array of path patterns to use in WHERE clause.
 *
 * For "daily" category, returns all date-named paths from the tracked files.
 * For known categories, returns the exact file path.
 * For "topic", returns all non-known, non-date paths.
 */
export function buildCategoryPathFilter(
	category: MemoryCategory,
	trackedPaths: string[],
): string[] {
	switch (category) {
		case "core":
			return ["memory/core.md"];
		case "preferences":
			return ["memory/preferences.md"];
		case "people":
			return ["memory/people.md"];
		case "todos":
			return ["memory/todos.md"];
		case "legacy":
			return ["MEMORY.md", "memory.md"];
		case "daily":
			return trackedPaths.filter((p) => DATE_PATTERN.test(p));
		case "topic":
			return trackedPaths.filter((p) => {
				if (!p.startsWith("memory/") || !p.endsWith(".md")) return false;
				if (KNOWN_CATEGORY_FILES[p]) return false;
				if (DATE_PATTERN.test(p)) return false;
				return true;
			});
		default:
			return [];
	}
}
