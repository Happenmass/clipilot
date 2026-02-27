## Why

CLIPilot 首次在新工作目录启动时，因 `{cwd}/.clipilot/` 目录不存在导致 `MemoryStore` 初始化失败（better-sqlite3 抛出 "Cannot open database because the directory does not exist"）。同时，local embedding provider 要求 GGUF 模型文件已存在于磁盘，不支持自动下载，使得零配置启动体验不完整。

## What Changes

- `MemoryStore` 构造函数内自动确保数据库父目录存在（`mkdir -p`），消除首次启动的 fatal error
- 解锁 `node-llama-cpp` 内置的 `hf:` 前缀模型下载能力，local embedding provider 可自动从 HuggingFace 下载模型
- 配置一个合理的默认 `hf:` 模型路径，使 `embeddingProvider: "auto"` 在无 API 密钥时也能自动使用本地模型
- 启动流程中增加 bootstrap 检测，首次运行时自动完成目录创建、依赖检查等初始化工作

## Capabilities

### New Capabilities
- `auto-bootstrap`: 首次启动自动初始化流程，包括目录创建、embedding 模型就绪检测

### Modified Capabilities
- `memory-store`: MemoryStore 构造函数增加目录自动创建逻辑
- `embedding-provider`: 支持 `hf:` 前缀的模型路径，实现自动下载

## Impact

- **代码**: `src/memory/store.ts`（构造函数）、`src/memory/embedder.ts`（shouldUseLocalProvider + 默认模型）、`src/main.ts`（bootstrap 流程）
- **依赖**: `node-llama-cpp` 从 optional peer 变为更关键的角色（但仍可降级到 FTS-only）
- **用户体验**: 新用户首次运行不再报错，embedding 零配置可用
