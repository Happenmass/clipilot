## 1. Types & Storage Layer

- [x] 1.1 Create `src/skills/types.ts` — Define `SkillEntry`, `SkillType`, `WhenCondition`, `SkillToolDef`, `SkillSource` types
- [x] 1.2 Create `src/skills/parser.ts` — Implement lightweight frontmatter parser (regex + line parsing, no yaml dependency)
- [x] 1.3 Create `src/skills/reader.ts` — Read SKILL.md file: return parsed frontmatter + body separately
- [x] 1.4 Write tests for parser: valid frontmatter, missing frontmatter, malformed frontmatter, all field types
- [x] 1.5 Write tests for reader: file reading, body extraction (frontmatter stripped), file-not-found handling

## 2. Discovery Layer

- [x] 2.1 Create `src/skills/discovery.ts` — `discoverSkills(adapterSkillsDir?, workspaceDir?)` scanning both sources
- [x] 2.2 Implement same-name override logic (workspace overrides adapter-bundled)
- [x] 2.3 Implement safety limits (max 50 skills, max 100KB per SKILL.md)
- [x] 2.4 Write tests for discovery: dual-source loading, override behavior, missing directories, safety limits, malformed skill skip

## 3. Filtering Layer

- [x] 3.1 Create `src/skills/filter.ts` — `filterSkills(skills, config, workspaceDir)` with when-condition evaluation
- [x] 3.2 Implement when-condition checks: files existence, os match, env variable presence
- [x] 3.3 Implement config disable list filtering
- [x] 3.4 Write tests for filter: each when-condition type, disable list, filter order, no-when passthrough

## 4. Injection Layer

- [x] 4.1 Create `src/skills/injector.ts` — `buildCapabilitiesSummary(baseCapabilities, skills)` generating prompt text
- [x] 4.2 Implement skill type filtering for injection (agent-capability + prompt-enrichment only, exclude main-agent-tool)
- [x] 4.3 Implement token budget enforcement (2000 char limit with truncation)
- [x] 4.4 Write tests for injector: summary format, type filtering, budget truncation, empty skills case

## 5. Adapter Interface Extension

- [x] 5.1 Add `getSkillsDir?(): string` and `getBaseCapabilities?(): string` to `AgentAdapter` interface in `src/agents/adapter.ts`
- [x] 5.2 Implement both methods in `ClaudeCodeAdapter` (`src/agents/claude-code.ts`)
- [x] 5.3 Create initial adapter-bundled skills: `src/agents/claude-code-skills/openspec/SKILL.md` and `src/agents/claude-code-skills/commit/SKILL.md`
- [x] 5.4 Write tests for adapter: getSkillsDir returns correct path, getBaseCapabilities returns text

## 6. Skill Registry & read_skill Tool

- [x] 6.1 Create `src/skills/registry.ts` — `SkillRegistry` class with `getByName()`, `getByToolName()`, `getAll()` methods
- [x] 6.2 Add `read_skill` tool definition to MainAgent's TOOL_DEFINITIONS
- [x] 6.3 Implement `read_skill` tool execution in MainAgent's `executeTool` switch — read body content from registry
- [x] 6.4 Write tests for registry: lookup by name, lookup by tool name, not found cases
- [x] 6.5 Write tests for read_skill tool: successful read, skill not found, non-terminal behavior

## 7. main-agent-tool Registration

- [x] 7.1 Extract tool schema from `main-agent-tool` type skills during discovery
- [x] 7.2 Merge skill-registered tools into MainAgent's TOOL_DEFINITIONS at initialization (reject name collisions with built-in tools)
- [x] 7.3 Implement skill-tool execution: when invoked, read SKILL.md body and return as tool result
- [x] 7.4 Write tests for tool registration: successful registration, name collision rejection, tool execution

## 8. System Prompt Integration

- [x] 8.1 Modify `prompts/main-agent.md` — Replace hardcoded `## Agent Capabilities` section with `{{agent_capabilities}}` placeholder
- [x] 8.2 Wire up initialization flow in `src/main.ts`: discover → filter → inject → registry → MainAgent
- [x] 8.3 Pass SkillRegistry to MainAgent constructor, wire read_skill and skill-tool execution
- [x] 8.4 Write integration test: full flow from discovery through prompt injection with mock adapter skills

## 9. Config & Cleanup

- [x] 9.1 Add `SkillsConfig` to `src/utils/config.ts` with `disabled: string[]` field
- [x] 9.2 Update `main-agent.md` prompt: add `read_skill` tool usage guidance to Decision Guidelines
- [x] 9.3 Run full test suite and fix any regressions
