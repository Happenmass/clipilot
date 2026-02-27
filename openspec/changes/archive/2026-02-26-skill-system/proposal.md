## Why

MainAgent 的 system prompt 中 "Agent Capabilities" 部分硬编码了 Claude Code 的 `/opsx:*` 等命令。当切换 adapter（如 Codex）或增减 skill（如 `/superpower`）时，必须手动修改 `main-agent.md` 模板。Skill 系统将能力描述与 adapter 绑定，实现动态发现、过滤和注入，使 MainAgent 能适配不同 agent 并按需获取 skill 详情。

## What Changes

- 新增 Skill 存储层：每个 skill 一个目录 + `SKILL.md`（YAML frontmatter + Markdown 正文），存放于 adapter 目录旁（如 `agents/claude-code-skills/openspec/`）
- 新增 Skill 发现层：扫描 adapter skill 目录和可选的 workspace 目录（`.clipilot/skills/`），解析 frontmatter 为 `SkillEntry` 元数据
- 新增 Skill 过滤层：基于 `when` 条件（OS、文件存在性、环境变量）过滤不符合资格的 skill
- 新增 Prompt 注入层：生成轻量摘要（name + description + 命令列表）注入 `{{agent_capabilities}}` 模块，替代硬编码内容
- 新增 `read_skill` 工具：MainAgent 按需读取完整 SKILL.md 内容
- 支持 `main-agent-tool` 类型 skill：skill 可声明自己注册为 MainAgent 的 tool（如自定义决策工具）
- 扩展 `AgentAdapter` 接口：新增 `getSkillsDir()` 和 `getBaseCapabilities()` 方法
- 修改 `main-agent.md`：`## Agent Capabilities` 改为 `{{agent_capabilities}}` 动态占位符

## Capabilities

### New Capabilities
- `skill-storage`: Skill 存储格式定义（SKILL.md 结构、YAML frontmatter schema、目录布局）
- `skill-discovery`: Skill 发现与加载（多源目录扫描、frontmatter 解析、去重优先级）
- `skill-filtering`: Skill 过滤与资格评估（when 条件、配置禁用）
- `skill-injection`: Skill 提示词注入（摘要生成、ContextManager 模块更新、预算管控）
- `skill-execution`: Skill 执行机制（read_skill 工具、main-agent-tool 注册、命令识别）

### Modified Capabilities
（无需修改现有 spec 级别的行为要求）

## Impact

- **核心代码**：`src/agents/adapter.ts`（接口扩展）、`src/agents/claude-code.ts`（实现新方法）、`src/core/main-agent.ts`（新增 read_skill 工具 + tool 注册）、`src/core/context-manager.ts`（新模块 key）
- **新增模块**：`src/skills/`（storage、discovery、filter、injector）
- **Prompt 模板**：`prompts/main-agent.md`（Agent Capabilities 改为动态注入）
- **Skill 文件**：`src/agents/claude-code-skills/`（openspec、commit 等内建 skill 的 SKILL.md）
- **配置**：`config.ts` 可选新增 skill 相关配置（禁用列表等）
- **依赖**：无新外部依赖（YAML frontmatter 解析用轻量实现或 gray-matter）
