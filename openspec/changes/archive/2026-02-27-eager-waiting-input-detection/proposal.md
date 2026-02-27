## Why

当 Claude Code 显示权限确认提示（编号选项菜单）时，上方的 ⏺ 动画可能仍在变化，导致 tmux 内容 hash 持续更新。当前 `waitForSettled` 在 hash 变化时只对 error 做 fast-escape，`waiting_input` 信号被忽略，CLIPilot 无法及时响应交互请求。

## What Changes

- `waitForSettled` Phase 2 在内容变化时增加 `waiting_input` fast-escape，与 error fast-escape 并列
- Claude Code adapter 的 `waitingPatterns` 增加编号选项菜单模式 (`❯ 1. Yes` 等)
- `quickPatternCheck` 扫描范围从最后 5 行扩展到 8 行，确保交互提示不被底部文字推出视野

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `wait-for-settled`: Phase 2 hash 变化时增加 `waiting_input` fast-escape（原 spec 明确限制 waiting_input 仅在稳定后检测，需修改该 requirement）

## Impact

- `src/tmux/state-detector.ts` — `waitForSettled` 逻辑和 `quickPatternCheck` 扫描范围
- `src/agents/claude-code.ts` — `waitingPatterns` 数组
- `openspec/specs/wait-for-settled/spec.md` — 修改 Phase 2 error 快速逃逸 requirement
- 现有 `test/tmux/state-detector-wait-for-settled.test.ts` 需要更新
