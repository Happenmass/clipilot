## MODIFIED Requirements

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
