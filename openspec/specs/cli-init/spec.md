### Requirement: clipilot init command
The system SHALL provide a `clipilot init` subcommand that initializes project-level CLIPilot configuration directories in the current working directory. This command SHALL create `{cwd}/.clipilot/skills/` and `{cwd}/.clipilot/prompts/` directories with `.gitkeep` placeholder files.

#### Scenario: First-time initialization
- **WHEN** `clipilot init` is run in a directory without `.clipilot/`
- **THEN** the following structure is created:
  - `{cwd}/.clipilot/skills/.gitkeep`
  - `{cwd}/.clipilot/prompts/.gitkeep`
- **AND** a success message is printed

#### Scenario: Re-initialization with existing directory
- **WHEN** `clipilot init` is run in a directory that already has `.clipilot/skills/`
- **THEN** existing directories and files are preserved (no overwrite)
- **AND** only missing directories or files are created

#### Scenario: Init does not create memory files
- **WHEN** `clipilot init` is run
- **THEN** no `memory/`, `memory.sqlite`, or any memory-related files are created in the project directory
- **AND** no files are created under `~/.clipilot/projects/` (memory storage is created on first run, not on init)
