## ADDED Requirements

### Requirement: memory_search tool in MainAgent
MainAgent SHALL have a `memory_search` tool that accepts `query` (required string), `maxResults` (optional number), `minScore` (optional number), `category` (optional string). It SHALL invoke hybrid search and return an array of `{ path, startLine, endLine, score, snippet }` results.

#### Scenario: Basic search
- **WHEN** MainAgent calls `memory_search({ query: "auth token rotation" })`
- **THEN** the tool executes hybrid search and returns matching chunks with paths, line numbers, scores, and text snippets

#### Scenario: Category-filtered search
- **WHEN** MainAgent calls `memory_search({ query: "review meeting", category: "people" })`
- **THEN** only chunks from `memory/people.md` are searched

#### Scenario: No results
- **WHEN** MainAgent calls `memory_search({ query: "nonexistent topic xyz" })`
- **THEN** an empty results array is returned

### Requirement: memory_get tool in MainAgent
MainAgent SHALL have a `memory_get` tool that accepts `path` (required string), `from` (optional number, 1-indexed start line), `lines` (optional number, line count). It SHALL read the specified Markdown file and return the requested line range.

#### Scenario: Read specific lines
- **WHEN** MainAgent calls `memory_get({ path: "memory/core.md", from: 15, lines: 10 })`
- **THEN** lines 15-24 of `memory/core.md` are returned as text

#### Scenario: Read entire file
- **WHEN** MainAgent calls `memory_get({ path: "memory/core.md" })` without `from` or `lines`
- **THEN** the full content of `memory/core.md` is returned

#### Scenario: File not found
- **WHEN** MainAgent calls `memory_get({ path: "memory/nonexistent.md" })`
- **THEN** an error message is returned indicating the file does not exist

### Requirement: memory_write tool in MainAgent
MainAgent SHALL have a `memory_write` tool that accepts `path` (required string) and `content` (required string). It SHALL write content to the specified file under `memory/` directory, creating the directory and file if needed. Writing to paths outside `memory/` or non-`.md` files SHALL be rejected.

#### Scenario: Append to existing file
- **WHEN** MainAgent calls `memory_write({ path: "memory/core.md", content: "\n## New Decision\n..." })`
- **THEN** the content is appended to `memory/core.md` and the index dirty flag is set

#### Scenario: Create new file
- **WHEN** MainAgent calls `memory_write({ path: "memory/deployment.md", content: "# Deployment Notes\n..." })`
- **THEN** `memory/deployment.md` is created with the given content

#### Scenario: Path security enforcement
- **WHEN** MainAgent calls `memory_write({ path: "src/main.ts", content: "..." })`
- **THEN** the write is rejected with an error: only `memory/` paths are allowed

### Requirement: Memory tools are non-terminal
All three memory tools (`memory_search`, `memory_get`, `memory_write`) SHALL be non-terminal tools in MainAgent's tool-use loop. After execution, the loop SHALL continue to allow the LLM to make further decisions (e.g., search memory then send instructions to agent).

#### Scenario: Search then act
- **WHEN** MainAgent calls `memory_search` in iteration 1 and `send_to_agent` in iteration 2
- **THEN** both tools execute successfully within the same `runToolUseLoop()` invocation

### Requirement: System prompt memory guidance
The MainAgent system prompt (`prompts/main-agent.md`) SHALL include a "Memory Recall" section instructing the LLM to use `memory_search` before answering questions about prior work, decisions, dates, people, preferences, or todos. It SHALL describe the category file layout and encourage use of the `category` filter parameter.

#### Scenario: System prompt includes memory guidance
- **WHEN** the MainAgent system prompt is rendered
- **THEN** it contains a "Memory Recall" section with usage instructions for memory_search, memory_get, and the category file layout
