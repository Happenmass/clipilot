# CLIPilot

Chat-based meta-orchestrator that commands coding agents (like Claude Code) via tmux to accomplish complex development tasks.

CLIPilot runs as a persistent server with a web chat UI. You chat with the MainAgent naturally — it can answer questions, discuss code, and when you assign a development task, it autonomously commands coding agents in tmux sessions to get the work done, streaming progress updates back to you in real-time.

## Prerequisites

- **Node.js** >= 20.0.0
- **tmux** installed and available in PATH

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt install tmux
```

## Installation

```bash
# Clone and install
git clone <repo-url>
cd clipilot
npm install
npm run build

# Or link globally
npm link
```

## Quick Start

```bash
# Start the server in foreground (default port 3120)
clipilot

# Open the chat UI in your browser
open http://localhost:3120

# Start the server in background (daemon mode)
clipilot start

# If already running, start prints the existing URL again
clipilot start

# Stop the background server
clipilot stop

# Restart the background server (stop + start)
clipilot restart

# Start with a specific port
clipilot --port 8080

# Specify a provider and model
clipilot -p openai -m gpt-5.4
```

In background mode, CLIPilot writes logs to `~/.clipilot/logs/server.log` and runtime state to `~/.clipilot/server-state.json`.

Once the server is running, open the printed URL (default `http://localhost:3120`) in your browser. You'll see a chat interface where you can:

- **Chat naturally** — Ask questions, discuss code, get explanations
- **Assign tasks** — "Add JWT authentication to this Express app" — the agent will work autonomously
- **Monitor progress** — See real-time updates as the agent works
- **Use slash commands** — `/stop`, `/resume`, `/clear`

## How It Works

```
You (Browser) ←→ WebSocket ←→ MainAgent ←→ LLM (streaming)
                                  ↕
                            tmux sessions
                                  ↕
                          Coding Agent (Claude Code)
```

1. You send a message through the chat UI
2. The MainAgent streams it to the LLM for analysis
3. For simple questions, it responds directly (stays **IDLE**)
4. For tasks, it enters **EXECUTING** state and uses tools:
   - Creates tmux sessions with coding agents
   - Sends instructions and monitors progress
   - Pushes summary updates to your chat in real-time
5. When done, it calls `mark_complete` and returns to **IDLE**

Your conversation persists in SQLite — restart the server and pick up where you left off.

## Chat Commands

| Command | Description |
|---------|-------------|
| `/stop` | Stop the current task execution |
| `/resume` | Resume after `/stop` |
| `/clear` | Clear conversation history (runs memory flush first) |

## CLI Options

```
clipilot [options]              Start the chat server in foreground (default)
clipilot serve [options]        Start the chat server in foreground explicitly
clipilot start [options]        Start the chat server in background
clipilot stop                   Stop the background server

Subcommands:
  serve                   Start the chat server in foreground (default behavior)
  start                   Start the chat server in background (daemon mode)
  stop                    Stop the background server
  init                    Initialize project-level skills and prompts directories
  remember <text>         Save a note to project memory
  config                  Open configuration TUI
  doctor                  Run health checks

Options:
  -a, --agent <name>      Coding agent (default: claude-code)
  -p, --provider <name>   LLM provider
  -m, --model <id>        LLM model ID
  --base-url <url>        Custom API base URL
  --host <host>           Bind address (default: 127.0.0.1)
  --port <number>         Server port (default: 3120)
  --list-providers        List all available LLM providers
  --cwd <path>            Working directory (default: current)
  -h, --help              Show help
  -v, --version           Show version
```

## Configuration

CLIPilot stores configuration in `~/.clipilot/config.json`. Edit it directly or use the interactive TUI:

```bash
clipilot config
```

### Config File Format

```json
{
  "defaultAgent": "claude-code",
  "debug": false,
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "apiKey": "sk-..."
  },
  "memory": {
    "embeddingProvider": "auto",
    "flushThreshold": 0.6,
    "vectorWeight": 0.7
  }
}
```

## Supported LLM Providers

