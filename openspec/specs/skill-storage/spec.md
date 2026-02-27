## ADDED Requirements

### Requirement: SKILL.md file format
Each skill SHALL be defined by a `SKILL.md` file inside a dedicated directory. The file MUST consist of a YAML frontmatter block (delimited by `---`) followed by Markdown body content.

#### Scenario: Valid SKILL.md with frontmatter and body
- **WHEN** a file `SKILL.md` contains `---\nname: openspec\ndescription: "Spec-driven dev"\n---\n# OpenSpec Skill\nDetailed instructions...`
- **THEN** the system parses the frontmatter into structured metadata and preserves the Markdown body as skill instructions

#### Scenario: SKILL.md without frontmatter
- **WHEN** a file `SKILL.md` starts without `---` delimiter
- **THEN** the system treats the entire content as Markdown body, using the directory name as `name` and extracting the first paragraph as `description`

### Requirement: Frontmatter schema
The frontmatter MUST support the following fields:
- `name` (string, optional): Skill identifier. Defaults to directory name.
- `description` (string, optional): Short description for prompt injection. Defaults to first paragraph of body.
- `type` (enum, required): One of `agent-capability`, `main-agent-tool`, `prompt-enrichment`.
- `commands` (string[], optional): List of slash commands associated with the skill.
- `when` (object, optional): Eligibility conditions with optional `files`, `os`, `env` sub-fields.
- `tool` (object, optional): Tool definition schema for `main-agent-tool` type skills.

#### Scenario: Frontmatter with all fields
- **WHEN** frontmatter contains `name`, `description`, `type`, `commands`, and `when` fields
- **THEN** all fields are parsed into a typed `SkillEntry` object

#### Scenario: Frontmatter with only required field
- **WHEN** frontmatter only contains `type: agent-capability`
- **THEN** `name` defaults to directory name, `description` defaults to first body paragraph, `commands` defaults to empty array, `when` defaults to null

### Requirement: Skill directory layout
Each skill MUST be a directory containing at minimum a `SKILL.md` file. The directory name serves as the default skill identifier.

#### Scenario: Valid skill directory
- **WHEN** a directory `openspec/` contains `SKILL.md`
- **THEN** the system recognizes it as a valid skill with name `openspec`

#### Scenario: Directory without SKILL.md
- **WHEN** a directory `broken-skill/` contains no `SKILL.md` file
- **THEN** the system skips this directory during discovery

### Requirement: Adapter-bundled skill location
Adapter-bundled skills MUST be stored at `src/agents/<adapter-name>-skills/<skill-name>/SKILL.md` relative to the project root.

#### Scenario: Claude Code adapter skills
- **WHEN** ClaudeCodeAdapter's `getSkillsDir()` is called
- **THEN** it returns the absolute path to `src/agents/claude-code-skills/`

### Requirement: Workspace skill location
Workspace-scoped skills MUST be stored at `<project-root>/.clipilot/skills/<skill-name>/SKILL.md`.

#### Scenario: Project with workspace skills
- **WHEN** the project directory contains `.clipilot/skills/custom-lint/SKILL.md`
- **THEN** the system discovers `custom-lint` as a workspace-scoped skill
