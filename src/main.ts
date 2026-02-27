#!/usr/bin/env node

import { join } from "node:path";
import chalk from "chalk";
import type { AgentAdapter } from "./agents/adapter.js";
import { ClaudeCodeAdapter } from "./agents/claude-code.js";
import { parseCliArgs, printHelp, printVersion } from "./cli.js";
import { ContextManager } from "./core/context-manager.js";
import { MainAgent } from "./core/main-agent.js";
import { Session } from "./core/session.js";
import { SignalRouter } from "./core/signal-router.js";
import { runDoctor } from "./doctor/run.js";
import { LLMClient } from "./llm/client.js";
import { PromptLoader } from "./llm/prompt-loader.js";
import { getAllProviders } from "./llm/providers/registry.js";
import { createEmbeddingProvider } from "./memory/embedder.js";
import { MemoryStore } from "./memory/store.js";
import { syncMemoryFiles } from "./memory/sync.js";
import { discoverSkills } from "./skills/discovery.js";
import { filterSkills } from "./skills/filter.js";
import { buildCapabilitiesSummary } from "./skills/injector.js";
import { SkillRegistry } from "./skills/registry.js";
import { TmuxBridge } from "./tmux/bridge.js";
import { StateDetector } from "./tmux/state-detector.js";
import { runConfigTUI } from "./tui/config-app.js";
import { ensureConfigDir, ensureProjectStorageDir, getProjectStorageDir, loadConfig } from "./utils/config.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
	const args = parseCliArgs();

	if (args.help) {
		printHelp();
		process.exit(0);
	}

	if (args.version) {
		printVersion();
		process.exit(0);
	}

	if (args.goal === "config") {
		await runConfigTUI();
		process.exit(0);
	}

	if (args.goal === "doctor") {
		await runDoctor();
		return;
	}

	if (args.listProviders) {
		console.log("Available LLM providers:\n");
		for (const p of getAllProviders()) {
			const envHint = process.env[p.apiKeyEnvVar] ? chalk.green("(key set)") : chalk.dim(`(${p.apiKeyEnvVar})`);
			console.log(`  ${chalk.bold(p.name.padEnd(15))} ${p.displayName.padEnd(20)} ${envHint}`);
			if (p.models?.length) {
				console.log(`  ${"".padEnd(15)} ${chalk.dim(`Models: ${p.models.join(", ")}`)}`);
			}
		}
		process.exit(0);
	}

	// Handle "remember" subcommand
	if (args.rememberText !== undefined) {
		if (args.rememberText) {
			const rememberStorageDir = getProjectStorageDir(args.cwd);
			const dbPath = join(rememberStorageDir, "memory.sqlite");
			const store = new MemoryStore({
				dbPath,
				workspaceDir: args.cwd,
				storageDir: rememberStorageDir,
				vectorEnabled: false,
			});
			await store.write({ path: "memory/core.md", content: `\n- ${args.rememberText}` });
			store.close();
			console.log(`${chalk.green("Remembered:")} ${args.rememberText}`);
		} else {
			console.error(chalk.yellow("Please provide text to remember."));
			console.error('Usage: clipilot remember "your note here"');
			process.exit(1);
		}
		process.exit(0);
	}

	// Handle "init" subcommand
	if (args.isInit) {
		const { mkdir, writeFile, access } = await import("node:fs/promises");
		const clipilotDir = join(args.cwd, ".clipilot");
		const dirs = [join(clipilotDir, "skills"), join(clipilotDir, "prompts")];
		let created = 0;
		for (const dir of dirs) {
			await mkdir(dir, { recursive: true });
			const gitkeep = join(dir, ".gitkeep");
			try {
				await access(gitkeep);
			} catch {
				await writeFile(gitkeep, "", "utf-8");
				created++;
			}
		}
		if (created > 0) {
			console.log(chalk.green("Initialized CLIPilot project directories:"));
		} else {
			console.log(chalk.dim("CLIPilot project directories already exist:"));
		}
		console.log(`  ${clipilotDir}/skills/`);
		console.log(`  ${clipilotDir}/prompts/`);
		process.exit(0);
	}

	// ─── Phase 1: Bootstrap ──────────────────────────────

	await ensureConfigDir();
	await logger.init();

	const config = await loadConfig();

	console.log(`${chalk.bold("CLIPilot")} v0.1.0\n`);

	// Check prerequisites
	const bridge = new TmuxBridge();
	const tmuxInstalled = await bridge.checkInstalled();
	if (!tmuxInstalled) {
		console.error(chalk.red("Error: tmux is not installed. Please install tmux first."));
		console.error("  macOS: brew install tmux");
		console.error("  Ubuntu: sudo apt install tmux");
		process.exit(1);
	}

	const tmuxVersion = await bridge.getVersion();
	logger.info("main", `tmux version: ${tmuxVersion}`);

	// Get goal
	const goal = args.goal;
	if (!goal) {
		console.error(chalk.yellow("No goal specified. Please provide a development goal."));
		console.error('Usage: clipilot "your development goal here"');
		process.exit(1);
	}

	// Initialize LLM client
	const llmProvider = args.provider || config.llm.provider;
	const llmModel = args.model || config.llm.model;
	const llmBaseUrl = args.baseUrl || config.llm.baseUrl;
	const llmApiKey = config.providers?.[llmProvider]?.apiKey || config.llm.apiKey;

	const llmClient = new LLMClient({
		provider: llmProvider,
		model: llmModel,
		apiKey: llmApiKey,
		baseUrl: llmBaseUrl,
	});

	// Initialize PromptLoader
	const promptLoader = new PromptLoader();
	await promptLoader.load(args.cwd);

	// Initialize project storage directory under ~/.clipilot/projects/
	const storageDir = await ensureProjectStorageDir(args.cwd);
	logger.info("main", `Project storage: ${storageDir}`);

	// Initialize MemoryStore + Embedding Provider
	const dbPath = join(storageDir, "memory.sqlite");
	const memoryStore = new MemoryStore({
		dbPath,
		workspaceDir: args.cwd,
		storageDir,
		vectorEnabled: true,
	});

	let embeddingProvider: Awaited<ReturnType<typeof createEmbeddingProvider>>["provider"] = null;

	if (config.memory.embeddingProvider !== "none") {
		const embeddingResult = await createEmbeddingProvider({
			provider: (config.memory.embeddingProvider ?? "auto") as any,
			fallback: "none",
			model: config.memory.embeddingModel,
		});
		embeddingProvider = embeddingResult.provider;
	}
	if (embeddingProvider) {
		logger.info("main", `Embedding provider: ${embeddingProvider.id} (${embeddingProvider.model})`);
	} else {
		logger.info("main", "No embedding provider available — FTS-only mode");
	}

	// Initial memory index sync
	try {
		const syncResult = await syncMemoryFiles(memoryStore, {
			embeddingProvider,
			cache: embeddingProvider
				? { provider: embeddingProvider.id, model: embeddingProvider.model, providerKey: "default" }
				: undefined,
		});
		if (syncResult.added + syncResult.updated + syncResult.deleted > 0) {
			logger.info(
				"main",
				`Memory sync: +${syncResult.added} ~${syncResult.updated} -${syncResult.deleted} (${syncResult.chunksIndexed} chunks)`,
			);
		}
	} catch (err: any) {
		logger.warn("main", `Memory sync failed (non-fatal): ${err.message}`);
	}

	console.log(chalk.dim("Agent:    ") + args.agent);
	console.log(`${chalk.dim("Provider: ")}${llmProvider} (${llmClient.getModel()})`);
	console.log(chalk.dim("Autonomy: ") + args.autonomy);
	console.log(chalk.dim("Goal:     ") + goal);
	console.log();

	// Initialize components
	const stateDetector = new StateDetector(bridge, llmClient, config.stateDetector, promptLoader);

	// Setup agent adapters
	const agents = new Map<string, AgentAdapter>();
	const defaultAdapter = new ClaudeCodeAdapter();
	agents.set("claude-code", defaultAdapter);

	// Create session
	const session = new Session(goal, args.agent, args.autonomy);

	// Initialize ContextManager
	const contextManager = new ContextManager({
		llmClient,
		promptLoader,
		memoryStore,
		flushThreshold: config.memory.flushThreshold,
	});
	contextManager.updateModule("goal", goal);

	// Initialize Skill System: discover → filter → inject → registry
	const adapterSkillsDir = defaultAdapter.getSkillsDir?.();
	const discoveredSkills = await discoverSkills({
		adapterSkillsDir,
		workspaceDir: args.cwd,
	});
	const filteredSkills = filterSkills(discoveredSkills, { disabled: config.skills?.disabled }, args.cwd);
	const baseCapabilities =
		defaultAdapter.getBaseCapabilities?.() || "Direct code editing and file operations\nRunning terminal commands";
	const capabilitiesSummary = buildCapabilitiesSummary(baseCapabilities, filteredSkills);
	contextManager.updateModule("agent_capabilities", capabilitiesSummary);
	const skillRegistry = new SkillRegistry(filteredSkills);
	logger.info("main", `Skills loaded: ${skillRegistry.size} (${filteredSkills.map((s) => s.name).join(", ")})`);

	// Initialize SignalRouter and MainAgent
	const signalRouter = new SignalRouter(stateDetector, bridge, contextManager);

	const defaultAgentAdapter = agents.get(args.agent) ?? defaultAdapter;
	const mainAgent = new MainAgent({
		contextManager,
		signalRouter,
		llmClient,
		adapter: defaultAgentAdapter,
		bridge,
		stateDetector,
		goal,
		memoryStore,
		embeddingProvider,
		skillRegistry,
		debug: config.debug,
		searchConfig: {
			vectorWeight: config.memory.vectorWeight,
			textWeight: 1 - config.memory.vectorWeight,
			temporalDecay: {
				enabled: true,
				halfLifeDays: config.memory.decayHalfLifeDays,
			},
		},
	});

	// Log events
	mainAgent.on("goal_start", (g) => {
		console.log(chalk.cyan(`▶ Goal: ${g}`));
	});

	mainAgent.on("goal_complete", (result) => {
		console.log();
		console.log(chalk.green(`✓ Goal completed: ${result.summary}`));
	});

	mainAgent.on("goal_failed", (error) => {
		console.log(chalk.red(`✗ Goal failed: ${error}`));
	});

	mainAgent.on("need_human", (reason) => {
		console.log(chalk.yellow(`⚠ Needs attention: ${reason}`));
	});

	mainAgent.on("log", (message) => {
		console.log(chalk.dim(`  ${message}`));
	});

	// Handle Ctrl+C
	process.on("SIGINT", async () => {
		console.log(chalk.yellow("\nAborting..."));
		signalRouter.abort();
		session.setStatus("aborted");
		await session.save();
		process.exit(0);
	});

	// ─── Phase 2: Execution ──────────────────────────────

	console.log(chalk.cyan("Executing...\n"));

	if (args.dryRun) {
		console.log(chalk.yellow("(dry-run mode — not executing)"));
		await session.save();
		return;
	}

	const goalResult = await mainAgent.executeGoal(goal);

	// ─── Phase 3: Summary ────────────────────────────────

	try {
		const summaryResponse = await llmClient.complete(
			[
				{
					role: "user",
					content: `Goal: ${goal}\n\nResult: ${goalResult.success ? "SUCCESS" : "FAILED"}\nSummary: ${goalResult.summary}${goalResult.errors?.length ? `\nErrors: ${goalResult.errors.join(", ")}` : ""}`,
				},
			],
			{
				systemPrompt: promptLoader.resolve("session-summarizer"),
				temperature: 0.3,
			},
		);

		if (summaryResponse.content.trim()) {
			const dateStr = new Date().toISOString().slice(0, 10);
			await memoryStore.write({
				path: `memory/${dateStr}.md`,
				content: `\n## Session Summary\n${summaryResponse.content.trim()}`,
			});
			logger.info("main", "Session lessons recorded to memory");
		}
	} catch (err: any) {
		logger.error("main", `Failed to summarize session: ${err.message}`);
	}

	// Close MemoryStore
	memoryStore.close();

	// Save session
	session.summary = goalResult.summary;
	session.setStatus(goalResult.success ? "completed" : "failed");
	const sessionPath = await session.save();
	logger.info("main", `Session saved: ${sessionPath}`);
}

main().catch((err) => {
	console.error(chalk.red("Fatal error:"), err.message || err);
	process.exit(1);
});
