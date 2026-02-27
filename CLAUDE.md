# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is CLIPilot

CLIPilot is a TUI meta-orchestrator that commands coding agents (like Claude Code) via tmux. It does not write code directly — it launches agents in tmux panes, monitors their state, and makes decisions through an LLM-driven goal-driven tool-use loop.

Core flow: **Goal → MainAgent (goal-driven tool-use loop) → Agent execution in tmux**

## Commands

```bash
npm run build          # tsc — compile to dist/
npm run dev            # tsc --watch
npm test               # vitest run — all tests
npm run test:watch     # vitest — watch mode
npx vitest test/core/main-agent.test.ts   # run a single test file
npm run check          # biome check src/
npm run format         # biome format --write src/
npm start              # node dist/main.js
```

## Code Style

- **Formatter**: Biome — tabs, indent width 3, line width 120
- **Module system**: ESM (`"type": "module"` in package.json)
- **TypeScript**: strict mode, target ES2022, module Node16
- **Imports**: use `.js` extension in relative imports (Node16 module resolution)
- `noExplicitAny: off`, `noNonNullAssertion: off` — these are intentionally relaxed
- Use `useConst: error` — always prefer `const`

## Architecture

### Initialization (`src/main.ts`)
Entry point. Parses CLI args, loads config/memory, initializes all components, runs the 3-phase flow:
1. **Bootstrap** — MemoryStore (SQLite), EmbeddingProvider (auto-fallback), initial memory file sync, skill discovery → filter → registry
2. **Execution** — `mainAgent.executeGoal(goal)` runs a goal-driven tool-use loop until completion or failure
3. **Summary** — Session summary and memory persistence

### MainAgent (`src/core/main-agent.ts`)
Goal-driven decision engine using LLM tool-use. `executeGoal(goal)` runs an unbounded loop: call LLM → extract tool calls → execute tools → repeat until a terminal tool is called. Emits events: `goal_start`, `goal_complete`, `goal_failed`, `need_human`, `log`. 12 built-in tools:
- `send_to_agent` / `respond_to_agent` — interact with the coding agent in tmux
- `fetch_more` — capture more tmux pane content
- `mark_complete` / `mark_failed` — terminal: end the goal
- `escalate_to_human` — terminal: request human intervention
- `memory_search` / `memory_get` / `memory_write` — hybrid search, read, and persist memories
- `read_skill` — read full SKILL.md content on demand
- `create_session` — create a `clipilot-` prefixed tmux session and launch agent (LLM decides naming)
- `list_clipilot_sessions` — list all `clipilot-` prefixed sessions

Skill-contributed tools are merged in at init via `tool-merge.ts` (with collision detection).

### Memory Module (`src/memory/`)
Dual-storage architecture: Markdown files are the source of truth, SQLite is the search index (rebuildable).

- `store.ts` — SQLite backend with WAL mode, 6 tables (meta, files, chunks, chunks_vec, chunks_fts, embedding_cache)
- `search.ts` — hybrid search: vector KNN (sqlite-vec) + keyword BM25 (FTS5), weighted merge (0.7/0.3), time decay, MMR diversity
- `embedder.ts` — embedding provider factory supporting OpenAI, Gemini, Voyage, Mistral; auto-fallback chain with retry and caching
- `chunker.ts` — Markdown chunking (configurable tokens/overlap, default 400/80)
- `sync.ts` — incremental file-to-SQLite sync via content hash tracking
- `category.ts` — 7 categories (core, preferences, people, todos, daily, legacy, topic) inferred from file path
- `types.ts` — shared types: `MemoryChunk`, `MemorySearchResult`, `EmbeddingProvider`, `HybridSearchConfig`

### Skill System (`src/skills/`)
Extensible capability system allowing agents to contribute domain-specific tools and prompts.

