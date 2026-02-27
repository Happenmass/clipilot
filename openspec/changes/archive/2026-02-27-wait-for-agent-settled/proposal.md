## Why

MainAgent 在通过 `send_to_agent` 向 tmux 中的 coding agent 发送指令后，工具立即返回 `"Prompt sent to agent."`，导致 LLM 在 `runToolUseLoop` 内部不断调用 `fetch_more` 轮询结果，浪费大量 token 且产生无效的重复指令。设计意图是 StateDetector 持续监听 tmux 内容变化，在 agent 完成工作后才将结果返回给 MainAgent，但由于 `waitForSignal` 路径只在 LLM 不产生 tool calls 时才能到达，实际上从未被执行。

## What Changes

- `send_to_agent` 和 `respond_to_agent` 变为阻塞式工具：发送指令后等待 agent 完成，返回最终 pane 内容和状态分析
- 新增 `StateDetector.waitForSettled()` 方法：基于 preHash 的两阶段等待模型（Phase 1: 等待 agent 响应；Phase 2: 等待内容稳定）
- 移除 cooldown 机制（`setCooldown`、`cooldownUntil`、`isInCooldown`），由 preHash 对比替代
- 更新 `fetch_more` 工具描述，明确仅在 agent 完成工作后、输出截断时使用

## Capabilities

### New Capabilities
- `wait-for-settled`: StateDetector 的阻塞式等待能力——基于 preHash 对比的两阶段等待模型，包含 Phase 1（等待 hash 变化）和 Phase 2（等待内容稳定 + 模式匹配/LLM 分析），支持 30 分钟超时

### Modified Capabilities
- `main-agent`: `send_to_agent` 和 `respond_to_agent` 工具变为阻塞式，发送前记录 preHash，调用 `waitForSettled` 等待结果；`fetch_more` 工具描述更新
- `signal-router`: 移除 cooldown 相关逻辑，`waitForSignal` 保留作为安全网

## Impact

- `src/tmux/state-detector.ts`: 新增 `waitForSettled()` 方法，移除 cooldown 相关代码
- `src/core/main-agent.ts`: 修改 `send_to_agent`/`respond_to_agent` 工具执行逻辑，更新 `fetch_more` 描述
- `src/core/signal-router.ts`: 可能需要适配 cooldown 移除
- `test/tmux/state-detector-cooldown.test.ts`: 需要重写为 `waitForSettled` 测试
- Token 消耗预期大幅降低：消除无效的 `fetch_more` 循环
