## Context

当前 `Scheduler.executeTask()` 每次为每个 task 调用 `adapter.launch()`，创建新 tmux session + window + Claude Code 实例。task 间无上下文延续，且每次启动有约 30s 初始化开销。

相关文件：
- `src/core/scheduler.ts` — `executeTask()` 调用 `adapter.launch()`，`monitorTask()` 监控 pane
- `src/agents/claude-code.ts` — `launch()` 创建 session/window，`sendPrompt()` 发文本 + Enter
- `src/agents/adapter.ts` — `AgentAdapter` 接口定义
- `src/tmux/state-detector.ts` — 轮询 pane 内容，`quickPatternCheck` 检测完成/等待/错误

## Goals / Non-Goals

**Goals:**
- 所有 task 复用同一个 Claude Code 实例（同一个 tmux pane）
- Claude Code 保持对话上下文，后续 task 能利用前序 task 的信息
- 仅启动一次 Claude Code，减少初始化等待

**Non-Goals:**
- 不支持多个 agent 并行执行（当前 `maxParallel: 1`，保持不变）
- 不改变 task 规划逻辑（Planner 不受影响）
- 不改变 StateDetector 的三层分析架构（Layer 1/1.5/2），仅调整时序

## Decisions

### Decision 1: launch 提升到 Scheduler.start() 级别

**选择**: 在 `start()` 中调用一次 `adapter.launch()` 获取 `paneTarget`，存为实例变量，`executeTask()` 复用。

**替代方案**: 在 `main.ts` 中 launch，通过构造函数传入 paneTarget。
**选择原因**: 保持 Scheduler 对 agent 生命周期的完整控制，main.ts 不需要关心 pane 管理细节。

### Decision 2: AgentAdapter 接口新增 shutdown()

**选择**: 在 `AgentAdapter` 接口中新增可选方法 `shutdown?(bridge, paneTarget): Promise<void>`，用于在所有 task 完成后优雅关闭 agent（发送 `/exit` 或 Ctrl+C）。

**替代方案**: 直接 kill tmux session，不通知 agent。
**选择原因**: 优雅关闭让 Claude Code 有机会保存对话历史。且 shutdown 为可选，其他 adapter 可以不实现。

### Decision 3: 发送后静默期避免误判

**选择**: `sendPrompt()` 后设置一个 `cooldownUntil` 时间戳（当前时间 + 3s），在 `StateDetector.poll()` 中，若在静默期内且 pane 匹配到 completionPattern，则忽略此次匹配。

**替代方案 A**: sendPrompt 后等待 pane 内容发生至少一次变化再开始检测。
**替代方案 B**: sendPrompt 后 sleep 固定时间再 startMonitoring。
**选择原因**: 时间戳方案简单可靠。方案 A 需要额外状态管理且有竞争条件；方案 B 的固定 sleep 可能过长或过短。3s 是保守值，覆盖 Claude Code 的思考启动延迟。

### Decision 4: executeTask 不再创建/销毁 session

**选择**: `executeTask()` 仅负责 `sendPrompt()` + `monitorTask()`。pane 生命周期完全由 `start()` 管理。task 失败时不销毁 pane，继续用同一个 pane 处理下一个 task 或 replan。

## Risks / Trade-offs

- **[Risk] Claude Code 上下文窗口溢出** → 对于大量 task 的项目，Claude Code 自身的上下文压缩机制会处理。短期不需要额外干预。
- **[Risk] 某个 task 导致 Claude Code 进入异常状态（卡住/崩溃）** → 保留 `abort()` 能力 + 10 分钟超时。若 agent 崩溃（进程退出），StateDetector 的 capturePane 会抛错，可在 catch 中 re-launch。
- **[Trade-off] 失去 task 间的隔离性** → 前一个 task 的错误或残留状态可能影响后续 task。可接受，因为上下文连续性的收益大于隔离性的损失。