| Provider | Models | Env Variable |
|----------|--------|-------------|
| OpenAI | gpt-5.4, gpt-5.2, gpt-4.1, o3, o3-pro, o4-mini | `OPENAI_API_KEY` |
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 | `ANTHROPIC_API_KEY` |
| OpenRouter | Multi-provider aggregator (default: openai/gpt-5.4) | `OPENROUTER_API_KEY` |
| DeepSeek | deepseek-chat, deepseek-reasoner | `DEEPSEEK_API_KEY` |
| Google Gemini | gemini-2.5-flash, gemini-3-flash-preview, gemini-3.1-pro-preview | `GEMINI_API_KEY` |
| Groq | llama-3.3-70b, llama-4-scout, qwen3-32b | `GROQ_API_KEY` |
| Mistral | mistral-large-latest, codestral-latest, magistral-medium-latest | `MISTRAL_API_KEY` |
| xAI (Grok) | grok-4-1-fast-reasoning, grok-4, grok-3 | `XAI_API_KEY` |
| Together AI | Llama 4 Scout | `TOGETHER_API_KEY` |
| Moonshot (Kimi) | kimi-k2.5, kimi-k2-thinking | `MOONSHOT_API_KEY` |
| MiniMax | MiniMax-M2.5, MiniMax-M2.1 | `MINIMAX_API_KEY` |
| Ollama (Local) | llama4 (local models) | — |

## Development

```bash
# Build
npm run build

# Watch mode
npm run dev

# Run tests
npm test

# Type check
npx tsc --noEmit

# Lint & format
npm run check
npm run format
```

## Project Structure

```
src/
├── main.ts                    # Entry point — bootstrap + start server
├── cli.ts                     # CLI argument parsing
├── core/                      # Core logic
│   ├── main-agent.ts          # MainAgent state machine (IDLE ↔ EXECUTING)
│   ├── context-manager.ts     # System prompt, conversation, compression, persistence
│   ├── signal-router.ts       # Execution control (stop/resume)
│   └── session.ts             # Session management
├── server/                    # HTTP + WebSocket server
│   ├── index.ts               # Express app, routes, WebSocket server
│   ├── chat-broadcaster.ts    # WebSocket client management & broadcast
│   ├── ws-handler.ts          # WebSocket message routing
│   ├── command-router.ts      # Slash command handling (/stop, /resume, /clear)
│   └── message-queue.ts       # Human message queue (EXECUTING state)
├── persistence/               # Data persistence
│   └── conversation-store.ts  # SQLite conversation persistence
├── tmux/                      # tmux integration
│   ├── bridge.ts              # tmux command wrapper
│   └── state-detector.ts      # Agent state detection
├── agents/                    # Agent adapters
│   ├── adapter.ts             # Adapter interface
│   └── claude-code.ts         # Claude Code adapter
├── llm/                       # LLM client
│   ├── client.ts              # LLM API client (complete + stream)
│   ├── types.ts               # LLM types
│   ├── prompt-loader.ts       # Prompt templates
│   └── providers/             # Provider registry
├── memory/                    # Memory system
│   ├── store.ts               # SQLite backend
│   ├── search.ts              # Hybrid search (vector + keyword)
│   ├── embedder.ts            # Embedding providers
│   ├── chunker.ts             # Markdown chunking
│   └── sync.ts                # File-to-SQLite sync
├── skills/                    # Skill system
│   ├── discovery.ts           # Skill discovery
│   ├── filter.ts              # Conditional activation
│   ├── registry.ts            # Skill lookup
│   └── injector.ts            # Prompt injection
├── tui/                       # Legacy TUI (still compiles)
│   ├── app.ts                 # TUI application
│   ├── dashboard.ts           # Dashboard view
│   └── config-view.ts         # Config editor
└── utils/
    ├── config.ts              # Configuration management
    └── logger.ts              # Logging

web/                           # Chat UI (served by Express)
├── index.html                 # Page structure
├── styles.css                 # Dark theme styles
└── app.js                     # WebSocket client, message rendering

prompts/                       # LLM prompt templates
├── main-agent.md              # MainAgent system prompt
├── history-compressor.md      # Conversation compression
├── memory-flush.md            # Memory extraction
└── state-analyzer.md          # Agent state analysis
```

## License

MIT
