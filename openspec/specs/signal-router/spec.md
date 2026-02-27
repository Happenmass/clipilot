## ADDED Requirements

### Requirement: SignalRouter 根据状态和置信度分流信号

SignalRouter SHALL 接收 StateDetector 的输出（PaneAnalysis + paneContent），根据以下规则分流：

| 状态 | 置信度条件 | 通道 | 信号类型 |
|------|-----------|------|---------|
| `active` | conf > 0.7 | 快速通道 | `[NOTIFY]` |
| `completed` | conf ≥ 0.9 | 快速通道 | `[NOTIFY]` |
| `completed` | conf < 0.9 | MainAgent | `[DECISION_NEEDED]` |
| `waiting_input` | 任何 | MainAgent | `[DECISION_NEEDED]` |
| `error` | 任何 | MainAgent | `[DECISION_NEEDED]` |
| `idle` | 任何 | MainAgent | `[DECISION_NEEDED]` |
| `unknown` | 任何 | MainAgent | `[DECISION_NEEDED]` |

SignalRouter 的 `startMonitoring`/`stopMonitoring` 路径 SHALL 不再依赖 StateDetector 的 cooldown 机制。StateDetector 的 `quickPatternCheck` SHALL 不再包含 cooldown 分支逻辑。

#### Scenario: active 信号走快速通道

- **WHEN** StateDetector 报告 `{ status: "active", confidence: 0.8 }`
- **THEN** SignalRouter 不触发 MainAgent LLM 调用，仅向 MainAgent 对话追加 `[NOTIFY]` 消息

#### Scenario: waiting_input 始终路由到 MainAgent

- **WHEN** StateDetector 报告 `{ status: "waiting_input", confidence: 0.6 }`
- **THEN** SignalRouter 发送 `[DECISION_NEEDED]` 信号给 MainAgent

#### Scenario: 无 cooldown 干扰的 pattern 检测

- **WHEN** `send_to_agent` 已返回后，StateDetector 通过 `startMonitoring` 继续监听
- **THEN** `quickPatternCheck` 对所有 pattern（包括 completion 和 waiting_input）始终执行，不存在 cooldown 跳过逻辑

### Requirement: 快速通道的结果写入 MainAgent 对话历史

快速通道处理完毕后，SignalRouter SHALL 将结果作为 `[NOTIFY]` 消息追加到 MainAgent 的对话历史中（通过 ContextManager），确保 MainAgent 不丢失上下文。

#### Scenario: 自动完成后通知 MainAgent

- **WHEN** 快速通道自动标记任务 #3 完成
- **THEN** MainAgent 对话历史中追加 `[NOTIFY] Task #3 '实现API路由' 已自动标记完成 (conf=0.92)`

#### Scenario: MainAgent 下次激活时可见快速通道历史

- **WHEN** MainAgent 在任务 #4 被激活进行推理
- **THEN** 其 conversation 中包含之前快速通道追加的所有 `[NOTIFY]` 消息

### Requirement: SignalRouter 自适应 tmux 抓取行数

SignalRouter SHALL 维护 `captureContext` 状态，包含 `defaultLines`（默认 50）和 `expandedLines`（默认 300）。当满足以下任一条件时，SHALL 使用 `expandedLines` 抓取：

1. 最近通过 MainAgent 发送的 prompt 包含 `/opsx` 相关命令
2. 当前 pane 内容匹配 spec 相关关键词（openspec、proposal.md、design.md、tasks.md、artifact 等）
3. 当前 pane 内容出现明显截断特征

#### Scenario: 检测到 /opsx 命令后扩大抓取

- **WHEN** MainAgent 最近发送了包含 `/opsx:ff` 的 prompt
- **THEN** SignalRouter 后续 poll 使用 300 行抓取，直到新任务开始

#### Scenario: 检测到 spec 关键词后扩大抓取

- **WHEN** pane 内容中出现 "openspec" 或 "proposal.md" 等关键词
- **THEN** SignalRouter 当次 poll 使用 300 行抓取

#### Scenario: 回退到默认抓取行数

- **WHEN** 新任务开始执行且之前的扩大抓取条件不再满足
- **THEN** SignalRouter 恢复使用 50 行默认抓取

### Requirement: SignalRouter 提供 notifyPromptSent 方法

当 MainAgent 通过 `send_to_agent` 发送 prompt 后，SHALL 调用 `signalRouter.notifyPromptSent(prompt)` 通知 SignalRouter。SignalRouter SHALL 检查 prompt 内容以决定是否启用扩展抓取。

#### Scenario: 通知包含 /opsx 的 prompt

- **WHEN** `notifyPromptSent("/opsx:ff 实现认证中间件")` 被调用
- **THEN** SignalRouter 将 `expandUntilNextTask` 设为 true，后续使用 expandedLines 抓取
