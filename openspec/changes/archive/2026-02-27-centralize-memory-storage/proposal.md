## Why

CLIPilot 当前将内存文件（`memory/` Markdown 文件和 `memory.sqlite` 数据库）存储在项目根目录下，污染了用户的项目工作区。内存是 CLIPilot 工具的内部状态，不应与项目源码混在一起。所有内存数据应集中存储在 `~/.clipilot/projects/` 下，按项目隔离管理。

## What Changes

- **BREAKING**: 内存 Markdown 文件从 `{project}/memory/` 迁移到 `~/.clipilot/projects/{project-id}/memory/`
- **BREAKING**: SQLite 数据库从 `{project}/.clipilot/memory.sqlite` 迁移到 `~/.clipilot/projects/{project-id}/memory.sqlite`
- 新增 `getProjectStorageDir(projectDir)` 函数，使用"可读前缀 + 路径哈希后缀"策略生成项目存储目录（如 `clipilot-a3f2b1/`）
- 新增 `clipilot init` 命令，用于在项目目录创建 `.clipilot/skills/` 和 `.clipilot/prompts/` 结构
- `{project}/.clipilot/` 目录不再自动创建，仅在用户运行 `clipilot init` 后存在，且只包含 skills 和 prompts 覆盖
- `clipilot remember` 子命令更新为使用集中存储路径
- 项目目录下不再自动生成任何 CLIPilot 相关文件

## Capabilities

### New Capabilities
- `project-storage`: 项目级存储目录管理，包括 project-id 生成策略和目录结构
- `cli-init`: `clipilot init` 命令，初始化项目级 skills 和 prompts 覆盖目录

### Modified Capabilities
- `memory-store`: 存储路径从项目本地改为 `~/.clipilot/projects/{id}/`，`workspaceDir` 概念拆分为 `projectDir`（项目位置）和 `storageDir`（内存存储位置）

## Impact

- **代码改动**: `src/utils/config.ts`, `src/main.ts`, `src/memory/store.ts`, `src/memory/sync.ts`, `src/cli.ts`
- **测试更新**: `test/memory/store.test.ts`, `test/memory/sync.test.ts`（路径相关断言）
- **Breaking**: 现有项目的 `{project}/memory/` 和 `{project}/.clipilot/memory.sqlite` 不会自动迁移，首次运行后等于全新开始（SQLite 可从 Markdown 重建，但 Markdown 文件需用户手动迁移）
- **无影响**: openspec 目录（CLIPilot 不管理）、全局配置（`~/.clipilot/config.json` 等不变）、skills 发现逻辑（项目级 skills 仍从 `{project}/.clipilot/skills/` 读取）
