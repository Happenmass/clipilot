#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";
import type { AgentAdapter } from "./agents/adapter.js";
import { ClaudeCodeAdapter } from "./agents/claude-code.js";
import { parseCliArgs, printHelp, printVersion } from "./cli.js";
import { join } from "node:path";
import { ContextManager } from "./core/context-manager.js";
import { MainAgent } from "./core/main-agent.js";
import { Planner } from "./core/planner.js";
import { Scheduler } from "./core/scheduler.js";
import { Session } from "./core/session.js";
import { SignalRouter } from "./core/signal-router.js";
import { LLMClient } from "./llm/client.js";
import { PromptLoader } from "./llm/prompt-loader.js";
import { getAllProviders } from "./llm/providers/registry.js";
import { createEmbeddingProvider } from "./memory/embedder.js";
import { MemoryStore } from "./memory/store.js";
import { syncMemoryFiles } from "./memory/sync.js";
import { TmuxBridge } from "./tmux/bridge.js";
import { StateDetector } from "./tmux/state-detector.js";
import { runDoctor } from "./doctor/run.js";
import { runConfigTUI } from "./tui/config-app.js";
import { ensureConfigDir, loadConfig } from "./utils/config.js";
import { logger } from "./utils/logger.js";

const execFileAsync = promisify(execFile);

