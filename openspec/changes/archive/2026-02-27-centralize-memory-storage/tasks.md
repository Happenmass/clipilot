## 1. 项目存储目录解析

- [x] 1.1 在 `src/utils/config.ts` 中新增 `getProjectStorageDir(projectDir: string): string` 函数，使用 `{basename}-{sha256(absPath).slice(0,6)}` 策略生成路径，返回 `~/.clipilot/projects/{project-id}/`
- [x] 1.2 新增 `ensureProjectStorageDir(projectDir: string): Promise<string>` 函数，调用 `getProjectStorageDir` 并确保目录存在（`mkdir -p`）
- [x] 1.3 为 `getProjectStorageDir` 编写单元测试：验证 project-id 格式、同名不同路径项目生成不同 id、结果稳定（同输入同输出）

## 2. MemoryStore 存储路径重构

- [x] 2.1 修改 `MemoryStoreConfig`：新增 `storageDir` 字段，`workspaceDir` 保留但含义变为"项目位置"（仅用于 skills/prompts 发现等场景）
- [x] 2.2 修改 `MemoryStore.write()` 方法：文件写入路径从 `join(this.workspaceDir, relPath)` 改为 `join(this.storageDir, relPath)`
- [x] 2.3 修改 `listMemoryFiles()` 函数：扫描路径从 `join(workspaceDir, "memory")` 改为 `join(storageDir, "memory")`，移除对 `MEMORY.md` / `memory.md` 的遗留扫描
- [x] 2.4 修改 `isMemoryPath()` 函数：移除对 `MEMORY.md` / `memory.md` 的兼容判断，仅允许 `memory/` 前缀
- [x] 2.5 更新 `test/memory/store.test.ts`：所有路径断言适配新的 storageDir 逻辑

## 3. sync.ts 适配

- [x] 3.1 修改 `syncMemoryFiles` 函数：将 `store.getWorkspaceDir()` 的调用改为使用 storageDir（通过 store 的新 accessor `getStorageDir()`）
- [x] 3.2 更新 `test/memory/sync.test.ts`（如有）：路径断言适配（无此文件，跳过）

## 4. main.ts 启动流程修改

- [x] 4.1 替换 `clipilotDir = join(args.cwd, ".clipilot")` 模式：改用 `ensureProjectStorageDir(args.cwd)` 获取 storageDir
- [x] 4.2 将 `dbPath` 计算改为 `join(storageDir, "memory.sqlite")`
- [x] 4.3 构建 `MemoryStore` 时传入 `storageDir` 和 `workspaceDir`（`args.cwd`）
- [x] 4.4 修改 `remember` 子命令（L66-79）：使用 `getProjectStorageDir(args.cwd)` 解析 dbPath
- [x] 4.5 移除启动时对 `join(args.cwd, ".clipilot")` 目录存在性的检查（L129-132）

## 5. clipilot init 命令

- [x] 5.1 在 `src/cli.ts` 中添加 `init` 子命令解析
- [x] 5.2 在 `src/main.ts` 中添加 `init` 子命令处理逻辑：创建 `{cwd}/.clipilot/skills/.gitkeep` 和 `{cwd}/.clipilot/prompts/.gitkeep`
- [x] 5.3 在 `printHelp()` 中添加 `init` 子命令说明
- [x] 5.4 处理幂等性：已存在的目录/文件不覆盖

## 6. 验证与清理

- [x] 6.1 运行全部测试 `npm test`，确保通过
- [x] 6.2 运行 `npm run check` 检查代码规范
- [x] 6.3 手动验证：执行 `clipilot init` 确认目录结构正确
- [x] 6.4 手动验证：执行 `clipilot remember "test"` 确认写入 `~/.clipilot/projects/{id}/` 下
