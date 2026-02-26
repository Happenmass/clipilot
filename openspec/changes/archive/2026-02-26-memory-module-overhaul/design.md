## Context

CLIPilot 的 MainAgent 通过 LLM tool-use 循环指挥 Claude Code 完成开发任务。当前记忆系统（`src/core/memory.ts`）是一个 89 行的 append-only 文本系统：三个 `.md` 文件全文读取，截断到 2000 字符后注入系统提示词 `{{memory}}` 模块。无搜索能力，无分类，token 计数用 `chars/4` 粗估。

设计参考文档：`memory-module-design.md`（项目根目录），包含完整的六层架构、SQLite schema、搜索算法、嵌入提供商等详细设计。

**关键约束**：
- MainAgent 是记忆的唯一主体——所有记忆工具在 MainAgent 的 tool-use 循环中直接执行
- ContextManager 升级（而非新建 MemoryManager）以承载注入层和压缩层
- 嵌入提供商独立于 LLMClient（因为补全和嵌入可能用不同厂商）

## Goals / Non-Goals

**Goals:**
- MainAgent 能通过 `memory_search` 语义搜索历史记忆，通过 `memory_get` 精确读取，通过 `memory_write` 分类持久化
- 在上下文压缩前通过 Memory Flush 自动保存有价值的对话细节
- 用 LLM API 返回的真实 token 数替代 `chars/4` 粗估
- 支持多嵌入提供商（OpenAI / Gemini / Voyage / Mistral / 本地 GGUF），自动降级到纯 FTS 搜索
- Markdown 文件为真相源，SQLite 索引可随时重建

**Non-Goals:**
- 不做跨项目的全局记忆搜索（每个工作区独立）
- 不做实时协作/多 Agent 共享记忆
- 不做 TUI 界面中的记忆可视化（后续迭代）
- 不做旧 `~/.clipilot/memory/` 数据迁移（直接废弃）

## Decisions

### D1: 记忆工具的执行层级

**决策**: 记忆工具（memory_search / memory_get / memory_write）作为 MainAgent tool-use 循环的非 terminal 工具，与 send_to_agent 等并列。

**理由**: MainAgent 是决策中枢，它需要先查记忆再决定给 Claude Code 发什么指令。让 LLM 自行决定何时查记忆比硬编码"先查后发"更灵活。

**替代方案**:
- ~~记忆工具给 Claude Code 用~~ → CLIPilot 的定位是 meta-orchestrator，记忆应在编排层而非执行层
- ~~两阶段循环（先记忆检索，再决策执行）~~ → 过度约束 LLM 的决策自由度

**影响**: `runToolUseLoop` 的 `maxIterations` 可能需要从 10 调大到 15，因为记忆检索会消耗额外迭代。

### D2: ContextManager 升级路径

**决策**: 升级现有 ContextManager，新增 `prepareForLLM()` 方法和三层压缩支持，而非创建平行的 MemoryManager。

**理由**: ContextManager 已经管理系统提示词和对话历史，记忆注入、flush、压缩都是对同一个上下文的操作。分离会导致两个类争夺对话历史的控制权。

**关键接口变更**:

```
ContextManager (升级后)
├── prepareForLLM()          [新增] 返回 { system, messages }，内部执行 transformContext
├── reportUsage(usage)       [新增] 接收 LLM API 返回的真实 token 数
├── shouldRunMemoryFlush()   [新增] flush 阈值判断（60%）
├── runMemoryFlush()         [新增] 独立 LLM 调用 + 直接调 MemoryStore.write()
├── shouldCompress()         [已有，升级] 改用混合 token 计数
├── compress()               [已有，升级] 压缩后注入 post-compaction context
├── updateModule()           [不变]
├── addMessage()             [升级] 累计 pendingChars 增量
└── getMessages()            [保留] 返回原始对话（flush 需要读原始历史）
```

**ContextManager 新增依赖**: MemoryStore（用于 flush 写入）、PromptLoader（用于 flush 提示词）

### D3: transformContext 挂载方式

**决策**: 新增 `prepareForLLM()` 显式方法，而非在 `getMessages()` 内部透明拦截。

**理由**: 原始对话历史必须保持不变——Memory Flush 需要读完整历史来决定持久化什么。`prepareForLLM()` 对原始数据做 `structuredClone` 后再变换，MainAgent 调用方式改为 `const { system, messages } = contextManager.prepareForLLM()`。

