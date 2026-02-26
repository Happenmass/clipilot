## ADDED Requirements

### Requirement: Path-based implicit categorization
The system SHALL infer memory category from file path without additional metadata. Category mapping: `memory/core.md` → core, `memory/preferences.md` → preferences, `memory/people.md` → people, `memory/todos.md` → todos, `memory/YYYY-MM-DD.md` → daily, `MEMORY.md` or `memory.md` (root) → legacy, all other `memory/*.md` → topic.

#### Scenario: Known category files
- **WHEN** `categoryFromPath("memory/core.md")` is called
- **THEN** it returns `"core"`

#### Scenario: Date-named file
- **WHEN** `categoryFromPath("memory/2024-01-15.md")` is called
- **THEN** it returns `"daily"`

#### Scenario: Custom topic file
- **WHEN** `categoryFromPath("memory/deployment-guide.md")` is called
- **THEN** it returns `"topic"`

#### Scenario: Legacy root file
- **WHEN** `categoryFromPath("MEMORY.md")` is called
- **THEN** it returns `"legacy"`

### Requirement: Category-based search filtering
The system SHALL support an optional `category` parameter in search queries. When provided, only chunks from files matching the specified category SHALL be included in results. Category filtering SHALL be implemented as SQL WHERE clause additions.

#### Scenario: Filter by todos category
- **WHEN** search is called with `category = "todos"`
- **THEN** only chunks from `memory/todos.md` are included in search results

#### Scenario: Filter by daily category
- **WHEN** search is called with `category = "daily"`
- **THEN** only chunks from files matching `memory/YYYY-MM-DD.md` pattern are included

#### Scenario: No category filter
- **WHEN** search is called without `category` parameter
- **THEN** chunks from all categories are included

### Requirement: Lifecycle policy per category
The system SHALL apply temporal decay ONLY to the `daily` category. All other categories (`core`, `preferences`, `people`, `todos`, `legacy`, `topic`) SHALL be treated as evergreen with no decay.

#### Scenario: Evergreen category identification
- **WHEN** `isEvergreenCategory("core")` is called
- **THEN** it returns `true`

#### Scenario: Daily is not evergreen
- **WHEN** `isEvergreenCategory("daily")` is called
- **THEN** it returns `false`
