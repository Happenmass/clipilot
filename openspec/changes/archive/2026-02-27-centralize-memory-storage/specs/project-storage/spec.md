## ADDED Requirements

### Requirement: Project storage directory resolution
The system SHALL resolve a per-project storage directory under `~/.clipilot/projects/` using a deterministic project-id derived from the project's absolute path. The project-id format SHALL be `{basename}-{hash}` where `basename` is the project directory name (lowercase) and `hash` is the first 6 characters of the SHA-256 hex digest of the absolute path.

#### Scenario: Standard project-id generation
- **WHEN** the project directory is `/Users/guhappen/code/clipilot`
- **THEN** the project-id is `clipilot-{first 6 chars of sha256("/Users/guhappen/code/clipilot")}`
- **AND** the storage directory is `~/.clipilot/projects/clipilot-{hash}/`

#### Scenario: Same-name projects in different paths
- **WHEN** two projects exist at `/home/user/work/api` and `/home/user/personal/api`
- **THEN** they produce different project-ids due to different path hashes (e.g., `api-a1b2c3` and `api-d4e5f6`)

#### Scenario: Storage directory auto-creation
- **WHEN** `getProjectStorageDir(projectDir)` is called and the target directory does not exist
- **THEN** the directory is created recursively (including parent `projects/` if needed)

### Requirement: Project storage directory structure
The per-project storage directory SHALL contain only memory-related files. The directory structure SHALL be:
```
~/.clipilot/projects/{project-id}/
├── memory.sqlite          (search index)
└── memory/                (Markdown source files)
    ├── core.md
    ├── preferences.md
    └── ...
```

#### Scenario: Clean storage layout
- **WHEN** a project's storage directory is inspected
- **THEN** it contains `memory.sqlite` (and WAL files) and a `memory/` subdirectory with `.md` files
- **AND** no other CLIPilot artifacts (no skills, prompts, or config files)
