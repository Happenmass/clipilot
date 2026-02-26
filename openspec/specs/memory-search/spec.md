## ADDED Requirements

### Requirement: Hybrid search with weighted merging
The system SHALL execute vector search (KNN) and keyword search (FTS5 BM25) in parallel, then merge results by chunk ID with configurable weights (default: vector 0.7, keyword 0.3). A chunk hit by both paths SHALL receive a combined score.

#### Scenario: Dual-path hit
- **WHEN** a search query matches chunk C via both vector (score 0.8) and keyword (score 0.6)
- **THEN** chunk C's merged score is `0.7 * 0.8 + 0.3 * 0.6 = 0.74`

#### Scenario: Single-path hit
- **WHEN** a chunk is only hit by vector search (score 0.8) and not by keyword search
- **THEN** the chunk's merged score is `0.7 * 0.8 + 0.3 * 0 = 0.56`

### Requirement: Vector search via sqlite-vec
The system SHALL embed the query text using the configured embedding provider, then execute KNN search on `chunks_vec` using cosine distance. Vector score SHALL be calculated as `1 - distance`.

#### Scenario: Normal vector search
- **WHEN** a query is embedded and searched against `chunks_vec`
- **THEN** results are returned sorted by ascending cosine distance, limited to the configured candidate count

#### Scenario: Brute-force fallback
- **WHEN** sqlite-vec is unavailable
- **THEN** the system loads all chunk embeddings from the `chunks` table into memory and computes cosine similarity in JavaScript

### Requirement: Keyword search via FTS5
The system SHALL convert the query into FTS5 MATCH syntax by extracting word tokens and joining with AND. BM25 rank SHALL be converted to a 0-1 score via `1 / (1 + rank)`.

#### Scenario: FTS query construction
- **WHEN** the query is "deploy staging config"
- **THEN** the FTS5 MATCH expression is `"deploy" AND "staging" AND "config"`

#### Scenario: Empty token extraction
- **WHEN** the query contains no matchable tokens (e.g., only punctuation)
- **THEN** keyword search returns empty results

### Requirement: Temporal decay for dated files
The system SHALL apply exponential decay to search scores for date-named memory files (`memory/YYYY-MM-DD.md`). Decay formula: `score * exp(-λ * ageInDays)` where `λ = ln(2) / halfLifeDays` (default halfLife: 30 days). Non-dated (evergreen) files SHALL NOT be decayed.

#### Scenario: 30-day-old daily log
- **WHEN** a chunk from `memory/2024-01-15.md` is scored and today is 2024-02-14
- **THEN** its score is multiplied by approximately 0.5

#### Scenario: Evergreen file not decayed
- **WHEN** a chunk from `memory/core.md` is scored
- **THEN** its score is NOT modified by temporal decay (multiplier = 1.0)

### Requirement: Minimum score filtering and Top-K
The system SHALL filter out results below a configurable minimum score (default 0.1) and return at most Top-K results (default 10), sorted by descending score.

#### Scenario: Below minimum score
- **WHEN** a merged result has score 0.05 and minScore is 0.1
- **THEN** the result is excluded from the final output

### Requirement: FTS-only degraded mode
When no embedding provider is available (`provider = null`), the system SHALL fall back to pure FTS5 keyword search without vector scoring. If FTS5 is also unavailable, search SHALL return empty results.

#### Scenario: No embedding provider
- **WHEN** `createEmbeddingProvider()` returns `provider = null`
- **THEN** search uses only FTS5 keyword results with `textWeight = 1.0`
