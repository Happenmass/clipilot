#!/usr/bin/env node

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { ClaudeCodeAdapter } from "./agents/claude-code.js";
import { parseCliArgs, printHelp, printVersion } from "./cli.js";
import { ContextManager } from "./core/context-manager.js";
import { MainAgent } from "./core/main-agent.js";
import { SignalRouter } from "./core/signal-router.js";
import { runDoctor } from "./doctor/run.js";
import { LLMClient } from "./llm/client.js";
import { PromptLoader } from "./llm/prompt-loader.js";
import { getAllProviders } from "./llm/providers/registry.js";
import { createEmbeddingProvider } from "./memory/embedder.js";
import { MemoryStore } from "./memory/store.js";
import { syncMemoryFiles } from "./memory/sync.js";
import { ConversationStore } from "./persistence/conversation-store.js";
import { ChatBroadcaster } from "./server/chat-broadcaster.js";
import { ExecutionEventStore } from "./server/execution-events.js";
import { CommandRegistry } from "./server/command-registry.js";
import { startServer } from "./server/index.js";
import { discoverSkills } from "./skills/discovery.js";
import { filterSkills } from "./skills/filter.js";
import { buildCapabilitiesSummary } from "./skills/injector.js";
import { SkillRegistry } from "./skills/registry.js";
import { TmuxBridge } from "./tmux/bridge.js";
import { StateDetector } from "./tmux/state-detector.js";
import { runConfigTUI } from "./tui/config-app.js";
import {
	clearServerRuntimeState,
	ensureConfigDir,
	getLogsDir,
	ensureProjectStorageDir,
	getGlobalDbPath,
	getProjectId,
	getProjectStorageDir,
	loadServerRuntimeState,
	loadConfig,
	saveServerRuntimeState,
	type ServerRuntimeState,
} from "./utils/config.js";
import { logger } from "./utils/logger.js";

function createMemorySyncRunner(params: {
	memoryStore: MemoryStore;
	embeddingProvider: Awaited<ReturnType<typeof createEmbeddingProvider>>["provider"];
	config: Awaited<ReturnType<typeof loadConfig>>;
}): () => Promise<void> {
	let inFlight: Promise<void> | null = null;

	return async () => {
		if (!params.memoryStore.isDirty()) return;
		if (inFlight) {
			await inFlight;
			return;
		}

		inFlight = (async () => {
			if (!params.memoryStore.isDirty()) return;
			const syncResult = await syncMemoryFiles(params.memoryStore, {
				chunking: {
					tokens: params.config.memory.chunkTokens,
					overlap: params.config.memory.chunkOverlap,
				},
				embeddingProvider: params.embeddingProvider,
				cache: params.embeddingProvider
					? { provider: params.embeddingProvider.id, model: params.embeddingProvider.model, providerKey: "default" }
					: undefined,
			});

			if (syncResult.added + syncResult.updated + syncResult.deleted > 0) {
				logger.info(
					"main",
					`Memory sync: +${syncResult.added} ~${syncResult.updated} -${syncResult.deleted} (${syncResult.chunksIndexed} chunks)`,
				);
			}
		})();

		try {
			await inFlight;
		} finally {
			inFlight = null;
		}
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}

	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		if (err?.code === "EPERM") {
			// Process exists but we do not have permission to signal it.
			return true;
		}
		return false;
	}
}

async function getActiveServerState(): Promise<ServerRuntimeState | null> {
	const state = await loadServerRuntimeState();
	if (!state) {
		return null;
	}

	if (!isProcessRunning(state.pid)) {
		await clearServerRuntimeState();
		return null;
	}

	return state;
}

function buildDaemonChildArgs(args: ReturnType<typeof parseCliArgs>): string[] {
	const childArgs = [process.argv[1], "serve", "--agent", args.agent, "--host", args.host, "--port", String(args.port), "--cwd", args.cwd];

	if (args.provider) {
		childArgs.push("--provider", args.provider);
	}
	if (args.model) {
		childArgs.push("--model", args.model);
	}
	if (args.baseUrl) {
		childArgs.push("--base-url", args.baseUrl);
	}

	return childArgs;
}

async function waitForServerState(pid: number, timeoutMs = 10000): Promise<ServerRuntimeState | null> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const state = await loadServerRuntimeState();
		if (state && state.pid === pid) {
			return state;
		}
		if (!isProcessRunning(pid)) {
			return null;
		}
		await sleep(200);
	}

	return null;
}

