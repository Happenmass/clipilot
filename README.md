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
# Start the server (default port 3120)
clipilot

# Open the chat UI in your browser
open http://localhost:3120

# Start with a specific port
clipilot --port 8080

# Specify a provider and model
clipilot -p openai -m gpt-4o
```

Once the server is running, open `http://localhost:3120` in your browser. You'll see a chat interface where you can:

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
clipilot [options]              Start the chat server (default)
clipilot serve [options]        Start the chat server explicitly

Subcommands:
  serve                   Start the chat server (default behavior)
  init                    Initialize project-level skills and prompts directories
  remember <text>         Save a note to project memory
  config                  Open configuration TUI
  doctor                  Run health checks

Options:
  -a, --agent <name>      Coding agent (default: claude-code)
  -p, --provider <name>   LLM provider
  -m, --model <id>        LLM model ID
  --base-url <url>        Custom API base URL
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
    "model": "claude-sonnet-4-5-20250929",
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
| OpenAI | gpt-4o, gpt-4o-mini, gpt-4.1, o3, o4-mini | `OPENAI_API_KEY` |
| Anthropic | claude-opus-4-6, claude-sonnet-4-5, claude-haiku-4-5 | `ANTHROPIC_API_KEY` |
| OpenRouter | Multi-provider aggregator | `OPENROUTER_API_KEY` |
| DeepSeek | deepseek-chat, deepseek-reasoner | `DEEPSEEK_API_KEY` |
| Google Gemini | gemini-2.5-flash, gemini-2.5-pro | `GEMINI_API_KEY` |
| Groq | llama-3.3-70b-versatile | `GROQ_API_KEY` |
| Mistral | mistral-large-latest, codestral-latest | `MISTRAL_API_KEY` |
| xAI (Grok) | grok-3, grok-3-mini | `XAI_API_KEY` |
| Together AI | Llama models | `TOGETHER_API_KEY` |
| Moonshot (Kimi) | moonshot-v1-auto | `MOONSHOT_API_KEY` |
| MiniMax | MiniMax-Text-01 | `MINIMAX_API_KEY` |
| Ollama (Local) | llama3.3 (local models) | — |

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
