## Context

当前 CLIPilot 将内存数据分散存储在项目目录中：
- `{project}/.clipilot/memory.sqlite` — 搜索索引数据库
- `{project}/memory/*.md` — Markdown 内存文件（source of truth）
- `{project}/MEMORY.md` — 遗留格式

这导致项目目录被 CLIPilot 的内部状态文件污染。项目级的 skills 和 prompts 覆盖（`{project}/.clipilot/skills/`, `{project}/.clipilot/prompts/`）是有意义的项目级配置，应保留。

核心矛盾：`MemoryStore` 的 `workspaceDir` 同时承担了"项目位置"和"内存存储根目录"两个职责，需要拆分。

## Goals / Non-Goals

**Goals:**
- 所有内存数据（SQLite + Markdown）集中存储在 `~/.clipilot/projects/{project-id}/` 下
- 项目目录保持干净，不再自动创建 `.clipilot/` 或 `memory/` 目录
- 新增 `clipilot init` 命令，显式创建项目级 skills/prompts 覆盖目录
- 项目标识使用"可读前缀 + 路径哈希后缀"策略，确保稳定和唯一

**Non-Goals:**
- 自动迁移现有项目的内存数据（用户可手动迁移）
- 修改 openspec 相关逻辑（openspec 完全独立，CLIPilot 不管理）
- 修改 skills/prompts 发现和加载逻辑（路径不变）
- 跨机器同步内存数据

## Decisions

### Decision 1: project-id 生成策略 — 可读前缀 + 路径哈希后缀

**选择**: `{basename}-{sha256(absolutePath).slice(0,6)}`

示例：`/Users/guhappen/code/clipilot` → `clipilot-a3f2b1`

**替代方案**:
- 纯哈希（`a3f2b1c4`）：唯一但不可读，排除
- 仅目录名（`clipilot`）：不同路径下同名目录会冲突，排除
- 全路径编码（`Users-guhappen-code-clipilot`）：太长，排除

**理由**: 人类可快速识别项目，6 位哈希碰撞概率极低（1600万分之一）。

### Decision 2: 拆分 workspaceDir 为 projectDir + storageDir

**选择**: `MemoryStoreConfig` 新增 `storageDir` 字段，替代 `workspaceDir` 在内存文件读写中的角色。

```
projectDir  = args.cwd                                      ← 项目位置（skills/prompts 发现用）
storageDir  = ~/.clipilot/projects/{project-id}/             ← 内存存储根
dbPath      = {storageDir}/memory.sqlite                    ← SQLite 位置
memoryDir   = {storageDir}/memory/                          ← Markdown 位置
```

`MemoryStore` 内部原本用 `workspaceDir` 做两件事：
1. 拼接内存文件的绝对路径 → 改用 `storageDir`
2. 被 `sync.ts` 的 `listMemoryFiles` 调用 → 改用 `storageDir`

`workspaceDir` 保留但仅用于 `buildFileEntry` 计算相对路径。

### Decision 3: clipilot init 命令设计

**选择**: 新增 `clipilot init` 子命令，在当前目录创建 `.clipilot/skills/` 和 `.clipilot/prompts/` 目录。

行为：
- 如果 `.clipilot/` 已存在，跳过已有目录，不覆盖
- 创建 `.clipilot/skills/.gitkeep` 和 `.clipilot/prompts/.gitkeep` 占位文件
- 输出创建结果

不在 init 中创建内存相关内容（内存目录在运行时自动创建在 `~/.clipilot/projects/` 下）。

### Decision 4: main.ts 启动流程调整

**选择**: 移除 `clipilotDir = join(args.cwd, ".clipilot")` 模式，改为：

```
const storageDir = getProjectStorageDir(args.cwd);
const dbPath = join(storageDir, "memory.sqlite");
```

`getProjectStorageDir` 函数在 `config.ts` 中实现，负责：
1. 根据 `args.cwd` 生成 project-id
2. 返回 `~/.clipilot/projects/{project-id}/` 路径
3. 确保目录存在（`mkdir -p`）

### Decision 5: remember 子命令路径修正

当前 `remember` 直接用 `join(args.cwd, ".clipilot", "memory.sqlite")`。改为与主流程一致使用 `getProjectStorageDir(args.cwd)`。

## Risks / Trade-offs

**[Breaking change] 现有内存数据不自动迁移** → 文档说明手动迁移步骤：将 `{project}/memory/` 复制到 `~/.clipilot/projects/{id}/memory/`，删除旧 SQLite（会自动重建）。

**[项目移动后内存断联] 路径变更导致 project-id 变化** → 这是已知限制。用户可手动 rename 目录或将旧 project-id 目录下的内存复制到新目录。暂不提供 rebind 机制。

**[磁盘占用不可见] 内存数据不在项目目录，用户可能忘记清理** → 可后续添加 `clipilot projects` 列表命令和 `clipilot gc` 清理命令，但不在本次范围内。

## Open Questions

- 无（探索阶段已充分讨论）
