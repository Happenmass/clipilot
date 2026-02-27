import { parseArgs } from "node:util";

export interface CLIArgs {
	goal: string | undefined;
	isInit: boolean;
	agent: string;
	autonomy: "low" | "medium" | "high" | "full";
	provider: string | undefined;
	model: string | undefined;
	baseUrl: string | undefined;
	dryRun: boolean;
	listProviders: boolean;
	help: boolean;
	version: boolean;
	cwd: string;
	rememberText: string | undefined;
}

export function parseCliArgs(): CLIArgs {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			agent: { type: "string", short: "a", default: "claude-code" },
			autonomy: { type: "string", default: "medium" },
			provider: { type: "string", short: "p" },
			model: { type: "string", short: "m" },
			"base-url": { type: "string" },
			"dry-run": { type: "boolean", default: false },
			"list-providers": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
			version: { type: "boolean", short: "v", default: false },
			cwd: { type: "string", default: process.cwd() },
		},
	});

	const autonomy = values.autonomy as string;
	if (!["low", "medium", "high", "full"].includes(autonomy)) {
		console.error(`Invalid autonomy level: ${autonomy}. Must be one of: low, medium, high, full`);
		process.exit(1);
	}

	// Handle subcommands
	const isRemember = positionals[0] === "remember";
	const isInit = positionals[0] === "init";
	const rememberText = isRemember ? positionals.slice(1).join(" ") || undefined : undefined;

	return {
		goal: isRemember || isInit ? undefined : positionals[0],
		isInit,
		agent: values.agent as string,
		autonomy: autonomy as CLIArgs["autonomy"],
		provider: values.provider as string | undefined,
		model: values.model as string | undefined,
		baseUrl: values["base-url"] as string | undefined,
		dryRun: values["dry-run"] as boolean,
		listProviders: values["list-providers"] as boolean,
		help: values.help as boolean,
		version: values.version as boolean,
		cwd: values.cwd as string,
		rememberText,
	};
}

export function printHelp(): void {
	console.log(`
CLIPilot - TUI meta-orchestrator for coding agents

Usage:
  clipilot [options] [goal]

Arguments:
  goal                    Development goal to accomplish (optional, interactive if omitted)

Subcommands:
  init                    Initialize project-level skills and prompts directories
  remember <text>         Save a note to project memory for future sessions
  config                  Open configuration TUI
  doctor                  Run health checks on the CLI environment

Options:
  -a, --agent <name>      Coding agent to use (default: claude-code)
                          Options: claude-code, codex, pi
  -p, --provider <name>   LLM provider for planning/analysis (default: from config)
                          Built-in: openai, anthropic, openrouter, moonshot, minimax,
                                    deepseek, groq, together, xai, gemini, mistral, ollama
  -m, --model <id>        LLM model ID (default: provider's default)
  --base-url <url>        Custom API base URL (for self-hosted or custom endpoints)
  --autonomy <level>      Autonomy level (default: medium)
                          low:    confirm every step
                          medium: confirm key decisions
                          high:   fully automatic, notify on errors
                          full:   fully autonomous with auto-retry
  --dry-run               Only plan, don't execute
  --list-providers        List all available LLM providers
  --cwd <path>            Working directory (default: current)
  -h, --help              Show this help
  -v, --version           Show version

Examples:
  clipilot "Add JWT authentication to this Express app"
  clipilot -p openai -m gpt-4o "Refactor the database layer"
  clipilot -p deepseek "Add user registration feature"
  clipilot -p openrouter -m anthropic/claude-opus-4-6 --dry-run "Redesign the API"
  clipilot -p ollama -m llama3.3 "Write unit tests"
  clipilot --base-url https://llm.my-corp.com/v1 -m internal-v2 "Fix the bug"
  clipilot remember "This project uses PostgreSQL with Drizzle ORM"

Environment variables:
  ANTHROPIC_API_KEY       Anthropic API key
  OPENAI_API_KEY          OpenAI API key
  OPENROUTER_API_KEY      OpenRouter API key
  MOONSHOT_API_KEY        Moonshot (Kimi) API key
  MINIMAX_API_KEY         MiniMax API key
  DEEPSEEK_API_KEY        DeepSeek API key
  GROQ_API_KEY            Groq API key
  XAI_API_KEY             xAI (Grok) API key
  GEMINI_API_KEY          Google Gemini API key
  MISTRAL_API_KEY         Mistral API key
`);
}

export function printVersion(): void {
	console.log("clipilot v0.1.0");
}
