## 1. MemoryStore 目录自动创建

- [x] 1.1 在 `src/memory/store.ts` 的 `MemoryStore` 构造函数中，`new Database(dbPath)` 之前添加 `mkdirSync(dirname(dbPath), { recursive: true })`
- [x] 1.2 添加测试：验证 MemoryStore 在父目录不存在时能正常初始化

## 2. Embedding Provider 支持 hf: 自动下载

- [x] 2.1 修改 `src/memory/embedder.ts` 的 `shouldUseLocalProvider()`，当 modelPath 以 `hf:` 开头时返回 `true`
- [x] 2.2 在 `tryCreateProvider("local", ...)` 中，为 auto-detect 模式配置默认 `hf:` 模型路径（当 `config.local?.modelPath` 未设置时）
- [x] 2.3 添加测试：验证 `shouldUseLocalProvider("hf:user/repo/file.gguf")` 返回 `true`

## 3. 首次启动 Bootstrap 日志

- [x] 3.1 在 `src/main.ts` 的 bootstrap 阶段，检测 `{cwd}/.clipilot/` 是否存在，首次运行时输出 info 日志 "Initializing workspace..."
- [x] 3.2 验证端到端流程：在空目录中启动 CLIPilot 不再抛出 fatal error