async function handleStartCommand(args: ReturnType<typeof parseCliArgs>): Promise<void> {
	await ensureConfigDir();

	const running = await getActiveServerState();
	if (running) {
		console.log(`CLIPilot is already running: ${running.url}`);
		return;
	}

	const logsDir = await getLogsDir();
	const logFile = join(logsDir, "server.log");
	const fd = openSync(logFile, "a");

	try {
		const child = spawn(process.execPath, buildDaemonChildArgs(args), {
			detached: true,
			stdio: ["ignore", fd, fd],
			env: {
				...process.env,
				CLIPILOT_DAEMON: "1",
			},
		});

		child.unref();

		if (!child.pid) {
			console.error("Failed to launch CLIPilot background process.");
			process.exit(1);
		}

		const state = await waitForServerState(child.pid);
		if (state) {
			console.log(`CLIPilot started in background: ${state.url}`);
			console.log(`Log file: ${logFile}`);
			return;
		}

		if (isProcessRunning(child.pid)) {
			const fallbackUrl = `http://${args.host}:${args.port}`;
			console.log(`CLIPilot started in background: ${fallbackUrl}`);
			console.log(`Log file: ${logFile}`);
			return;
		}

		console.error(`Failed to start CLIPilot. See logs: ${logFile}`);
		process.exit(1);
	} finally {
		closeSync(fd);
	}
}

