## ADDED Requirements

### Requirement: ContextManager 管理模块化系统提示词

ContextManager SHALL 持有一个 prompt 模板（从 `main-agent.md` 加载）和一个 `modules: Map<string, string>`。`getSystemPrompt()` 方法 SHALL 将模板中的所有 `{{key}}` 占位符替换为对应 module 的值。

支持的模块：
- `goal`: 当前开发目标
- `task_graph_summary`: TaskGraph 的格式化摘要
- `compressed_history`: 压缩后的对话历史
- `memory`: 跨会话记忆

#### Scenario: 系统提示词模块替换

- **WHEN** `modules` 中 `goal` 为 "添加JWT认证"，`compressed_history` 为 ""
- **THEN** `getSystemPrompt()` 返回的字符串中 `{{goal}}` 被替换为 "添加JWT认证"，`{{compressed_history}}` 被替换为空字符串

#### Scenario: 动态更新模块

- **WHEN** 调用 `updateModule("task_graph_summary", "[✓]#1 [▶]#2")`
- **THEN** 下次 `getSystemPrompt()` 调用时 `{{task_graph_summary}}` 被替换为新值

### Requirement: ContextManager 维护对话历史

ContextManager SHALL 维护 `conversation: LLMMessage[]`，提供 `addMessage(msg)` 和 `getMessages()` 方法。`addMessage` SHALL 追加消息到 conversation 数组末尾。

#### Scenario: 追加消息

- **WHEN** 调用 `addMessage({ role: "user", content: "[TASK_READY] ..." })`
- **THEN** `getMessages()` 返回的数组末尾包含该消息

### Requirement: ContextManager 按窗口余量触发压缩

ContextManager SHALL 提供 `shouldCompress()` 方法，通过估算 `systemPrompt + conversation` 的总 token 数判断是否需要压缩。当总 token 数超过配置的上下文窗口限制的 70% 时，SHALL 返回 true。

token 估算 SHALL 使用简单的字符数/4 近似。

#### Scenario: 未超过阈值

- **WHEN** systemPrompt 约 2000 tokens，conversation 约 5000 tokens，窗口限制 128000
- **THEN** `shouldCompress()` 返回 false

#### Scenario: 超过阈值

- **WHEN** systemPrompt 约 2000 tokens，conversation 约 88000 tokens，窗口限制 128000
- **THEN** `shouldCompress()` 返回 true（总量 90000 > 128000 * 0.7 = 89600）

### Requirement: ContextManager 压缩对话历史

`compress()` 方法 SHALL：
1. 取出当前 `compressed_history` 模块值
2. 调用 LLM（使用 `history-compressor.md` 系统提示词）将 `existing_history + conversation` 压缩为结构化摘要
3. 将压缩结果写入 `compressed_history` 模块
4. 清空 `conversation` 数组

压缩后的 history SHALL 包含以下结构化部分：已完成任务摘要、当前任务进展、关键决策记录、已知问题。

#### Scenario: 首次压缩

- **WHEN** `compressed_history` 为空，conversation 包含 30 轮对话
- **THEN** 压缩后 `compressed_history` 包含结构化摘要，`conversation` 被清空为 `[]`

#### Scenario: 增量压缩

- **WHEN** `compressed_history` 已有之前压缩的内容，conversation 又积累了 25 轮对话
- **THEN** 压缩时 LLM 同时接收 existing_history 和新 conversation，生成合并后的摘要

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
