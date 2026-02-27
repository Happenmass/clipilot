## ADDED Requirements

### Requirement: MainAgent 通过 tool use 循环处理信号

MainAgent SHALL 维护一个持续的 `conversation: LLMMessage[]`。当接收到信号（`[TASK_READY]`、`[DECISION_NEEDED]`、`[NOTIFY]`、`[USER_STEER]`）时，SHALL 将信号格式化为 user message 追加到 conversation，然后调用 `llmClient.complete()` 并传入 tool definitions。如果响应包含 tool calls，SHALL 执行对应 tool 并将结果作为 tool message 追加到 conversation，然后继续调用 LLM，直到响应不包含 tool calls 或遇到终止性 tool。

#### Scenario: 处理 DECISION_NEEDED 信号

- **WHEN** SignalRouter 发送 `[DECISION_NEEDED]` 信号（含 pane 内容和状态分析）
- **THEN** MainAgent 将信号追加到 conversation，调用 LLM 推理，执行返回的 tool call（如 `respond_to_agent`）

#### Scenario: 多步推理

- **WHEN** MainAgent 调用 `fetch_more` tool 获取更多 tmux 内容
- **THEN** tool 结果被追加到 conversation，LLM 继续推理并可能调用后续 tool（如 `send_to_agent`）

#### Scenario: NOTIFY 信号不触发 LLM 调用

- **WHEN** SignalRouter 发送 `[NOTIFY]` 信号（快速通道结果通知）
- **THEN** MainAgent 仅将信号追加到 conversation 历史，不触发 LLM 调用

### Requirement: MainAgent 在 TASK_READY 时生成 prompt

当收到 `[TASK_READY]` 信号时，MainAgent SHALL 通过 LLM 推理生成发送给执行 agent 的 prompt，并调用 `send_to_agent` tool 发送。MainAgent SHALL 根据任务复杂度和性质决定是否在 prompt 中包含 `/opsx` 命令。

#### Scenario: 普通任务生成直接 prompt

- **WHEN** MainAgent 收到 `[TASK_READY]` 信号，任务为低复杂度
- **THEN** MainAgent 生成描述性 prompt 并通过 `send_to_agent` 发送给执行 agent

#### Scenario: 复杂任务引导使用 spec-driven 工作流

- **WHEN** MainAgent 收到 `[TASK_READY]` 信号，任务为高复杂度
- **THEN** MainAgent MAY 在 prompt 中包含 `/opsx:ff` 或 `/opsx:new` 命令引导执行 agent 使用 spec-driven 工作流

### Requirement: MainAgent 定义 7 个 tools

MainAgent SHALL 定义以下 tool 供 LLM 调用：

| Tool | 终止性 |
|------|--------|
| `send_to_agent(prompt: string)` | 否 |
| `respond_to_agent(value: string)` | 否 |
| `fetch_more(lines: number)` | 否 |
| `mark_complete(summary: string)` | 是 |
| `mark_failed(reason: string)` | 是 |
| `request_replan(reason: string)` | 是 |
| `escalate_to_human(reason: string)` | 是 |

终止性 tool 执行后 SHALL 退出当前信号的 tool use 循环并返回结果。非终止性 tool 执行后 SHALL 将结果追加到 conversation 并继续 LLM 循环。

#### Scenario: 终止性 tool 结束循环

- **WHEN** LLM 调用 `mark_complete("所有API路由已实现")`
- **THEN** MainAgent 执行 tool，退出 tool use 循环，返回 `{ success: true, summary: "所有API路由已实现" }`

#### Scenario: 非终止性 tool 继续循环

- **WHEN** LLM 调用 `fetch_more(300)`
- **THEN** MainAgent 执行 tool，将返回的 pane 内容作为 tool result 追加到 conversation，继续调用 LLM

### Requirement: send_to_agent 执行后设置 cooldown

调用 `send_to_agent` 前，MainAgent SHALL 捕获当前 tmux pane 内容的 hash 作为 `preHash`。发送 prompt 后，SHALL 调用 `stateDetector.waitForSettled(paneTarget, goal, { preHash })` 阻塞等待 agent 完成工作。工具返回值 SHALL 包含 agent 最终状态和 pane 内容，格式为 `[Agent <status>] (<detail>)\n<pane content>`。

#### Scenario: 发送 prompt 后阻塞等待 agent 完成

- **WHEN** MainAgent 通过 `send_to_agent` 发送 prompt
- **THEN** 工具阻塞等待 StateDetector 判定 agent 完成，返回最终 pane 内容和状态分析

#### Scenario: 发送 prompt 后 agent 超时

- **WHEN** MainAgent 通过 `send_to_agent` 发送 prompt，agent 执行超过 30 分钟
- **THEN** 工具返回当前 pane 内容，状态标记为 timeout

### Requirement: respond_to_agent 执行后阻塞等待

调用 `respond_to_agent` 前，MainAgent SHALL 捕获当前 tmux pane 内容的 hash 作为 `preHash`。发送响应后，SHALL 调用 `stateDetector.waitForSettled(paneTarget, goal, { preHash })` 阻塞等待 agent 完成工作。工具返回值 SHALL 包含 agent 最终状态和 pane 内容。

#### Scenario: 响应 agent 问题后等待完成

- **WHEN** MainAgent 通过 `respond_to_agent` 发送 "y" 响应
- **THEN** 工具阻塞等待 StateDetector 判定 agent 完成，返回最终 pane 内容和状态分析

### Requirement: fetch_more 调用 bridge.capturePane

`fetch_more(lines)` tool SHALL 调用 `bridge.capturePane(paneTarget, { startLine: -lines })` 并返回抓取的内容。工具描述 SHALL 明确限制使用场景：仅在 agent 已完成工作（即 `send_to_agent` 或 `respond_to_agent` 已返回）后，当返回内容明显截断或缺失上下文时使用。SHALL NOT 用于轮询 agent 执行进度。

#### Scenario: agent 完成后抓取更多历史输出

- **WHEN** `send_to_agent` 已返回，LLM 判断内容截断，调用 `fetch_more(300)`
- **THEN** 返回 tmux pane 最近 300 行的内容

#### Scenario: fetch_more 描述引导 LLM 正确使用

- **WHEN** LLM 查看 `fetch_more` 的 tool description
- **THEN** 描述明确说明"仅在 agent 完成工作后、输出截断时使用，不要用于轮询进度"

### Requirement: request_replan 委托给 Planner

`request_replan(reason)` tool SHALL 调用 `planner.replan(goal, taskGraph, currentTask, reason)` 并用返回的新 TaskGraph 替换当前 TaskGraph。

#### Scenario: 重规划后 TaskGraph 更新

- **WHEN** MainAgent 调用 `request_replan("依赖库不兼容，需要换用替代方案")`
- **THEN** Planner 生成新的 TaskGraph，Scheduler 使用新 TaskGraph 继续循环

### Requirement: MainAgent 提供 executeTask 方法

MainAgent SHALL 提供 `executeTask(task: Task): Promise<TaskResult>` 方法，由 Scheduler 调用。该方法 SHALL：
1. 注入 `[TASK_READY]` 信号
2. 触发 LLM 推理生成并发送 prompt
3. 启动 SignalRouter 监控
4. 循环处理信号直到收到终止性 tool 调用或超时
5. 返回 TaskResult

#### Scenario: 完整的任务执行生命周期

- **WHEN** Scheduler 调用 `mainAgent.executeTask(task)`
- **THEN** MainAgent 生成 prompt、发送给 agent、监控执行、处理交互、最终返回 TaskResult
