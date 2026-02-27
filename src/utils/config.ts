import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface LLMConfig {
	provider: string;
	model: string;
	apiKey?: string;
	baseUrl?: string;
}

export interface ProviderKeyConfig {
	[providerName: string]: {
		apiKey?: string;
		baseUrl?: string;
	};
}

export interface StateDetectorConfig {
	pollIntervalMs: number;
	stableThresholdMs: number;
	captureLines: number;
}

export interface TmuxConfig {
	sessionPrefix: string;
}

export interface MemoryConfig {
	/** Embedding provider: "auto" | "local" | "openai" | "gemini" | "voyage" | "mistral" | "none" */
	embeddingProvider: string;
	/** Embedding model override (provider-specific). If omitted, uses provider default. */
	embeddingModel?: string;
	/** Maximum tokens per chunk when indexing markdown files. Default 400. */
	chunkTokens: number;
	/** Overlap tokens between adjacent chunks. Default 50. */
	chunkOverlap: number;
	/** Hybrid search vector weight (0-1). Keyword weight = 1 - vectorWeight. Default 0.7. */
	vectorWeight: number;
	/** Minimum score threshold for search results (0-1). Default 0.1. */
	minScore: number;
	/** Maximum number of search results to return. Default 10. */
	topK: number;
	/** Temporal decay half-life in days for date-named files. Default 30. */
	decayHalfLifeDays: number;
	/** Context window flush threshold ratio. Default 0.6. */
	flushThreshold: number;
}

export interface SkillsConfig {
	/** Skill names to disable (won't be loaded even if discovered) */
	disabled: string[];
}

export interface CLIPilotConfig {
	defaultAgent: string;
	autonomyLevel: string;
	debug: boolean;
	llm: LLMConfig;
	providers?: ProviderKeyConfig;
	stateDetector: StateDetectorConfig;
	tmux: TmuxConfig;
	memory: MemoryConfig;
	skills: SkillsConfig;
}

const CONFIG_DIR = join(homedir(), ".clipilot");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: CLIPilotConfig = {
	defaultAgent: "claude-code",
	autonomyLevel: "medium",
	debug: false,
	llm: {
		provider: "anthropic",
		model: "claude-sonnet-4-5-20250929",
	},
	stateDetector: {
		pollIntervalMs: 2000,
		stableThresholdMs: 10000,
		captureLines: 50,
	},
	tmux: {
		sessionPrefix: "clipilot",
	},
	memory: {
		embeddingProvider: "auto",
		chunkTokens: 400,
		chunkOverlap: 50,
		vectorWeight: 0.7,
		minScore: 0.1,
		topK: 10,
		decayHalfLifeDays: 30,
		flushThreshold: 0.6,
	},
	skills: {
		disabled: [],
	},
};

export function getConfigDir(): string {
	return CONFIG_DIR;
}

export function getConfigFilePath(): string {
	return CONFIG_FILE;
}

export async function ensureConfigDir(): Promise<void> {
	await mkdir(CONFIG_DIR, { recursive: true });
}

export async function loadConfig(): Promise<CLIPilotConfig> {
	if (!existsSync(CONFIG_FILE)) {
		return { ...DEFAULT_CONFIG };
	}

	try {
		const raw = await readFile(CONFIG_FILE, "utf-8");
		const userConfig = JSON.parse(raw);

		// Deep merge with defaults
		return {
			...DEFAULT_CONFIG,
			...userConfig,
			llm: { ...DEFAULT_CONFIG.llm, ...userConfig.llm },
			stateDetector: { ...DEFAULT_CONFIG.stateDetector, ...userConfig.stateDetector },
			tmux: { ...DEFAULT_CONFIG.tmux, ...userConfig.tmux },
			memory: { ...DEFAULT_CONFIG.memory, ...userConfig.memory },
			skills: { ...DEFAULT_CONFIG.skills, ...userConfig.skills },
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export async function saveConfig(config: CLIPilotConfig): Promise<void> {
	await ensureConfigDir();
	await writeFile(CONFIG_FILE, JSON.stringify(config, null, "\t"), "utf-8");
}

export async function getSessionsDir(): Promise<string> {
	const dir = join(CONFIG_DIR, "sessions");
	await mkdir(dir, { recursive: true });
	return dir;
}

export async function getLogsDir(): Promise<string> {
	const dir = join(CONFIG_DIR, "logs");
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Generate a deterministic project storage directory path.
 * Format: {basename}-{first 6 chars of sha256(absolutePath)}
 */
export function getProjectStorageDir(projectDir: string): string {
	const absPath = resolve(projectDir);
	const name = basename(absPath).toLowerCase();
	const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 6);
	return join(CONFIG_DIR, "projects", `${name}-${hash}`);
}

/**
 * Ensure the project storage directory exists and return its path.
 */
export async function ensureProjectStorageDir(projectDir: string): Promise<string> {
	const dir = getProjectStorageDir(projectDir);
	await mkdir(dir, { recursive: true });
	return dir;
}
