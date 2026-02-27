## Context

CLIPilot 是一个 meta-orchestrator，通过 tmux 控制 coding agent（如 Claude Code）。当前 MainAgent 的 system prompt（`prompts/main-agent.md`）硬编码了 "Agent Capabilities" 部分，列出 `/opsx:*`、`/commit` 等命令。这导致：

1. 切换 adapter（如 Codex）时，MainAgent 仍告知 LLM 使用 Claude Code 的命令
2. 增减 skill 需要手动修改模板文件
3. 无法按项目定制可用 skill

参考设计文档：`skill-system-design.md`（基于 OpenClaw 项目的 Skill 机制）。

**CLIPilot vs OpenClaw 的关键差异**：OpenClaw 是终端 agent，skill 直接由 LLM 执行；CLIPilot 是 meta-orchestrator，skill 分两层——Layer 1 是 MainAgent 自身的 tool，Layer 2 是 MainAgent 告知被控 agent 使用的能力。大多数 skill 属于 Layer 2。

### 当前相关组件

- `AgentAdapter`（`src/agents/adapter.ts`）：接口定义 launch/sendPrompt/sendResponse/abort/getCharacteristics
- `ClaudeCodeAdapter`（`src/agents/claude-code.ts`）：纯 tmux 交互层，无能力声明
- `ContextManager`（`src/core/context-manager.ts`）：`modules: Map<string, string>` + `updateModule(key, value)` + `{{key}}` 模板替换
- `MainAgent`（`src/core/main-agent.ts`）：10 个 tool（含 3 个 memory tool），tool-use 循环
- `main-agent.md`（`prompts/main-agent.md`）：硬编码 `## Agent Capabilities` 部分

## Goals / Non-Goals

**Goals:**
- adapter 切换时 agent capabilities 自动跟随变化
- skill 增减无需修改 prompt 模板源码
- MainAgent 可按需读取 skill 详情（`read_skill` 工具）
- 支持 adapter 内建 skill 和 workspace 自定义 skill 两个来源
- 支持 main-agent-tool 类型 skill（skill 注册为 MainAgent 的 tool）
- 轻量注入：system prompt 只放摘要，详情按需加载

**Non-Goals:**
- 不实现 OpenClaw 的 7 层优先级目录（CLIPilot 简化为 2 层：adapter + workspace）
- 不实现 command-dispatch 的工具派发路径（CLIPilot 的 skill 执行通过 tmux 发送给 agent）
- 不实现环境变量注入和安装方法（由用户自行管理）
- 不实现 SkillSnapshot 缓存机制（skill 数量少，启动时全量扫描即可）
- 不实现 disable-model-invocation（CLIPilot 中所有 skill 对 MainAgent 可见）

## Decisions

### D1: Skill 存储格式——采用 SKILL.md (YAML frontmatter + Markdown)

与 OpenClaw 保持一致，每个 skill 一个目录 + `SKILL.md` 文件。YAML frontmatter 存放元数据，Markdown 正文为详细指令。

**简化后的 frontmatter schema**：

```yaml
---
name: openspec                    # skill 标识（默认为目录名）
description: "Spec-driven dev"    # 简短描述（注入 prompt 用）
type: agent-capability            # agent-capability | main-agent-tool | prompt-enrichment
commands:                         # 命令列表（注入 prompt 用）
  - /opsx:new
  - /opsx:ff
  - /opsx:apply
when:                             # 可选：资格条件
  files: [".openspec.yaml"]       # 要求文件存在
  os: ["darwin", "linux"]         # 平台限制
---
```

**为什么不直接用 JSON**：Markdown 正文支持丰富的格式化指令，YAML frontmatter 是成熟的 pattern（Hugo、Jekyll、Obsidian 均采用），且与 OpenClaw 兼容。

**为什么不用 `yaml` npm 包**：CLIPilot 的 frontmatter 结构简单，用轻量的正则 + 行解析即可，避免引入新依赖。

### D2: 两层 skill 来源——adapter-bundled + workspace

| 层级 | 路径 | 优先级 | 说明 |
|------|------|--------|------|
| adapter-bundled | `src/agents/<adapter>-skills/<name>/` | 低 | 随 adapter 代码分发 |
| workspace | `<project>/.clipilot/skills/<name>/` | 高（覆盖同名） | 项目级定制 |

**为什么只要两层**：CLIPilot 不是终端 agent，不需要用户级全局 skill。adapter 内建 skill 覆盖大部分需求，workspace 层提供项目级扩展。

