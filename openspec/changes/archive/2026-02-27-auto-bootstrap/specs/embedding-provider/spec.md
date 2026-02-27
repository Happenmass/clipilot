## MODIFIED Requirements

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
