## ADDED Requirements

### Requirement: prepareForLLM explicit method
ContextManager SHALL expose a `prepareForLLM()` method that returns `{ system: string; messages: LLMMessage[] }`. It SHALL deep-clone the conversation, apply the tool result context guard (transformContext), and return the transformed messages alongside the rendered system prompt. The original conversation array SHALL remain unmodified.

#### Scenario: Original conversation preserved
- **WHEN** `prepareForLLM()` is called and transformContext compacts old tool results
- **THEN** the original `this.conversation` array is unchanged and `getMessages()` still returns uncompacted messages

#### Scenario: MainAgent uses prepareForLLM
- **WHEN** MainAgent calls LLM in `runToolUseLoop()`
- **THEN** it uses `contextManager.prepareForLLM()` to get system prompt and messages, NOT `getMessages()` + `getSystemPrompt()` separately

### Requirement: Tool result context guard (Layer 1)
The `transformContext` function within `prepareForLLM()` SHALL: (1) truncate any single tool result exceeding 50% of the context budget, (2) replace the oldest tool results with `"[compacted: tool output removed to free context]"` when total estimated tokens exceed 75% of the context window. Non-tool-result messages SHALL NOT be compacted.

#### Scenario: Oversized single tool result
- **WHEN** a tool result message contains 60,000 tokens worth of content and the context window is 128K
- **THEN** it is truncated to approximately 64,000 tokens (50% of window)

#### Scenario: Budget overflow compaction
- **WHEN** total messages exceed 75% of context window
- **THEN** the oldest tool result messages are replaced with compaction placeholders, starting from the earliest, until under budget

#### Scenario: Non-tool messages untouched
- **WHEN** transformContext runs
- **THEN** user and assistant messages are never replaced with compaction placeholders

### Requirement: Hybrid token counting
ContextManager SHALL maintain a `lastKnownTokenCount` (precise, from LLM API) and `pendingChars` (accumulated since last API call). `reportUsage(usage: LLMUsage)` SHALL set `lastKnownTokenCount = usage.inputTokens + usage.outputTokens` and reset `pendingChars = 0`. `addMessage()` SHALL accumulate character count into `pendingChars`. `getCurrentTokenEstimate()` SHALL return `lastKnownTokenCount + Math.ceil(pendingChars / 4)`.

#### Scenario: Token count after LLM call
- **WHEN** `reportUsage({ inputTokens: 70000, outputTokens: 2000 })` is called
- **THEN** `getCurrentTokenEstimate()` returns 72000 (pendingChars reset to 0)

#### Scenario: Token count between calls
- **WHEN** after reportUsage(72000 total), two messages totaling 4000 characters are added
- **THEN** `getCurrentTokenEstimate()` returns `72000 + ceil(4000/4) = 73000`

### Requirement: Memory Flush trigger (Layer 2)
ContextManager SHALL expose `shouldRunMemoryFlush()` returning true when `getCurrentTokenEstimate() > contextWindowLimit * flushThreshold` AND `lastFlushCompactionCount !== currentCompactionCount`. Default `flushThreshold` SHALL be `0.6`.

#### Scenario: Flush threshold reached
- **WHEN** token estimate is 78,000 and contextWindowLimit is 128,000 (threshold = 76,800) and no flush has occurred in current compaction cycle
- **THEN** `shouldRunMemoryFlush()` returns true

#### Scenario: Already flushed in current cycle
- **WHEN** token estimate exceeds threshold but `lastFlushCompactionCount === currentCompactionCount`
- **THEN** `shouldRunMemoryFlush()` returns false

### Requirement: Memory Flush execution
`runMemoryFlush()` SHALL: (1) load flush system prompt from PromptLoader (`memory-flush` template), (2) construct a flush user message containing conversation summary, (3) call LLM with `memory_write` tool definition, (4) extract tool calls from response and execute each via `MemoryStore.write()` directly, (5) update `lastFlushCompactionCount = currentCompactionCount`. The flush LLM call SHALL NOT be added to the main conversation history.

#### Scenario: Flush persists important info
- **WHEN** flush runs and the LLM decides to save a deployment decision
- **THEN** `MemoryStore.write()` is called with `{ path: "memory/core.md", content: "..." }` and the dirty flag is set

#### Scenario: Nothing to flush
- **WHEN** flush runs and the LLM responds with `<silent>`
- **THEN** no `memory_write` calls are made and `lastFlushCompactionCount` is still updated

### Requirement: Flush-before-compress ordering
In MainAgent's `runToolUseLoop()`, flush check SHALL always execute before compress check. When both thresholds are exceeded in the same iteration, flush SHALL run first, then compress.

#### Scenario: Both thresholds exceeded
- **WHEN** token estimate is 95,000 (exceeds both flush 60% = 76,800 and compress 70% = 89,600)
- **THEN** `runMemoryFlush()` executes first, then `compress()` executes

### Requirement: Unified ratio thresholds with invariant
`flushThreshold` and `compressionThreshold` SHALL both be ratios of `contextWindowLimit`. The invariant `flushThreshold < compressionThreshold` SHALL be validated in the ContextManager constructor. Default values: flush = 0.6, compress = 0.7.

#### Scenario: Invalid threshold configuration
- **WHEN** ContextManager is constructed with `flushThreshold = 0.8` and `compressionThreshold = 0.7`
- **THEN** the constructor throws an error indicating flush threshold must be less than compression threshold

### Requirement: Post-compaction context injection
After `compress()` runs, ContextManager SHALL inject a post-compaction context message containing core behavioral instructions, ensuring the LLM retains critical guidance after history summarization.

#### Scenario: Compress injects recovery context
- **WHEN** `compress()` completes and resets the conversation
- **THEN** a post-compaction context message is added as the first message in the new conversation

### Requirement: Deprecate old Memory class
The old `src/core/memory.ts` class SHALL be removed entirely. All references in `src/main.ts` (startup loading, session-end `recordLesson()`) SHALL be replaced with MemoryStore and Memory Flush respectively.

#### Scenario: Old memory.ts removed
- **WHEN** the codebase is built after this change
- **THEN** no import of `Memory` from `./core/memory.js` exists anywhere in the source
