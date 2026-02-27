## REMOVED Requirements

### Requirement: SignalRouter 提供 notifyPromptSent 方法

**Reason**: cooldown 机制被 preHash 替代后，`notifyPromptSent` 中与 cooldown 相关的通知职责不再需要。但该方法仍保留用于 capture expansion 检测（`/opsx` 命令检测），因此不完全移除，仅移除 cooldown 相关交互。

**Migration**: `send_to_agent` 不再调用 `stateDetector.setCooldown()`，改为在发送前捕获 preHash 并传给 `stateDetector.waitForSettled()`。`notifyPromptSent` 方法本身保留，仅用于 `/opsx` capture expansion 功能。

## MODIFIED Requirements

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