- `discovery.ts` — discovers skills from adapter and workspace directories (workspace overrides adapter), limit 50
- `filter.ts` — conditional activation based on disabled list, file existence, OS, env vars
- `parser.ts` / `reader.ts` — YAML frontmatter parsing from SKILL.md files
- `registry.ts` — lookup by name or tool name
- `injector.ts` — injects skill summaries into MainAgent prompt (budget-aware, max 2000 chars)
- `tool-merge.ts` — merges skill tool definitions into MainAgent's tool set with collision detection
- `types.ts` — three skill types: `agent-capability`, `main-agent-tool`, `prompt-enrichment`

### ContextManager (`src/core/context-manager.ts`)
Modular system prompt with replaceable sections (`{{goal}}`, `{{compressed_history}}`, `{{memory}}`, `{{agent_capabilities}}`). Two-layer context guard:

- **Layer 2 — Memory Flush** (60% threshold): extracts valuable insights from conversation and persists to memory files via `memory-flush.md` prompt
- **Layer 3 — Compression** (70% threshold): compresses conversation history, resets context, re-injects POST_COMPACTION_CONTEXT

Uses hybrid token counting: last-known API count + pending character estimation.

### SignalRouter (`src/core/signal-router.ts`)
Aggregates StateDetector results into typed signals (`DECISION_NEEDED`, `NOTIFY`, `USER_STEER`). Provides execution control: `pause()`, `resume()`, `abort()`. Extends EventEmitter for `goal_complete`, `goal_failed`, `need_human`, `log` events. The MainAgent waits on signals between tool-use rounds.

### StateDetector (`src/tmux/state-detector.ts`)
Polls tmux pane content, computes content hashes, and classifies agent state (active, waiting_input, completed, error) using pattern matching. Falls back to LLM analysis for ambiguous states. Has a cooldown mechanism to avoid excessive polling.

### LLM Layer (`src/llm/`)
- `client.ts` — unified client supporting Anthropic and OpenAI-compatible protocols
- `providers/registry.ts` — 12 built-in providers (OpenAI, Anthropic, DeepSeek, Gemini, Groq, etc.)
- `prompt-loader.ts` — loads markdown prompt templates from `prompts/` with `{{variable}}` interpolation

### Prompts (`prompts/`)
Markdown templates with `{{variable}}` placeholders:
- `main-agent.md` — MainAgent system prompt (goal-driven autonomous decision guidelines, signals, memory recall, session management, skill usage)
- `state-analyzer.md` — ambiguous state classification
- `history-compressor.md` — conversation compression
- `memory-flush.md` — extract decisions/preferences/knowledge from conversation for persistence
- `error-analyzer.md`, `session-summarizer.md`

### Other Components
- `TmuxBridge` (`src/tmux/bridge.ts`) — tmux command wrapper (create sessions, send keys, capture panes, `listClipilotSessions()`)
- `Session` (`src/core/session.ts`) — session lifecycle management
- `ClaudeCodeAdapter` (`src/agents/claude-code.ts`) — agent adapter for Claude Code

## Testing

Tests live in `test/` mirroring `src/` structure. All tests mock external dependencies (LLM calls, tmux commands). The integration test (`test/core/integration.test.ts`) validates the full Goal → executeGoal → GoalResult pipeline with mocked components.

## Config

User config at `~/.clipilot/config.json`. Managed via `src/utils/config.ts`. The `clipilot config` subcommand opens a TUI editor. The `clipilot doctor` subcommand checks environment prerequisites (tmux, node version, API keys).

Memory-related config under `config.memory`:
- `embeddingProvider` — `"auto"` (default) | `"openai"` | `"gemini"` | `"voyage"` | `"mistral"` | `"local"` | `"none"`
- `embeddingModel` — override default model per provider
- `flushThreshold` — memory flush ratio (default 0.6)
- `vectorWeight` — hybrid search vector weight (default 0.7, keyword = 1 - vectorWeight)
- `decayHalfLifeDays` — time decay for daily memories (default 30)
- `skills.disabled` — list of skill names to disable
