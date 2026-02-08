## 1. AgentAdapter 接口调整

- [x] 1.1 在 `src/agents/adapter.ts` 的 `AgentAdapter` 接口中新增可选方法 `shutdown?(bridge: TmuxBridge, paneTarget: string): Promise<void>`
- [x] 1.2 在 `src/agents/claude-code.ts` 中实现 `shutdown()` 方法，发送 `/exit` 指令退出 Claude Code

## 2. StateDetector 静默期支持

- [x] 2.1 在 `src/tmux/state-detector.ts` 中新增 `setCooldown(durationMs: number)` 方法，设置 `cooldownUntil` 时间戳
- [x] 2.2 修改 `quickPatternCheck()`：若在静默期内且匹配到 completionPattern 或 waitingPattern（空提示符），则返回 null 忽略该匹配
- [x] 2.3 修改 Layer 2 触发条件：静默期内 content stable 不触发 Layer 2 分析

## 3. Scheduler 生命周期重构

- [x] 3.1 在 `Scheduler` 中新增 `agentPaneTarget: string | null` 实例变量
- [x] 3.2 修改 `start()`：在 runLoop 前调用 `adapter.launch()` 获取 paneTarget 并存储；runLoop 结束后调用 `adapter.shutdown()`
- [x] 3.3 修改 `executeTask()`：移除 `adapter.launch()` 调用，改用 `this.agentPaneTarget`
- [x] 3.4 修改 `executeTask()`：sendPrompt 后调用 `stateDetector.setCooldown(3000)` 设置 3 秒静默期
- [x] 3.5 修改 `executeTask()`：task 失败时不销毁 pane，保持 paneTarget 有效

## 4. 测试与验证

- [x] 4.1 更新或新增 scheduler 相关测试，验证 launch 仅调用一次
- [x] 4.2 新增 StateDetector 静默期测试，验证 cooldown 期间 completionPattern 被忽略
- [x] 4.3 运行 `npx vitest run` 确保所有测试通过
- [x] 4.4 运行 `npx biome check src/` 确保代码规范
- [x] 4.5 运行 `npm run build` 确保编译通过
