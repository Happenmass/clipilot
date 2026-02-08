## Why

当前每个 task 都会启动一个全新的 Claude Code 实例（新 tmux session + 新 window），导致：
1. 前一个 task 的对话上下文完全丢失，后续 task 无法利用已有信息
2. 每次启动都要等待 Claude Code 初始化（~30s），多个 task 累积大量等待时间
3. 每个 task 创建独立 session，tmux 资源浪费

应改为 **单实例复用** — 在同一个 Claude Code 会话中串行发送所有 task 的指令。

## What Changes

- **Scheduler 生命周期重构**：将 `adapter.launch()` 从 `executeTask()` 提升到 `start()` 级别，所有 task 复用同一个 pane
- **Agent adapter 接口调整**：`launch()` 只调用一次，新增 `shutdown()` 方法；`sendPrompt()` 复用已有 pane
- **StateDetector 增加发送后静默期**：发送指令后短暂忽略完成模式匹配，避免在新指令未被处理前误判为"已完成"
- **Task 完成判定**：Claude Code 回到 `>` 提示符即表示当前 task 指令执行完毕，可发送下一个 task

## Capabilities

### New Capabilities
- `agent-session-reuse`: 单个 agent 实例在多个 task 间复用的会话管理机制

### Modified Capabilities

## Impact

- `src/core/scheduler.ts` — 主要改动：runLoop/executeTask 结构重构
- `src/agents/claude-code.ts` — 小改：加 shutdown()
- `src/agents/adapter.ts` — 接口调整
- `src/tmux/state-detector.ts` — 加发送后静默期逻辑
- `src/main.ts` — session 管理可能需调整
