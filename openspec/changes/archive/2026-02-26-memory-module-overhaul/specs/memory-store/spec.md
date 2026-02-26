## ADDED Requirements

### Requirement: Dual storage architecture
The system SHALL maintain a dual storage architecture: Markdown files as source of truth and SQLite database as search index. Deleting the SQLite database SHALL NOT result in data loss; the index MUST be rebuildable from Markdown source files.

#### Scenario: Index rebuild after database deletion
- **WHEN** the SQLite database file is deleted and the system starts
- **THEN** the system rebuilds the full index from all Markdown files in `memory/` directory

#### Scenario: Markdown file is the canonical source
- **WHEN** a memory entry is written via `memory_write`
- **THEN** the content is persisted to a `.md` file under `memory/` AND the SQLite index is updated

### Requirement: SQLite schema initialization
The system SHALL create a SQLite database with 6 tables on first run: `meta` (index config), `files` (tracked file state), `chunks` (text chunks with embeddings), `chunks_vec` (sqlite-vec virtual table), `chunks_fts` (FTS5 virtual table), `embedding_cache` (embedding dedup cache).

#### Scenario: First run database creation
- **WHEN** the system initializes and no SQLite database exists
- **THEN** all 6 tables are created with correct schema and indexes

#### Scenario: sqlite-vec unavailable
- **WHEN** the sqlite-vec extension cannot be loaded
- **THEN** the `chunks_vec` table is NOT created and the system falls back to brute-force cosine similarity search using the `embedding` column in the `chunks` table

### Requirement: Markdown chunking
The system SHALL split Markdown files into chunks using a line-based algorithm with configurable `tokens` (default 400) and `overlap` (default 80) parameters. Token-to-character conversion SHALL use `tokens * 4`.

#### Scenario: Standard chunking
- **WHEN** a 2000-character Markdown file is chunked with default parameters (tokens=400, overlap=80)
- **THEN** chunks are produced with max 1600 characters each, overlapping by approximately 320 characters at boundaries

#### Scenario: Chunk metadata
- **WHEN** a chunk is produced
- **THEN** it includes `startLine` (1-indexed), `endLine` (1-indexed), `text`, and `hash` (SHA-256 of text)

### Requirement: Incremental index sync
The system SHALL track file state (path, content hash, mtime, size) in the `files` table and only re-index files whose hash has changed. Deleted files SHALL have their chunks removed from all index tables.

#### Scenario: Unchanged file skipped
- **WHEN** sync runs and a file's SHA-256 hash matches the stored hash
- **THEN** the file is skipped without re-chunking or re-embedding

#### Scenario: Modified file re-indexed
- **WHEN** sync runs and a file's hash differs from the stored hash
- **THEN** old chunks for that file are deleted from `chunks`, `chunks_vec`, `chunks_fts` and new chunks are inserted

#### Scenario: Deleted file cleaned up
- **WHEN** sync runs and a previously indexed file no longer exists on disk
- **THEN** all records for that file are removed from `files`, `chunks`, `chunks_vec`, `chunks_fts`

### Requirement: Workspace-local memory directory
Memory files SHALL be stored in a `memory/` directory under the workspace root. The standard file layout includes `core.md`, `preferences.md`, `people.md`, `todos.md`, date-named files (`YYYY-MM-DD.md`), and custom topic files. Legacy `MEMORY.md` / `memory.md` at workspace root SHALL also be indexed.

#### Scenario: Standard directory structure
- **WHEN** the system initializes for a workspace
- **THEN** it scans `memory/*.md` and root-level `MEMORY.md` / `memory.md` for indexing
