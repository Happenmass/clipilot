## ADDED Requirements

### Requirement: read_skill tool definition
The MainAgent SHALL have a `read_skill` tool that reads the full content of a skill's SKILL.md file (body only, excluding frontmatter).

#### Scenario: Read existing skill
- **WHEN** MainAgent calls `read_skill({ name: "openspec" })` and `openspec` skill exists
- **THEN** the tool returns the Markdown body content of `openspec/SKILL.md` (without the YAML frontmatter block)

#### Scenario: Read non-existent skill
- **WHEN** MainAgent calls `read_skill({ name: "nonexistent" })` and no such skill exists
- **THEN** the tool returns an error message "Skill not found: nonexistent"

#### Scenario: read_skill is non-terminal
- **WHEN** MainAgent calls `read_skill`
- **THEN** the tool returns the content and the tool-use loop continues (non-terminal tool)

### Requirement: main-agent-tool registration
Skills with `type: main-agent-tool` SHALL have their `tool` frontmatter field parsed into a `ToolDefinition` and merged into the MainAgent's tool definitions at initialization.

#### Scenario: Skill registers a custom tool
- **WHEN** a skill has `type: main-agent-tool` and frontmatter contains `tool: { name: "analyze_risk", description: "Analyze task risk", parameters: {...} }`
- **THEN** `analyze_risk` appears in the MainAgent's available tools alongside built-in tools

#### Scenario: Tool name collision with built-in
- **WHEN** a skill declares a tool with name `send_to_agent` (which is a built-in tool)
- **THEN** the skill's tool registration is rejected with a warning logged, and the built-in tool is preserved

### Requirement: main-agent-tool execution
When MainAgent invokes a tool registered by a skill, the system SHALL read the skill's SKILL.md body and return it as the tool result, allowing the LLM to follow the instructions.

#### Scenario: Execute skill-registered tool
- **WHEN** MainAgent calls tool `analyze_risk` which was registered by skill `risk-analyzer`
- **THEN** the tool reads `risk-analyzer/SKILL.md` body content and returns it as the tool output

### Requirement: Skill registry access
The MainAgent SHALL maintain a `SkillRegistry` that provides lookup by name and by tool name, enabling both `read_skill` and tool execution to resolve skills.

#### Scenario: Lookup by skill name
- **WHEN** `registry.getByName("openspec")` is called
- **THEN** the corresponding `SkillEntry` is returned

#### Scenario: Lookup by tool name
- **WHEN** `registry.getByToolName("analyze_risk")` is called
- **THEN** the `SkillEntry` that registered `analyze_risk` tool is returned

#### Scenario: Registry initialized at startup
- **WHEN** the system starts with adapter `claude-code` and workspace dir `/project`
- **THEN** the SkillRegistry is populated with discovered, filtered skills from both sources

### Requirement: AgentAdapter interface extension
The `AgentAdapter` interface SHALL be extended with two optional methods: `getSkillsDir()` returning the adapter's skill directory path, and `getBaseCapabilities()` returning a text description of the adapter's base capabilities.

#### Scenario: Adapter with skills support
- **WHEN** `ClaudeCodeAdapter.getSkillsDir()` is called
- **THEN** it returns the absolute path to `src/agents/claude-code-skills/`

#### Scenario: Adapter without skills support
- **WHEN** a legacy adapter does not implement `getSkillsDir()`
- **THEN** the system only discovers workspace skills

#### Scenario: Adapter base capabilities
- **WHEN** `ClaudeCodeAdapter.getBaseCapabilities()` is called
- **THEN** it returns "Direct code editing and file operations\nRunning terminal commands"
