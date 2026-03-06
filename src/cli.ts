import { parseArgs } from "node:util";

export interface CLIArgs {
	subcommand: string | undefined;
	isInit: boolean;
	agent: string;
	provider: string | undefined;
	model: string | undefined;
	baseUrl: string | undefined;
	host: string;
	port: number;
	listProviders: boolean;
	help: boolean;
	version: boolean;
	cwd: string;
	rememberText: string | undefined;
}

export function parseCliArgs(): CLIArgs {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		options: {
			agent: { type: "string", short: "a", default: "claude-code" },
			provider: { type: "string", short: "p" },
			model: { type: "string", short: "m" },
			"base-url": { type: "string" },
			host: { type: "string", default: "127.0.0.1" },
			port: { type: "string", default: "3120" },
			"list-providers": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
			version: { type: "boolean", short: "v", default: false },
			cwd: { type: "string", default: process.cwd() },
		},
	});

	// Handle subcommands
	const subcommand = positionals[0];
	const isRemember = subcommand === "remember";
	const isInit = subcommand === "init";
	const rememberText = isRemember ? positionals.slice(1).join(" ") || undefined : undefined;

	return {
		subcommand: isRemember || isInit ? subcommand : subcommand,
		isInit,
		agent: values.agent as string,
		provider: values.provider as string | undefined,
		model: values.model as string | undefined,
		baseUrl: values["base-url"] as string | undefined,
		host: values.host as string,
		port: Number.parseInt(values.port as string, 10) || 3120,
		listProviders: values["list-providers"] as boolean,
		help: values.help as boolean,
		version: values.version as boolean,
		cwd: values.cwd as string,
		rememberText,
	};
}

export function printHelp(): void {
	console.log(`
CLIPilot - Chat-based meta-orchestrator for coding agents

Usage:
  clipilot [options]              Start the chat server in foreground (default)
  clipilot serve [options]        Start the chat server in foreground explicitly
  clipilot start [options]        Start the chat server in background
  clipilot stop                   Stop the background server
  clipilot restart [options]      Restart the background server

Subcommands:
  serve                   Start the chat server in foreground (default behavior)
  start                   Start the chat server in background (daemon mode)
  stop                    Stop the background server
  restart                 Restart the background server (stop + start)
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
  --host <host>           Bind address for the HTTP/WebSocket server (default: 127.0.0.1)
  --port <number>         Server port (default: 3120)
  --list-providers        List all available LLM providers
  --cwd <path>            Working directory (default: current)
  -h, --help              Show this help
  -v, --version           Show version

Examples:
  clipilot                                            # Start foreground server on default port
  clipilot start                                      # Start background server
  clipilot stop                                       # Stop background server
  clipilot --host 0.0.0.0 --port 3120                 # Expose server on all interfaces
  clipilot --port 8080                                # Start server on port 8080
  clipilot -p openai -m gpt-5.4                        # Start with specific LLM
  clipilot remember "This project uses PostgreSQL"    # Save a memory note

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
	console.log("clipilot v0.2.0");
}
