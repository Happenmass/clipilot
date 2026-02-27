## ADDED Requirements

### Requirement: StateDetector 提供 waitForSettled 方法

StateDetector SHALL 提供 `waitForSettled(paneTarget: string, taskContext: string, opts: WaitForSettledOptions): Promise<SettledResult>` 方法。该方法 SHALL 阻塞直到 tmux pane 内容从 `opts.preHash` 发生变化并最终稳定，或超时。

接口定义：
- `WaitForSettledOptions`: `{ preHash: string; timeoutMs?: number }` — `timeoutMs` 默认 1800000 (30 分钟)
- `SettledResult`: `{ analysis: PaneAnalysis; content: string; timedOut: boolean }`

#### Scenario: agent 正常执行并完成

- **WHEN** 调用 `waitForSettled(pane, task, { preHash: "abc" })`，且 tmux 内容在 2 秒后变化，再在 15 秒后稳定
- **THEN** 方法在内容稳定 stableThresholdMs 后返回 `{ analysis: { status: "completed", ... }, content: "...", timedOut: false }`

#### Scenario: 超时保护

- **WHEN** 调用 `waitForSettled(pane, task, { preHash: "abc", timeoutMs: 5000 })`，且 tmux 内容持续变化超过 5 秒
- **THEN** 方法返回 `{ analysis: { status: "active", ... }, content: "当前内容", timedOut: true }`

### Requirement: waitForSettled Phase 1 等待 hash 变化

`waitForSettled` SHALL 在初始阶段（Phase 1）每 `pollIntervalMs` 轮询 tmux pane 内容并计算 hash。当 hash 与 `preHash` 不同时，SHALL 记录 `lastChangeTime` 并进入 Phase 2。Phase 1 期间 SHALL 不进行模式匹配或 LLM 分析。

#### Scenario: agent 立即开始产出

- **WHEN** preHash 为 "abc"，第一次轮询时 hash 变为 "def"
- **THEN** 立即进入 Phase 2，`lastChangeTime` 设为当前时间

#### Scenario: agent 延迟启动

- **WHEN** preHash 为 "abc"，前 3 次轮询 hash 均为 "abc"，第 4 次变为 "def"
- **THEN** 在第 4 次轮询时进入 Phase 2

### Requirement: waitForSettled Phase 2 等待内容稳定

进入 Phase 2 后，`waitForSettled` SHALL 继续每 `pollIntervalMs` 轮询。当 hash 变化时 SHALL 更新 `lastChangeTime`。当 hash 未变且 `now - lastChangeTime >= stableThresholdMs` 时，SHALL 执行状态判定（quickPatternCheck 或 Layer 2 LLM 分析）并返回结果。

#### Scenario: 内容持续变化后稳定

- **WHEN** Phase 2 中 hash 连续变化 5 次后稳定
- **THEN** 在最后一次变化后等待 stableThresholdMs，然后执行状态判定并返回

#### Scenario: 稳定后判定为 active（高置信度）继续等待

- **WHEN** 内容稳定 stableThresholdMs 后，quickPatternCheck 返回 `{ status: "active", confidence: 0.8 }`
- **THEN** 重置 `lastChangeTime`，继续 Phase 2 等待

### Requirement: Phase 2 error 快速逃逸

在 Phase 2 中，每次 hash 变化时 SHALL 执行 `quickPatternCheck`。如果检测到 error pattern，SHALL 立即返回结果，不等待稳定阈值。如果检测到 `waiting_input` pattern，SHALL 同样立即返回结果，不等待稳定阈值。

#### Scenario: 内容变化中检测到 error

- **WHEN** Phase 2 中最新一次轮询 hash 变化，且 quickPatternCheck 匹配到 error pattern
- **THEN** 立即返回 `{ analysis: { status: "error", ... }, content: "...", timedOut: false }`

#### Scenario: 内容变化中检测到 waiting_input

- **WHEN** Phase 2 中最新一次轮询 hash 变化，且 quickPatternCheck 匹配到 waiting_input pattern（如编号选项菜单 `❯ 1.`）
- **THEN** 立即返回 `{ analysis: { status: "waiting_input", ... }, content: "...", timedOut: false }`

#### Scenario: 动画与交互提示同时出现

- **WHEN** Phase 2 中 tmux 内容持续因 ⏺ 动画变化（hash 每次不同），同时下方出现 `❯ 1. Yes` 编号选项菜单
- **THEN** `quickPatternCheck` 匹配到 waiting_input，立即返回，不等待内容稳定

### Requirement: quickPatternCheck 扫描最后 8 行

`quickPatternCheck` SHALL 从捕获内容的最后 8 行中进行模式匹配（原为 5 行）。这确保 Claude Code 的编号选项菜单（通常包含提示行 + 2-3 个选项 + 底部操作提示）不会被推出扫描范围。

#### Scenario: 权限提示在底部 6-7 行范围内

- **WHEN** tmux 捕获内容最后 7 行包含 "Do you want to proceed?" 和 `❯ 1. Yes` 等选项
- **THEN** `quickPatternCheck` SHALL 匹配到 waiting_input pattern

### Requirement: Claude Code adapter 支持编号选项菜单 waiting pattern

Claude Code adapter 的 `waitingPatterns` SHALL 包含 `/❯\s*\d+\.\s/` 模式，用于匹配 Claude Code 的编号选项交互菜单（如 `❯ 1. Yes`、`❯ 2. No`）。

#### Scenario: 检测到编号选项菜单

- **WHEN** tmux 捕获内容包含 `❯ 1. Yes`
- **THEN** `quickPatternCheck` 使用该 pattern 匹配并返回 `{ status: "waiting_input", confidence: 0.6 }`

#### Scenario: 普通文本中包含数字编号但无 ❯

- **WHEN** tmux 捕获内容包含 `1. Install dependencies` 但不包含 `❯`
- **THEN** 该 pattern 不匹配，不误判为 waiting_input

### Requirement: waitForSettled 支持 abort 退出

`waitForSettled` SHALL 在每次轮询循环中检查外部 abort 条件。当检测到 abort 时，SHALL 立即返回当前内容和状态。

#### Scenario: 用户在等待期间发出 abort

- **WHEN** `waitForSettled` 正在 Phase 2 等待中，外部调用了 abort
- **THEN** 方法立即返回 `{ analysis: { status: "unknown", ... }, content: "当前内容", timedOut: false }`
