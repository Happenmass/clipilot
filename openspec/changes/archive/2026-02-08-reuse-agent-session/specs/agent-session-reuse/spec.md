## ADDED Requirements

### Requirement: Scheduler 在单个 agent 实例中串行执行所有 task
Scheduler SHALL 在 `start()` 中调用一次 `adapter.launch()` 获取 paneTarget，所有后续 task SHALL 复用同一个 paneTarget 发送指令，而非为每个 task 启动新实例。

#### Scenario: 多个 task 复用同一个 pane
- **WHEN** Scheduler 有 3 个 task 待执行
- **THEN** `adapter.launch()` 仅被调用 1 次，3 个 task 的 `sendPrompt()` 均使用同一个 paneTarget

#### Scenario: task 失败后 pane 不销毁
- **WHEN** 某个 task 执行失败
- **THEN** paneTarget 保持有效，后续 task 或 replan 的 task 继续使用同一个 pane

### Requirement: AgentAdapter 支持 shutdown 生命周期
AgentAdapter 接口 SHALL 新增可选方法 `shutdown(bridge, paneTarget): Promise<void>`。Scheduler SHALL 在所有 task 完成后调用 `shutdown()`（若 adapter 实现了该方法）。

#### Scenario: ClaudeCodeAdapter 优雅关闭
- **WHEN** 所有 task 执行完毕，Scheduler 调用 `adapter.shutdown()`
- **THEN** Claude Code 收到退出指令（如 `/exit`），pane 进程正常终止

#### Scenario: adapter 未实现 shutdown
- **WHEN** adapter 没有 `shutdown` 方法
- **THEN** Scheduler 跳过 shutdown 调用，不报错

### Requirement: 发送指令后的静默期
StateDetector SHALL 支持设置静默期（cooldown）。在静默期内，completionPattern 的匹配 SHALL 被忽略，避免将上一轮的 `>` 提示符误判为当前指令已完成。

#### Scenario: 指令发送后不误判完成
- **WHEN** `sendPrompt()` 发送指令后立即设置 3 秒静默期
- **AND** StateDetector 在 1 秒后 poll 到 `>` 提示符
- **THEN** 该 `>` 匹配被忽略，不触发 completed 状态

#### Scenario: 静默期过后正常检测
- **WHEN** 静默期结束后 StateDetector poll 到 `>` 提示符
- **THEN** 正常触发 completed 或 waiting_input 状态判定

### Requirement: Task 完成以回到提示符为准
在单实例模式下，Claude Code 回到 `>` 空提示符 SHALL 表示当前 task 的指令执行完毕。StateDetector 的 Layer 1.5 quickPatternCheck SHALL 将此识别为 task 完成信号。

#### Scenario: Claude Code 执行完毕回到提示符
- **WHEN** Claude Code 完成当前指令，屏幕最后一行显示 `> ` 空提示符
- **AND** 不在静默期内
- **THEN** monitorTask resolve 为 `{ success: true }`
