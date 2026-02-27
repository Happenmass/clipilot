## ADDED Requirements

### Requirement: When-condition evaluation
The system SHALL evaluate the optional `when` conditions on each discovered skill. A skill passes filtering only if ALL specified conditions are met.

#### Scenario: File existence condition passes
- **WHEN** skill has `when.files: [".openspec.yaml"]` and the workspace contains `.openspec.yaml`
- **THEN** the skill passes the file condition

#### Scenario: File existence condition fails
- **WHEN** skill has `when.files: ["Cargo.toml"]` and the workspace does not contain `Cargo.toml`
- **THEN** the skill is filtered out

#### Scenario: OS condition passes
- **WHEN** skill has `when.os: ["darwin", "linux"]` and the current platform is `darwin`
- **THEN** the skill passes the OS condition

#### Scenario: OS condition fails
- **WHEN** skill has `when.os: ["win32"]` and the current platform is `darwin`
- **THEN** the skill is filtered out

#### Scenario: Environment variable condition
- **WHEN** skill has `when.env: ["GITHUB_TOKEN"]` and `GITHUB_TOKEN` is set in the environment
- **THEN** the skill passes the env condition

#### Scenario: No when conditions
- **WHEN** skill has no `when` field
- **THEN** the skill always passes filtering

### Requirement: Config-based disable list
The system SHALL support a `skills.disabled` array in CLIPilot config that lists skill names to exclude.

#### Scenario: Skill in disabled list
- **WHEN** config contains `skills.disabled: ["superpower"]` and `superpower` skill is discovered
- **THEN** the `superpower` skill is filtered out regardless of when-conditions

#### Scenario: Empty disabled list
- **WHEN** config has no `skills.disabled` or it is empty
- **THEN** no skills are filtered by config

### Requirement: Filter order
The system SHALL apply filters in this order: config disable list first, then when-conditions. Skills rejected by the disable list MUST NOT be evaluated for when-conditions.

#### Scenario: Disabled skill with passing when-conditions
- **WHEN** skill `openspec` is in the disable list and its `when.files` condition would pass
- **THEN** the skill is still filtered out (disable list takes precedence)