**为什么 workspace 优先级高**：允许项目覆盖 adapter 内建 skill 的行为（如自定义 commit 流程）。

### D3: Skill type 三种模式

| type | 执行方式 | 示例 |
|------|----------|------|
| `agent-capability` | MainAgent 构造 prompt → 通过 tmux 发送给被控 agent | openspec、commit |
| `main-agent-tool` | skill 声明 tool schema → 注册到 MainAgent 的 TOOL_DEFINITIONS | 自定义决策工具 |
| `prompt-enrichment` | 只注入 prompt 上下文，不关联命令或 tool | 项目约定、编码规范 |

**agent-capability 是主要模式**：大多数 skill 的实际执行由被控 agent 完成，MainAgent 只负责在合适时机构造包含 skill 命令的 prompt。

**main-agent-tool 的注册方式**：SKILL.md 的 frontmatter 包含 `tool` 字段定义 tool schema，discovery 阶段提取后合并到 TOOL_DEFINITIONS。SKILL.md 正文包含 tool 执行逻辑的指令，MainAgent 调用 `read_skill` 获取后遵循执行。

### D4: Prompt 注入——摘要注入 + read_skill 按需加载

**注入格式**（替换 `{{agent_capabilities}}`）：

```markdown
The coding agent you control supports:
- Direct code editing and file operations
- Running terminal commands

### Available Skills

**openspec** — Spec-driven development workflow
  Commands: /opsx:new, /opsx:ff, /opsx:apply, /opsx:verify, /opsx:explore
  Use `read_skill("openspec")` for detailed usage.

**commit** — Structured git commits
  Commands: /commit
  Use `read_skill("commit")` for detailed usage.
```

**为什么不全量注入**：skill 的 SKILL.md 可能几百行，全量注入会占用大量 context window。摘要 + 按需加载平衡了 token 开销和信息可达性。

### D5: AgentAdapter 接口扩展

```typescript
export interface AgentAdapter {
  // ...existing methods...

  /** 返回 adapter 内建 skill 目录的绝对路径 */
  getSkillsDir?(): string;

  /** 返回 adapter 的基础能力描述（非 skill 部分） */
  getBaseCapabilities?(): string;
}
```

`getSkillsDir()` 和 `getBaseCapabilities()` 均为可选方法，保持向后兼容。不提供时使用默认值。

### D6: Frontmatter 解析——轻量实现

不引入 `gray-matter` 或 `yaml` 依赖。用正则提取 `---` 分隔的 frontmatter 块，逐行解析 `key: value`。对于 `commands` 和 `when` 等嵌套字段，用简单的缩进检测 + 行解析。

**理由**：CLIPilot 的 skill frontmatter 结构固定且简单，不需要完整 YAML 解析器。

### D7: main-agent.md 模板修改

将硬编码的 `## Agent Capabilities` 整段替换为 `{{agent_capabilities}}`。ContextManager 在启动阶段通过 `updateModule("agent_capabilities", injectedContent)` 注入动态内容。

## Risks / Trade-offs

**[轻量 YAML 解析限制]** → 不支持多行字符串、锚点引用等高级 YAML 特性。若 skill 定义变复杂，可能需要引入 `yaml` 包。Mitigation：当前 schema 设计为扁平结构，避免嵌套复杂度。

**[read_skill 增加 LLM 调用]** → 每次 MainAgent 需要 skill 详情都要额外一轮 tool-use。Mitigation：MainAgent 可以在首次读取后在对话上下文中缓存内容；大部分任务只需 1-2 次 read_skill 调用。

**[main-agent-tool 类型的安全风险]** → workspace skill 可以注册为 MainAgent 的 tool，理论上可执行任意操作。Mitigation：tool schema 只支持声明式定义，实际执行仍通过 MainAgent 的 LLM 决策；可通过配置禁用特定 skill。

**[adapter 切换时 skill 不匹配]** → 不同 adapter 的 skill 集完全不同，切换时需要重新初始化。Mitigation：adapter 在启动时通过 `getSkillsDir()` 返回正确目录，discovery 自动适配。

## Open Questions

- **Q1**: main-agent-tool 类型 skill 的 tool 执行是 MainAgent 自己执行（如调用 API），还是仍通过 prompt 指导 LLM 决策？初步方向：后者，保持 MainAgent 的纯决策角色。
- **Q2**: 是否需要 skill 版本管理？初步方向：不需要，skill 随代码版本控制。
