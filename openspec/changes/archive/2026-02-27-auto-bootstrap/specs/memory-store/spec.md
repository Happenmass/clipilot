## MODIFIED Requirements

### Requirement: SQLite schema initialization
The system SHALL create a SQLite database with 6 tables on first run: `meta` (index config), `files` (tracked file state), `chunks` (text chunks with embeddings), `chunks_vec` (sqlite-vec virtual table), `chunks_fts` (FTS5 virtual table), `embedding_cache` (embedding dedup cache). The `MemoryStore` constructor SHALL ensure the database file's parent directory exists before opening the database, using recursive directory creation.

#### Scenario: First run database creation
- **WHEN** the system initializes and no SQLite database exists
- **THEN** all 6 tables are created with correct schema and indexes

#### Scenario: sqlite-vec unavailable
- **WHEN** the sqlite-vec extension cannot be loaded
- **THEN** the `chunks_vec` table is NOT created and the system falls back to brute-force cosine similarity search using the `embedding` column in the `chunks` table

#### Scenario: Database parent directory does not exist
- **WHEN** the `MemoryStore` is constructed with a `dbPath` whose parent directory does not exist
- **THEN** the parent directory is created recursively before the database is opened, and no error is thrown
