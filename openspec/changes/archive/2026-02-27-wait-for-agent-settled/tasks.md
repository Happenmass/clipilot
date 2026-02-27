## 1. StateDetector: 移除 cooldown，新增 waitForSettled

- [x] 1.1 移除 `StateDetector` 中的 cooldown 相关代码：`setCooldown()`、`cooldownUntil` 属性、`isInCooldown()` 方法
- [x] 1.2 移除 `quickPatternCheck` 中的 cooldown 分支（line 167-169 的 `if (inCooldown) return null`），使所有 pattern 始终生效
- [x] 1.3 新增 `WaitForSettledOptions` 和 `SettledResult` 类型定义
- [x] 1.4 实现 `waitForSettled()` 方法 Phase 1：轮询等待 hash !== preHash（agent 开始响应）
- [x] 1.5 实现 `waitForSettled()` 方法 Phase 2：轮询等待内容稳定 ≥ stableThresholdMs，执行 quickPatternCheck 或 Layer 2 分析
- [x] 1.6 实现 Phase 2 error 快速逃逸：hash 变化时 quickPatternCheck 检测到 error 立即返回
- [x] 1.7 实现超时保护：总超时后返回 `{ timedOut: true }` 和当前内容
- [x] 1.8 实现 abort 检查：轮询循环中检查 abort 条件，支持中途退出

## 2. MainAgent: 阻塞式 send_to_agent / respond_to_agent

- [x] 2.1 修改 `send_to_agent` 工具：发送前捕获 preHash，发送后调用 `waitForSettled`，返回格式化的状态 + 内容
- [x] 2.2 修改 `respond_to_agent` 工具：同 2.1，发送前捕获 preHash，发送后调用 `waitForSettled`
- [x] 2.3 移除 `send_to_agent` 和 `respond_to_agent` 中的 `stateDetector.setCooldown(3000)` 调用
- [x] 2.4 更新 `fetch_more` 的 tool description，明确限制为 agent 完成后截断内容场景使用
- [x] 2.5 为 `waitForSettled` 传入 abort 检查回调（使用 `signalRouter.isAborted()`）

## 3. 辅助修改

- [x] 3.1 确认 `signalRouter.notifyPromptSent()` 保留（仅用于 `/opsx` capture expansion），移除其中任何 cooldown 相关逻辑（如有）
- [x] 3.2 确认 `waitForSignal` 路径在 cooldown 移除后仍正常工作（StateDetector 的 `startMonitoring` 不再依赖 cooldown）

## 4. 测试

- [x] 4.1 重写 `test/tmux/state-detector-cooldown.test.ts` 为 `waitForSettled` 测试：覆盖 Phase 1 → Phase 2 正常流程
- [x] 4.2 测试 Phase 1 超时（hash 始终不变）
- [x] 4.3 测试 Phase 2 error 快速逃逸
- [x] 4.4 测试 Phase 2 稳定后 active 高置信度重置等待
- [x] 4.5 测试 abort 中途退出
- [x] 4.6 测试 `send_to_agent` 和 `respond_to_agent` 的阻塞返回行为（integration-level mock）
