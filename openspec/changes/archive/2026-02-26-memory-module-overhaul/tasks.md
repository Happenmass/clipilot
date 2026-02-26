## 1. Types & Foundation

- [x] 1.1 Create `src/memory/types.ts` — define `MemoryChunk`, `MemorySearchResult`, `MemoryCategory`, `EmbeddingProvider`, `EmbeddingProviderResult`, `HybridSearchConfig`, `MemorySearchConfig` types
- [x] 1.2 Add dependencies to `package.json`: `better-sqlite3` (+ `@types/better-sqlite3`), `sqlite-vec`, `chokidar`

## 2. Storage Layer

- [x] 2.1 Create `src/memory/store.ts` — MemoryStore class with SQLite schema initialization (6 tables), sqlite-vec runtime detection with fallback
- [x] 2.2 Implement `listMemoryFiles()` and `buildFileEntry()` — scan workspace `memory/` + root `MEMORY.md` / `memory.md`, compute SHA-256 hash
- [x] 2.3 Implement `chunkMarkdown()` in `src/memory/chunker.ts` — line-based splitting with configurable tokens/overlap, output MemoryChunk with startLine/endLine/text/hash
- [x] 2.4 Implement incremental sync (`syncMemoryFiles()`) — compare file hashes, delete stale chunks, re-chunk + re-embed changed files, clean up deleted files
- [x] 2.5 Write tests for chunker (boundary cases: empty file, single line, overlap carry, oversized line) and incremental sync (unchanged skip, modified re-index, deleted cleanup)

## 3. Embedding Provider

- [x] 3.1 Create `src/memory/embedder.ts` — `EmbeddingProvider` interface, `fetchRemoteEmbeddingVectors()` HTTP utility, `resolveRemoteEmbeddingClient()` key resolution
- [x] 3.2 Implement `createRemoteEmbeddingProvider()` — shared factory for OpenAI and Mistral (OpenAI-compatible `/embeddings` endpoint)
- [x] 3.3 Implement `createGeminiEmbeddingProvider()` — Google AI API with `taskType` differentiation and API key rotation
- [x] 3.4 Implement `createLocalEmbeddingProvider()` — `node-llama-cpp` lazy loading, vector sanitization, L2 normalization
- [x] 3.5 Implement `createEmbeddingProvider()` factory — auto detection, explicit + fallback, null result for FTS-only mode
- [x] 3.6 Implement embedding cache ops (`loadCached`, `upsertCache`, `pruneCache`) in MemoryStore
- [x] 3.7 Implement `embedBatchWithRetry()` — exponential backoff (500ms base, 8s max, 3 attempts), auth error skip
- [x] 3.8 Implement `enforceEmbeddingMaxInputTokens()` — chunk splitting for oversized inputs
- [x] 3.9 Write tests for embedding provider factory (auto mode, fallback chain, null result), cache ops, retry logic

## 4. Search Layer

- [x] 4.1 Create `src/memory/search.ts` — `searchVector()` using sqlite-vec KNN with cosine distance, brute-force fallback path
- [x] 4.2 Implement `searchKeyword()` — FTS5 BM25 search, `buildFtsQuery()` token extraction, `bm25RankToScore()` conversion
- [x] 4.3 Implement `mergeHybridResults()` — chunk ID dedup, weighted scoring (0.7/0.3 default), single-path fallback scoring
- [x] 4.4 Implement `applyTemporalDecay()` — extract date from path, exponential decay with 30-day half-life, evergreen bypass
- [x] 4.5 Implement min-score filtering and Top-K truncation
- [x] 4.6 Write tests for hybrid merge (dual-hit, single-hit, empty), temporal decay (dated file, evergreen file), FTS query construction

## 5. Category Layer

- [x] 5.1 Create `src/memory/category.ts` — `categoryFromPath()`, `isEvergreenCategory()`, `buildCategoryPathFilter()` SQL generation
- [x] 5.2 Integrate category filtering into search (optional `category` param → SQL WHERE clause)
- [x] 5.3 Write tests for all category mappings (core, preferences, people, todos, daily, legacy, topic) and SQL filter generation

## 6. Memory Tools in MainAgent

- [x] 6.1 Add `memory_search` tool definition and execution in `src/core/main-agent.ts` — invoke MemoryStore.search(), return `{ results }` array
- [x] 6.2 Add `memory_get` tool definition and execution — read `.md` file, slice by line range, handle file-not-found
- [x] 6.3 Add `memory_write` tool definition and execution — path security check (only `memory/` + `.md`), append or create, mark dirty
- [x] 6.4 Add MemoryStore to MainAgent constructor dependencies, wire up in `src/main.ts`
- [x] 6.5 Update `prompts/main-agent.md` — add "Memory Recall" section with usage instructions, category layout, citation guidance
- [x] 6.6 Create `prompts/memory-flush.md` — flush system prompt and user prompt templates
- [x] 6.7 Write tests for tool execution (search, get, write), path security rejection

## 7. ContextManager Upgrade

- [x] 7.1 Add `prepareForLLM()` method — structuredClone conversation, apply transformContext, return `{ system, messages }`
- [x] 7.2 Implement `transformContext()` — single tool result truncation (50% cap), budget overflow compaction (75% cap, oldest-first tool result replacement)
- [x] 7.3 Add hybrid token counting — `lastKnownTokenCount`, `pendingChars`, `reportUsage()`, `getCurrentTokenEstimate()`, update `addMessage()` to accumulate chars
- [x] 7.4 Replace `shouldCompress()` to use `getCurrentTokenEstimate()` instead of `estimateTokens()`
- [x] 7.5 Add `shouldRunMemoryFlush()` — ratio threshold (0.6 default), compaction cycle guard
- [x] 7.6 Implement `runMemoryFlush()` — load flush prompt, independent LLM call with memory_write tool, execute writes via MemoryStore, update flush counter
- [x] 7.7 Add post-compaction context injection in `compress()` — after reset, inject behavioral recovery message
- [x] 7.8 Add MemoryStore + flushThreshold to ContextManager constructor, validate flush < compress invariant
- [x] 7.9 Write tests for prepareForLLM (original preserved), transformContext (truncation, compaction), hybrid token counting, flush trigger logic, threshold invariant

## 8. Integration & Wiring

- [x] 8.1 Update `src/main.ts` — initialize MemoryStore (with embedding provider factory), replace old Memory class usage, pass MemoryStore to ContextManager and MainAgent
- [x] 8.2 Update MainAgent `runToolUseLoop()` — use `contextManager.prepareForLLM()` for LLM calls, call `contextManager.reportUsage()` after each response, add flush-before-compress ordering
- [x] 8.3 Remove old `src/core/memory.ts` and all imports referencing it
- [x] 8.4 Update `src/main.ts` session-end summary — replace `memory.recordLesson()` with MemoryStore.write() or rely on Memory Flush
- [x] 8.5 Add `memory` and `embedding` sections to config schema in `src/utils/config.ts`
- [x] 8.6 Update integration test (`test/core/integration.test.ts`) — mock MemoryStore, verify flush/compress ordering, verify memory tool calls
- [x] 8.7 Run full test suite, fix any regressions from ContextManager interface changes
