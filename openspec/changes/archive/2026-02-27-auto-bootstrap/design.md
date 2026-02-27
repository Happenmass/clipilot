## Context

CLIPilot 在新工作目录首次启动时，`MemoryStore` 尝试创建 SQLite 数据库，但 `{cwd}/.clipilot/` 目录不存在，`better-sqlite3` 直接抛出 TypeError。同时，local embedding provider 要求 GGUF 模型已存在于磁盘（`existsSync` 检查），且 `shouldUseLocalProvider()` 显式排除了 `hf:` 前缀路径，导致 `node-llama-cpp` 内置的 HuggingFace 自动下载能力被屏蔽。

当前初始化流程中，`ensureConfigDir()` 只创建全局 `~/.clipilot/`，项目级 `{cwd}/.clipilot/` 无人负责。

## Goals / Non-Goals

**Goals:**
- 首次启动零报错：`MemoryStore` 自行确保数据库父目录存在
- Embedding 零配置可用：无 API 密钥时通过 `hf:` 前缀自动下载本地模型
- 启动流程中自动 bootstrap，无需用户手动运行 init 命令

**Non-Goals:**
- 不新增 `clipilot init` 子命令（首次启动自动处理即可）
- 不改变 `clipilot doctor` 的现有检查项（可后续增强，不在本次范围）
- 不将 `node-llama-cpp` 变为 required dependency（仍保持 optional，降级到 FTS-only）

## Decisions

### D1: 目录创建放在 MemoryStore 构造函数内

**选择**: 在 `MemoryStore` 构造函数中，`new Database(dbPath)` 之前调用 `mkdirSync(dirname(dbPath), { recursive: true })`。

**理由**: 构造函数是同步的（`better-sqlite3` 的 `Database` 构造器是同步的），所以用 `mkdirSync` 而非 `mkdir`。这样所有 `MemoryStore` 的调用方（main.ts 主流程、remember 命令等）都自动受益，无需每个调用方单独处理。

**替代方案**: 在 `main.ts` 调用 `MemoryStore` 前手动 mkdir — 但会遗漏 `remember` 等其他入口。

### D2: 解锁 hf: 前缀并设定默认模型

**选择**: 修改 `shouldUseLocalProvider()` 逻辑，当 `modelPath` 以 `hf:` 开头时返回 `true`（由 `node-llama-cpp` 负责下载）。在 auto-detect 链中，当 `config.local.modelPath` 未显式配置时，使用一个合理的默认 `hf:` 路径。

**默认模型候选**: `hf:CompendiumLabs/bge-small-en-v1.5-gguf/bge-small-en-v1.5-q8_0.gguf`（33MB，适合 embedding 场景）。

**理由**: `node-llama-cpp` 的 `loadModel()` 原生支持 `hf:` 前缀，会自动下载到 `~/.cache/node-llama-cpp/models/`，无需自己实现下载逻辑。

**替代方案**:
- 自己实现下载逻辑到 `~/.clipilot/models/` — 重复造轮子
- 用 `@xenova/transformers` — 引入新依赖，且 `node-llama-cpp` 已在项目中

### D3: 首次启动自动 bootstrap

**选择**: 在 `main.ts` 的 bootstrap 阶段，`MemoryStore` 初始化前检测 `{cwd}/.clipilot/` 是否存在。若不存在则视为首次运行，输出一行 info 日志 "Initializing workspace..."。目录创建由 D1 中 MemoryStore 自行处理，embedding 模型下载由 D2 的 `hf:` 机制在首次 embed 调用时 lazy 触发。

**理由**: 无需显式 init 命令。目录创建是同步瞬时的；模型下载是首次 embed 时 lazy 发生的（有 `node-llama-cpp` 的进度条），不阻塞启动。

## Risks / Trade-offs

- **[首次 embed 调用慢]** → hf 模型下载在首次调用时触发，可能阻塞数秒到分钟。Mitigation: 日志提示 "Downloading embedding model..."，且系统可降级到 FTS-only 继续工作。
- **[node-llama-cpp 未安装]** → `import("node-llama-cpp")` 会抛错。Mitigation: 现有的 try-catch 已处理，会 fallback 到远程 provider 或 FTS-only。
- **[hf 下载失败（网络/墙）]** → Mitigation: auto-detect 链继续尝试下一个 provider（openai 等），最终降级 FTS-only。
- **[mkdirSync 的权限问题]** → Mitigation: 在用户自己的工作目录下创建，权限问题极少见；若发生则 better-sqlite3 的原始错误更难排查。
