## MODIFIED Requirements

### Requirement: Workspace-local memory directory
Memory files SHALL be stored in a `memory/` directory under the project's centralized storage directory at `~/.clipilot/projects/{project-id}/memory/`. The standard file layout includes `core.md`, `preferences.md`, `people.md`, `todos.md`, date-named files (`YYYY-MM-DD.md`), and custom topic files. Legacy `MEMORY.md` / `memory.md` at workspace root SHALL no longer be indexed.

#### Scenario: Standard directory structure
- **WHEN** the system initializes for a workspace
- **THEN** it scans `~/.clipilot/projects/{project-id}/memory/*.md` for indexing
- **AND** it does NOT scan the project directory for `memory/` or `MEMORY.md`

#### Scenario: Memory file write destination
- **WHEN** content is written via `memory_write` tool with path `memory/core.md`
- **THEN** the file is created at `~/.clipilot/projects/{project-id}/memory/core.md`
- **AND** no files are written to the project directory

#### Scenario: Index rebuild uses centralized storage
- **WHEN** the SQLite database is deleted and the system starts
- **THEN** the system rebuilds the index from Markdown files in `~/.clipilot/projects/{project-id}/memory/`
- **AND** does NOT look in the project directory

### Requirement: Dual storage architecture
The system SHALL maintain a dual storage architecture: Markdown files as source of truth and SQLite database as search index. Deleting the SQLite database SHALL NOT result in data loss; the index MUST be rebuildable from Markdown source files.

#### Scenario: Index rebuild after database deletion
- **WHEN** the SQLite database file at `~/.clipilot/projects/{project-id}/memory.sqlite` is deleted and the system starts
- **THEN** the system rebuilds the full index from all Markdown files in `~/.clipilot/projects/{project-id}/memory/` directory

#### Scenario: Markdown file is the canonical source
- **WHEN** a memory entry is written via `memory_write`
- **THEN** the content is persisted to a `.md` file under `~/.clipilot/projects/{project-id}/memory/` AND the SQLite index is updated

## REMOVED Requirements

### Requirement: Legacy root-level memory file support
**Reason**: 内存文件已迁移到集中存储目录，项目根目录下的 `MEMORY.md` / `memory.md` 不再被索引。
**Migration**: 将 `{project}/MEMORY.md` 内容合并到 `~/.clipilot/projects/{project-id}/memory/core.md` 中。
