## ADDED Requirements

### Requirement: Summary generation format
The system SHALL generate a skill summary for prompt injection containing: adapter base capabilities, followed by an "Available Skills" section listing each skill's name, description, and commands.

#### Scenario: Generate summary with multiple skills
- **WHEN** adapter base capabilities is "Direct code editing and file operations\nRunning terminal commands" and filtered skills include `openspec` (commands: /opsx:new, /opsx:ff) and `commit` (commands: /commit)
- **THEN** the generated summary contains the base capabilities followed by skill entries, each with name, description, commands list, and a `read_skill` hint

#### Scenario: No skills available
- **WHEN** no skills pass filtering
- **THEN** the generated summary contains only the adapter base capabilities without an "Available Skills" section

### Requirement: ContextManager module injection
The system SHALL inject the generated summary into the ContextManager via `updateModule("agent_capabilities", summary)`, replacing the `{{agent_capabilities}}` placeholder in the system prompt template.

#### Scenario: Module replacement in system prompt
- **WHEN** `main-agent.md` contains `{{agent_capabilities}}` and `updateModule("agent_capabilities", summary)` is called
- **THEN** the system prompt contains the skill summary in place of the placeholder

### Requirement: Skill type filtering for injection
Only skills with `type: agent-capability` or `type: prompt-enrichment` SHALL be included in the prompt summary. Skills with `type: main-agent-tool` SHALL NOT appear in the summary (they register as tools instead).

#### Scenario: main-agent-tool excluded from summary
- **WHEN** a skill has `type: main-agent-tool`
- **THEN** it does not appear in the "Available Skills" section of the prompt summary

#### Scenario: prompt-enrichment in summary
- **WHEN** a skill has `type: prompt-enrichment` with description "Project coding conventions"
- **THEN** it appears in the summary without a commands list, with a `read_skill` hint

### Requirement: Token budget awareness
The total injected summary MUST NOT exceed 2000 characters. If the combined summary exceeds this limit, skills SHALL be truncated by priority (workspace skills retained first, then adapter skills by alphabetical order), and a note SHALL indicate truncation occurred.

#### Scenario: Summary within budget
- **WHEN** the combined summary of all skills is 1500 characters
- **THEN** all skills are included without truncation

#### Scenario: Summary exceeds budget
- **WHEN** the combined summary would be 2500 characters with 8 skills
- **THEN** skills are removed until the summary fits within 2000 characters, with a note "(N more skills available via read_skill)"