async function gatherProjectContext(
	cwd: string,
): Promise<{ projectInfo?: string; fileTree?: string; recentGitLog?: string }> {
	const context: { projectInfo?: string; fileTree?: string; recentGitLog?: string } = {};

	// Try to read README
	try {
		const { readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const readme = await readFile(join(cwd, "README.md"), "utf-8");
		context.projectInfo = readme.substring(0, 2000);
	} catch {
		// No README
	}

	// Try to get file tree
	try {
		const { stdout } = await execFileAsync(
			"find",
			[
				cwd,
				"-type",
				"f",
				"-not",
				"-path",
				"*/node_modules/*",
				"-not",
				"-path",
				"*/.git/*",
				"-not",
				"-path",
				"*/dist/*",
			],
			{
				timeout: 5000,
				maxBuffer: 1024 * 100,
			},
		);
		const files = stdout.trim().split("\n").slice(0, 50);
		context.fileTree = files.map((f) => f.replace(cwd, ".")).join("\n");
	} catch {
		// Ignore
	}

	// Try to get git log
	try {
		const { stdout } = await execFileAsync("git", ["log", "--oneline", "-10"], {
			cwd,
			timeout: 5000,
		});
		context.recentGitLog = stdout.trim();
	} catch {
		// Not a git repo
	}

	return context;
}

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
			const dbPath = join(args.cwd, ".clipilot", "memory.sqlite");
			const store = new MemoryStore({ dbPath, workspaceDir: args.cwd, vectorEnabled: false });
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

	// Initialize
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

	// Initialize MemoryStore + Embedding Provider
	const dbPath = join(args.cwd, ".clipilot", "memory.sqlite");
	const memoryStore = new MemoryStore({
		dbPath,
		workspaceDir: args.cwd,
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
	const planner = new Planner(llmClient, promptLoader);
	const stateDetector = new StateDetector(bridge, llmClient, config.stateDetector, promptLoader);

	// Setup agent adapters
	const agents = new Map<string, AgentAdapter>();
	const defaultAdapter = new ClaudeCodeAdapter();
	agents.set("claude-code", defaultAdapter);

	// Create session
	const session = new Session(goal, args.agent, args.autonomy);

	// Phase 1: Planning
	console.log(chalk.cyan("Planning..."));
	logger.info("main", `Planning for: ${goal}`);

	const projectContext = await gatherProjectContext(args.cwd);
	const taskGraph = await planner.plan(goal, projectContext);

	session.taskGraph = taskGraph;
	session.setStatus("planning");

	const progress = taskGraph.getProgress();
	console.log(chalk.green(`Plan ready: ${progress.total} tasks\n`));

	// Display plan
	for (const task of taskGraph.getAllTasks()) {
		const deps = task.dependencies.length > 0 ? chalk.dim(` (depends: ${task.dependencies.join(", ")})`) : "";
		console.log(`  ${chalk.dim(`${task.id}.`)} ${task.title}${deps}`);
	}
	console.log();

	if (args.dryRun) {
		console.log(chalk.yellow("(dry-run mode — not executing)"));
		await session.save();
		return;
	}

	// Phase 2: Execution
	console.log(chalk.cyan("Executing...\n"));
	session.setStatus("executing");

	// Initialize MainAgent and its dependencies
	const contextManager = new ContextManager({
		llmClient,
		promptLoader,
		memoryStore,
		flushThreshold: config.memory.flushThreshold,
	});
	contextManager.updateModule("goal", goal);

	const signalRouter = new SignalRouter(stateDetector, bridge, contextManager, taskGraph);

	const defaultAgentAdapter = agents.get(args.agent) ?? defaultAdapter;
	const mainAgent = new MainAgent({
		contextManager,
		signalRouter,
		llmClient,
		planner,
		adapter: defaultAgentAdapter,
		bridge,
		stateDetector,
		taskGraph,
		goal,
		memoryStore,
		embeddingProvider,
		searchConfig: {
			vectorWeight: config.memory.vectorWeight,
			textWeight: 1 - config.memory.vectorWeight,
			temporalDecay: {
				enabled: true,
				halfLifeDays: config.memory.decayHalfLifeDays,
			},
		},
	});

	const scheduler = new Scheduler(
		taskGraph,
		bridge,
		stateDetector,
		mainAgent,
		agents,
		{
			maxParallel: 1,
			autonomyLevel: args.autonomy,
			defaultAgent: args.agent,
			goal,
		},
	);

	// Log events
	scheduler.on("task_start", (task) => {
		console.log(chalk.blue(`▶ Starting: ${task.title}`));
	});

	scheduler.on("task_complete", (task, _result) => {
		console.log(chalk.green(`✓ Completed: ${task.title}`));
	});

	scheduler.on("task_failed", (task, error) => {
		console.log(chalk.red(`✗ Failed: ${task.title} — ${error}`));
	});

	scheduler.on("need_human", (task, reason) => {
		console.log(chalk.yellow(`⚠ Needs attention: ${task.title} — ${reason}`));
	});

	scheduler.on("all_complete", (finalProgress) => {
		console.log();
		console.log(chalk.bold("Execution complete:"));
		console.log(`  Completed: ${finalProgress.completed}/${finalProgress.total}`);
		if (finalProgress.failed > 0) {
			console.log(chalk.red(`  Failed: ${finalProgress.failed}`));
		}
		if (finalProgress.skipped > 0) {
			console.log(chalk.yellow(`  Skipped: ${finalProgress.skipped}`));
		}
	});

	// Handle Ctrl+C
	process.on("SIGINT", async () => {
		console.log(chalk.yellow("\nAborting..."));
		scheduler.abort();
		session.setStatus("aborted");
		await session.save();
		process.exit(0);
	});

	await scheduler.start();

	// Session summary: extract lessons learned via LLM, persist to memory
	try {
		const allTasks = taskGraph.getAllTasks();
		const taskSummary = allTasks
			.map((t) => `- [${t.status}] ${t.title}: ${t.result?.summary || "no result"}`)
			.join("\n");

		const summaryResponse = await llmClient.complete(
			[
				{
					role: "user",
					content: `Goal: ${goal}\n\nTask execution history:\n${taskSummary}`,
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
	session.setStatus(taskGraph.getProgress().failed > 0 ? "failed" : "completed");
	const sessionPath = await session.save();
	logger.info("main", `Session saved: ${sessionPath}`);
}

main().catch((err) => {
	console.error(chalk.red("Fatal error:"), err.message || err);
	process.exit(1);
});
