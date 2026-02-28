## MODIFIED Requirements

### Requirement: ContextManager 构造函数接受配置

ContextManager 构造函数 SHALL 接受以下配置：
- `llmClient: LLMClient` — 用于压缩调用
- `promptLoader: PromptLoader` — 用于加载 main-agent.md 和 history-compressor.md
- `contextWindowLimit: number` — 上下文窗口大小（tokens），默认 128000
- `compressionThreshold: number` — 压缩触发阈值（0-1），默认 0.7
- `flushThreshold: number` — 内存刷写阈值（0-1），默认 0.6，MUST 小于 compressionThreshold
- `memoryStore: MemoryStore` — 可选，用于 flush 写入
- `toolResultRetention: number` — 工具结果滑动窗口大小，默认 20。仅保留最近 N 个 tool result 的完整内容，更早的替换为摘要。

#### Scenario: 自定义窗口限制

- **WHEN** `new ContextManager({ contextWindowLimit: 32000, compressionThreshold: 0.6, ... })`
- **THEN** 当 token 数超过 32000 * 0.6 = 19200 时触发压缩

#### Scenario: 自定义工具结果保留数

- **WHEN** `new ContextManager({ toolResultRetention: 10, ... })`
- **THEN** `transformContext()` 仅保留最近 10 个 tool result 完整内容，更早的替换为摘要

#### Scenario: 默认工具结果保留数

- **WHEN** `new ContextManager({ ... })` 且未指定 `toolResultRetention`
- **THEN** 默认保留最近 20 个 tool result