### D4: Memory Flush 中 memory_write 的执行方式

**决策**: ContextManager 在 `runMemoryFlush()` 中直接调用 `MemoryStore.write()`，不经过 MainAgent 的工具执行路径。

**理由**: Flush 是 ContextManager 内部的自治行为，不需要经过 MainAgent 的决策循环。直接调用避免了 ContextManager ↔ MainAgent 的循环依赖。memory_write 的核心逻辑（路径校验、追加写入、标记 dirty）封装在 MemoryStore 中，两个调用者（MainAgent.executeTool 和 ContextManager.runMemoryFlush）共用同一个 MemoryStore 实例。

### D5: flush 与 compress 的阈值协调

**决策**: 统一使用相对比例阈值——flush 60%，compress 70%，gap 为上下文窗口的 10%。

**理由**: 设计文档的绝对值公式（`contextWindow - reserve - softThreshold`）依赖 `reserveTokensFloor` 参数，不同参数设置可能导致 flush 阈值高于 compress 阈值（顺序颠倒）。统一比例保证关系确定，gap 约 12,800 tokens（128K 窗口），足够 5-8 轮工具调用。

**不变式**: `flushThreshold < compressionThreshold`，构造函数中校验。

**执行顺序**（MainAgent.runToolUseLoop 开头）:
1. `shouldRunMemoryFlush()` → `runMemoryFlush()`（Layer 2）
2. `shouldCompress()` → `compress()`（Layer 3）
3. 两者可在同一轮同时触发，顺序执行保证 flush 先于 compress

### D6: Token 计数混合模式

**决策**: 以 LLM API 返回的 `usage.inputTokens + outputTokens` 为精确基线，用 `chars/4` 估算两次调用之间的增量。

**理由**: 当前 `chars/4` 在中文场景下低估约 60%，在代码场景下低估约 25%。API 返回的 usage 是精确值但只在调用后可用。混合模式：每次 LLM 调用后校准基线（`lastKnownTokenCount`），新消息加入时累计 `pendingChars`，阈值判断用 `lastKnownTokenCount + pendingChars/4`。增量部分的误差无关紧要（通常只有几千字符）。

### D7: 嵌入提供商架构

**决策**: 独立的 `EmbeddingProvider` 接口和工厂模式，不扩展 LLMClient。

**理由**: Anthropic 没有嵌入 API——用 Claude 做补全但用 OpenAI 做嵌入是常见场景。嵌入提供商需要独立的 API Key、端点、重试策略。

**降级链**: auto 模式按 `local → openai → gemini → voyage → mistral` 顺序尝试，全部不可用时降级为纯 FTS5 关键词搜索（`provider = null`）。

### D8: 旧 Memory 类处置

**决策**: 直接废弃 `src/core/memory.ts`，不提供迁移路径。

**理由**: 旧系统存储在 `~/.clipilot/memory/projects/<hash>/`，结构与新系统完全不同。项目处于 v0.1.0 早期阶段，无外部用户依赖旧数据。

## Risks / Trade-offs

- **[依赖复杂度急剧增加]** → 当前仅 2 个生产依赖（`@anthropic-ai/sdk` + `chalk`），改造后新增 `better-sqlite3` / `sqlite-vec`（C 扩展需编译）/ `chokidar`。缓解：sqlite-vec 设为可选（后备暴力余弦搜索），FTS5 不可用时降级为纯向量搜索
- **[嵌入 API 成本]** → 每次索引同步需调用嵌入 API。缓解：嵌入缓存（基于文本哈希的四元组主键），增量同步（仅变更文件重新索引），auto 降级到本地 GGUF
- **[flush 的 LLM 调用增加延迟]** → 每次 flush 是一次额外的 LLM round-trip。缓解：flush 频率受 `lastFlushCompactionCount` 控制，同一压缩周期内只触发一次
- **[ContextManager 职责膨胀]** → 从 107 行升级到预计 300+ 行。缓解：Layer 1（transformContext）和 flush 逻辑可抽取为独立函数，ContextManager 只做编排
- **[跨平台 SQLite 兼容性]** → `sqlite-vec` 是 C 扩展，部分平台可能编译失败。缓解：运行时检测扩展可用性，不可用时回退到暴力搜索（从 chunks 表加载全部向量到内存）
