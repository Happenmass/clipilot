## ADDED Requirements

### Requirement: Two-source discovery
The system SHALL discover skills from exactly two sources in priority order:
1. Adapter-bundled skills (low priority) — from `adapter.getSkillsDir()`
2. Workspace skills (high priority) — from `<workspaceDir>/.clipilot/skills/`

#### Scenario: Both sources have skills
- **WHEN** adapter skills dir contains `openspec/SKILL.md` and `commit/SKILL.md`, and workspace contains `deploy/SKILL.md`
- **THEN** all three skills are discovered: `openspec`, `commit`, `deploy`

#### Scenario: Adapter provides no skills dir
- **WHEN** `adapter.getSkillsDir()` returns undefined
- **THEN** only workspace skills are discovered

#### Scenario: No workspace skills directory
- **WHEN** `<workspaceDir>/.clipilot/skills/` does not exist
- **THEN** only adapter-bundled skills are discovered

### Requirement: Same-name override
When both sources contain a skill with the same name, the workspace version SHALL override the adapter-bundled version.

#### Scenario: Workspace overrides adapter skill
- **WHEN** adapter skills dir contains `commit/SKILL.md` with description "default commit" and workspace contains `commit/SKILL.md` with description "custom commit"
- **THEN** the discovered `commit` skill uses the workspace version with description "custom commit"

### Requirement: Frontmatter parsing
The discovery process SHALL parse each `SKILL.md` file's YAML frontmatter into a typed `SkillEntry` structure containing: name, description, type, commands, when conditions, source, and file path.

#### Scenario: Parse complete frontmatter
- **WHEN** `SKILL.md` frontmatter contains `name: openspec`, `description: "Spec-driven dev"`, `type: agent-capability`, `commands: [/opsx:new, /opsx:ff]`
- **THEN** `SkillEntry` is created with all fields populated and `source` set to the originating directory type

#### Scenario: Malformed frontmatter
- **WHEN** `SKILL.md` frontmatter is syntactically invalid
- **THEN** the skill is skipped with a warning logged, and discovery continues with remaining skills

### Requirement: Discovery safety limits
The system SHALL enforce a maximum of 50 discovered skills total and a maximum of 100KB per SKILL.md file.

#### Scenario: Exceeding skill count limit
- **WHEN** the combined skill count from both sources exceeds 50
- **THEN** skills are loaded up to 50, prioritizing workspace skills, and a warning is logged

#### Scenario: Oversized SKILL.md
- **WHEN** a SKILL.md file exceeds 100KB
- **THEN** the skill is skipped with a warning logged
