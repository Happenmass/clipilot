## Why

当前记忆模块（`src/core/memory.ts`，89 行）是一个纯文本 append-only 系统：三个 `.md` 文件、`chars / 4` 的粗略 token 估算、全文截断到 2000 字符注入系统提示词。它无法语义搜索、无法分类管理、无法在上下文压缩前持久化有价值的细节。随着 CLIPilot 处理的任务链变长、跨会话记忆需求增加，这个模块已经成为瓶颈。

## What Changes

- **新增 `src/memory/` 模块**：实现六层记忆架构（存储层、索引层、搜索层、分类层、写入层、注入层），以 Markdown 文件为真相源、SQLite 为搜索索引
- **新增 3 个 MainAgent 工具**：`memory_search`（混合语义+关键词搜索）、`memory_get`（按行号读取原文）、`memory_write`（分类写入 memory/*.md）
- **新增独立嵌入提供商**：`EmbeddingProvider` 接口 + 工厂模式，支持 OpenAI / Gemini / Voyage / Mistral / 本地 GGUF，独立于 LLMClient
- **升级 ContextManager**：新增 `prepareForLLM()` 显式调用替代 `getMessages()`；新增工具结果上下文守卫（Layer 1）；新增 Memory Flush 触发（Layer 2，在 compress 之前持久化重要信息）；统一 flush/compress 比例阈值（60%/70%）
- **升级 token 计数**：混合模式——以 LLM API 返回的 `usage.inputTokens` + `usage.outputTokens` 为精确基线，用 `chars/4` 估算两次调用之间的增量
- **BREAKING** 废弃 `src/core/memory.ts`（旧 Memory 类）：不提供迁移，直接替换。旧的 `~/.clipilot/memory/` 目录结构不再使用，改为工作区本地 `memory/` 目录
- **新增系统提示词**：`prompts/memory-flush.md`（flush 专用）；更新 `prompts/main-agent.md`（加入记忆使用指引段落）

## Capabilities

### New Capabilities
- `memory-store`: 双存储架构（Markdown 源文件 + SQLite 搜索索引），包含 6 表 schema、增量同步、Markdown 分块算法
- `memory-search`: 混合搜索引擎（向量 KNN + FTS5 BM25 加权合并）、时间衰减、MMR 多样性重排、分类过滤
- `memory-category`: 基于文件路径的隐式分类体系（core / preferences / people / todos / daily / legacy / topic），生命周期策略
- `embedding-provider`: 统一嵌入提供商抽象层，工厂模式 + auto 降级链 + FTS-only 后备、嵌入缓存、批量处理、重试机制
- `memory-tools`: MainAgent 的 3 个记忆工具定义与执行逻辑（memory_search / memory_get / memory_write）
- `context-manager-upgrade`: ContextManager 升级——prepareForLLM()、工具结果上下文守卫、Memory Flush、混合 token 计数、统一比例阈值

### Modified Capabilities

（无已有 spec 需要修改）

## Impact

- **依赖新增**：`better-sqlite3`（或 Node 22+ 内置 `node:sqlite`）、`sqlite-vec`（C 扩展）、`chokidar`（文件监控）；可选 `node-llama-cpp`（本地嵌入）
- **受影响代码**：`src/core/main-agent.ts`（+3 工具）、`src/core/context-manager.ts`（重大升级）、`src/main.ts`（初始化流程）、`prompts/main-agent.md`（提示词更新）
- **废弃代码**：`src/core/memory.ts` 整个删除
- **配置变更**：`~/.clipilot/config.json` 新增 `memory` 和 `embedding` 配置段
- **文件系统变更**：工作区新增 `memory/` 目录（core.md、preferences.md 等）；SQLite 数据库存储于 `~/.clipilot/state/memory/<hash>.sqlite`
