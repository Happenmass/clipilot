## ADDED Requirements

### Requirement: Unified embedding provider interface
All embedding providers SHALL implement the `EmbeddingProvider` interface: `id` (string), `model` (string), `maxInputTokens` (optional number), `embedQuery(text) → number[]`, `embedBatch(texts) → number[][]`. `embedQuery` is for search queries, `embedBatch` is for indexing documents.

#### Scenario: Provider interface compliance
- **WHEN** any embedding provider is created (OpenAI, Gemini, Voyage, Mistral, local)
- **THEN** it exposes all fields defined in `EmbeddingProvider` interface

### Requirement: Factory with auto-detection and fallback
The `createEmbeddingProvider()` factory SHALL support three modes: `"auto"` (detect available providers in order: local → openai → gemini → voyage → mistral), explicit provider name with optional fallback, and `null` result for FTS-only degradation. In auto mode, when no explicit local model path is configured, the factory SHALL use a default `hf:` model path for the local provider.

#### Scenario: Auto mode with no config and no API keys
- **WHEN** provider is `"auto"`, no local model path configured, no API keys set, and `node-llama-cpp` is installed
- **THEN** the default `hf:` model is used, downloaded on first embed call

#### Scenario: Auto mode with no config, no API keys, no node-llama-cpp
- **WHEN** provider is `"auto"`, no local model path configured, no API keys set, and `node-llama-cpp` is NOT installed
- **THEN** `provider = null` is returned (FTS-only mode)

#### Scenario: Auto mode with OpenAI key available
- **WHEN** provider is `"auto"`, no local model configured, and `OPENAI_API_KEY` is set
- **THEN** an OpenAI embedding provider is returned

#### Scenario: Explicit provider with fallback
- **WHEN** provider is `"voyage"` with `fallback = "openai"`, and Voyage auth fails but OpenAI key is available
- **THEN** an OpenAI provider is returned with `fallbackFrom = "voyage"` and `fallbackReason` set

### Requirement: OpenAI-compatible remote providers
OpenAI and Mistral SHALL use a shared `createRemoteEmbeddingProvider()` factory that calls the `/embeddings` endpoint with `{ model, input }` body and `Authorization: Bearer` header. API keys SHALL be resolved from explicit config first, then environment variables (`OPENAI_API_KEY`, `MISTRAL_API_KEY`).

#### Scenario: OpenAI embedding request
- **WHEN** `embedBatch(["hello", "world"])` is called on OpenAI provider
- **THEN** a POST request to `https://api.openai.com/v1/embeddings` is sent with `{ model: "text-embedding-3-small", input: ["hello", "world"] }`

### Requirement: Gemini provider with API key rotation
The Gemini provider SHALL support multiple API keys and rotate to the next key on failure. It SHALL use `taskType: "RETRIEVAL_QUERY"` for `embedQuery` and `taskType: "RETRIEVAL_DOCUMENT"` for `embedBatch`.

#### Scenario: Key rotation on failure
- **WHEN** the first API key returns a rate limit error
- **THEN** the system retries with the next key in the rotation

### Requirement: Local embedding provider
The system SHALL support local GGUF model embedding via `node-llama-cpp` with lazy loading (model loaded on first use). Output vectors SHALL be sanitized (non-finite values → 0) and L2-normalized. The local provider SHALL support `hf:` prefixed model paths, delegating download to `node-llama-cpp`'s built-in HuggingFace integration.

#### Scenario: Lazy model loading
- **WHEN** the local provider is created
- **THEN** the model is NOT loaded until the first `embedQuery` or `embedBatch` call

#### Scenario: HuggingFace model auto-download
- **WHEN** the local provider is configured with a `hf:` prefixed model path (e.g., `hf:CompendiumLabs/bge-small-en-v1.5-gguf/bge-small-en-v1.5-q8_0.gguf`)
- **THEN** `node-llama-cpp` downloads the model on first use and caches it locally

#### Scenario: HuggingFace download failure
- **WHEN** a `hf:` model path is configured but download fails (network error)
- **THEN** the local provider creation fails and the auto-detect chain continues to the next provider

### Requirement: Embedding cache
The system SHALL cache embeddings in the `embedding_cache` table keyed by `(provider, model, provider_key, hash)`. On index sync, cached embeddings SHALL be used for unchanged text chunks. LRU eviction SHALL remove oldest entries when exceeding `maxEntries`.

#### Scenario: Cache hit during indexing
- **WHEN** a chunk's text hash matches a cached entry for the same provider/model
- **THEN** the cached embedding is used without calling the embedding API

#### Scenario: LRU eviction
- **WHEN** cache exceeds `maxEntries` after inserting new embeddings
- **THEN** the oldest entries (by `updated_at`) are deleted to bring count to `maxEntries`

### Requirement: Input token limit enforcement
The system SHALL enforce embedding model input token limits. Chunks exceeding `maxInputTokens * 4` characters SHALL be split into sub-chunks before embedding.

#### Scenario: Oversized chunk
- **WHEN** a chunk has 10,000 characters and the model limit is 8192 tokens (32,768 chars)
- **THEN** the chunk is passed as-is (within limit)

#### Scenario: Extremely large chunk
- **WHEN** a chunk has 40,000 characters and the model limit is 8192 tokens (32,768 chars)
- **THEN** the chunk is split into two sub-chunks for embedding

### Requirement: Retry with exponential backoff
Embedding API calls SHALL retry up to 3 times with exponential backoff (500ms base, 8000ms max). Authentication errors SHALL NOT be retried.

#### Scenario: Transient API failure
- **WHEN** the first embedding API call fails with a 500 error
- **THEN** the system retries after 500ms, then 1000ms if needed

#### Scenario: Auth failure no retry
- **WHEN** the embedding API returns 401 Unauthorized
- **THEN** the error is thrown immediately without retry