async function handleStopCommand(): Promise<void> {
	await ensureConfigDir();

	const state = await loadServerRuntimeState();
	if (!state) {
		console.log("CLIPilot is not running.");
		return;
	}

	if (!isProcessRunning(state.pid)) {
		await clearServerRuntimeState();
		console.log("CLIPilot is not running (cleared stale state).");
		return;
	}

	try {
		process.kill(state.pid, "SIGTERM");
	} catch (err: any) {
		if (err?.code === "ESRCH") {
			await clearServerRuntimeState();
			console.log("CLIPilot is not running (cleared stale state).");
			return;
		}
		throw err;
	}

	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		if (!isProcessRunning(state.pid)) {
			await clearServerRuntimeState();
			console.log(`Stopped CLIPilot: ${state.url}`);
			return;
		}
		await sleep(200);
	}

	try {
		process.kill(state.pid, "SIGKILL");
	} catch (err: any) {
		if (err?.code !== "ESRCH") {
			throw err;
		}
	}

	await clearServerRuntimeState();
	console.log(`Stopped CLIPilot (forced): ${state.url}`);
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

	if (args.subcommand === "config") {
		await runConfigTUI();
		process.exit(0);
	}

	if (args.subcommand === "doctor") {
		await runDoctor();
		return;
	}

	if (args.subcommand === "start") {
		await handleStartCommand(args);
		return;
	}

	if (args.subcommand === "stop") {
		await handleStopCommand();
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
			const store = new MemoryStore({
				dbPath: getGlobalDbPath(),
				projectId: getProjectId(args.cwd),
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

	// ─── Default: Start Server ──────────────────────────
	const isDaemonProcess = process.env.CLIPILOT_DAEMON === "1";

	await ensureConfigDir();
	await logger.init();

	const config = await loadConfig();

	console.log(`${chalk.bold("CLIPilot")} v0.2.0\n`);

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
	const projectId = getProjectId(args.cwd);
	logger.info("main", `Project: ${projectId}, storage: ${storageDir}`);

	// Initialize MemoryStore + Embedding Provider (global DB)
	const memoryStore = new MemoryStore({
		dbPath: getGlobalDbPath(),
		projectId,
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
			chunking: {
				tokens: config.memory.chunkTokens,
				overlap: config.memory.chunkOverlap,
			},
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

	const syncMemory = createMemorySyncRunner({
		memoryStore,
		embeddingProvider,
		config,
	});

	console.log(chalk.dim("Agent:    ") + args.agent);
	console.log(`${chalk.dim("Provider: ")}${llmProvider} (${llmClient.getModel()})`);
	console.log(`${chalk.dim("Host:     ")}${args.host}`);
	console.log(`${chalk.dim("Port:     ")}${args.port}`);
	console.log();

	// Initialize components
	const stateDetector = new StateDetector(bridge, llmClient, config.stateDetector, promptLoader);

	// Setup agent adapter
	const defaultAdapter = new ClaudeCodeAdapter();

	// Initialize ConversationStore (reuse global DB)
	const conversationStore = new ConversationStore(memoryStore.getDb());

	// Initialize ChatBroadcaster
	const broadcaster = new ChatBroadcaster();
	const executionEventStore = new ExecutionEventStore();

	// Initialize ContextManager with conversation persistence
	const contextManager = new ContextManager({
		llmClient,
		promptLoader,
		memoryStore,
		syncMemory,
		flushThreshold: config.memory.flushThreshold,
		toolResultRetention: config.memory.toolResultRetention,
		conversationStore,
	});

	// Restore conversation from SQLite if any
	const existingMessageCount = conversationStore.getMessageCount();
	if (existingMessageCount > 0) {
		contextManager.restore(conversationStore);
		logger.info("main", `Restored ${existingMessageCount} messages from SQLite`);
		console.log(chalk.dim(`Restored ${existingMessageCount} messages from previous session`));
	}

	// Initialize Skill System: discover → filter → inject → registry
	const adapterSkillsDir = defaultAdapter.getSkillsDir?.();
	const discoveredSkills = await discoverSkills({
		adapterSkillsDir,
		workspaceDir: args.cwd,
	});
	const filteredSkills = filterSkills(discoveredSkills, { disabled: config.skills?.disabled }, args.cwd);
	const capFile = defaultAdapter.getCapabilitiesFile?.();
	const adapterCapabilities = capFile
		? promptLoader.loadAdapterCapabilities(capFile.replace(/^adapters\//, "").replace(/\.md$/, ""))
		: "";
	const baseCapabilities = adapterCapabilities || "Direct code editing and file operations\nRunning terminal commands";
	const capabilitiesSummary = buildCapabilitiesSummary(baseCapabilities, filteredSkills);
	contextManager.updateModule("agent_capabilities", capabilitiesSummary);
	const openspecCmds = defaultAdapter.getOpenSpecCommands?.() ?? {
		toolName: "claude",
		explore: "/opsx:explore",
		propose: "/opsx:propose",
		apply: "/opsx:apply",
		archive: "/opsx:archive",
		wildcard: "/opsx:*",
	};
	contextManager.updateModule("openspec_tool_name", openspecCmds.toolName);
	contextManager.updateModule("openspec_cmd_explore", openspecCmds.explore);
	contextManager.updateModule("openspec_cmd_propose", openspecCmds.propose);
	contextManager.updateModule("openspec_cmd_apply", openspecCmds.apply);
	contextManager.updateModule("openspec_cmd_archive", openspecCmds.archive);
	contextManager.updateModule("openspec_cmd_wildcard", openspecCmds.wildcard);
	const skillRegistry = new SkillRegistry(filteredSkills);
	logger.info("main", `Skills loaded: ${skillRegistry.size} (${filteredSkills.map((s) => s.name).join(", ")})`);

	// Initialize SignalRouter and MainAgent
	const signalRouter = new SignalRouter(stateDetector, bridge, contextManager);

	const mainAgent = new MainAgent({
		contextManager,
		signalRouter,
		llmClient,
		adapter: defaultAdapter,
		bridge,
		stateDetector,
		broadcaster,
		executionEventStore,
		memoryStore,
		syncMemory,
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

	// Log state changes
	mainAgent.on("state_change", (state) => {
		logger.info("main", `Agent state: ${state}`);
	});

	mainAgent.on("log", (message) => {
		logger.info("main-agent", message);
	});

	// ─── Command Registry ───────────────────────────────

	const commandRegistry = new CommandRegistry();

	// Register skill-declared commands
	for (const skill of filteredSkills) {
		for (const cmd of skill.commands) {
			const cmdName = cmd.startsWith("/") ? cmd.slice(1) : cmd;
			commandRegistry.register({
				name: cmdName,
				description: skill.description,
				category: "skill",
				skillName: skill.name,
			});
		}
	}

	// ─── Start Server ───────────────────────────────────

	const serverInstance = await startServer({
		host: args.host,
		port: args.port,
		mainAgent,
		signalRouter,
		contextManager,
		conversationStore,
		broadcaster,
		commandRegistry,
		executionEventStore,
	});

	if (isDaemonProcess) {
		await saveServerRuntimeState({
			pid: process.pid,
			host: args.host,
			port: serverInstance.port,
			url: `http://${args.host}:${serverInstance.port}`,
			cwd: args.cwd,
			startedAt: new Date().toISOString(),
		});
	}

	// ─── Graceful Shutdown ──────────────────────────────

	const shutdown = async () => {
		console.log(chalk.yellow("\nShutting down..."));

		// Stop MainAgent if executing
		if (mainAgent.state === "executing") {
			signalRouter.stop();
			// Give the loop a moment to exit cleanly
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		// Close server
		await serverInstance.close();

		// Close MemoryStore
		memoryStore.close();

		if (isDaemonProcess) {
			const state = await loadServerRuntimeState();
			if (state?.pid === process.pid) {
				await clearServerRuntimeState();
			}
		}

		logger.info("main", "Graceful shutdown complete");
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error(chalk.red("Fatal error:"), err.message || err);
	process.exit(1);
});
