## ADDED Requirements

### Requirement: First-run workspace initialization
The system SHALL detect first-run state (absence of `{cwd}/.clipilot/` directory) and automatically complete initialization without requiring a separate init command. A log message SHALL be emitted indicating workspace initialization.

#### Scenario: First run in new workspace
- **WHEN** CLIPilot starts in a directory that has no `.clipilot/` subdirectory
- **THEN** the system logs "Initializing workspace..." and proceeds with normal startup without error

#### Scenario: Subsequent runs
- **WHEN** CLIPilot starts in a directory that already has `.clipilot/` subdirectory
- **THEN** no initialization message is logged and startup proceeds normally
