## MODIFIED Requirements

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

## ADDED Requirements

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
