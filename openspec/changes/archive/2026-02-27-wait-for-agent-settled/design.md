## Context

当前 MainAgent 的 `runToolUseLoop` 是一个无界循环：LLM 返回 tool calls → 执行工具 → 结果追加到 conversation → 继续调 LLM。`send_to_agent` 工具立即返回 `"Prompt sent to agent."`，不等待 agent 完成工作。LLM 看到返回后自然地调用 `fetch_more` 检查结果，`fetch_more` 也立即返回当前 tmux 内容，于是 LLM 反复轮询，浪费大量 token。

现有的 StateDetector 已具备完整的监控基础设施（轮询、hash 对比、稳定阈值、模式匹配、LLM 语义分析），但这些逻辑只在 `waitForSignal` 路径中生效——该路径需要 `runToolUseLoop` 返回 null（LLM 不产生 tool calls），实际上在 `send_to_agent` 场景下永远不会到达。

现有 cooldown 机制（发送后 3 秒冷却）是基于时间的粗略保护，用于防止 StateDetector 误判旧内容为完成状态。

## Goals / Non-Goals

**Goals:**
- `send_to_agent` 和 `respond_to_agent` 阻塞直到 agent 完成工作后才返回最终内容
- 用精确的 preHash 对比替代粗略的 cooldown 时间窗口
- 大幅减少无效 token 消耗（消除 fetch_more 轮询循环）
- 保持 `waitForSignal` 作为安全网路径

**Non-Goals:**
- 不改变 `runToolUseLoop` 或 `runMainLoop` 的整体结构
- 不改变 StateDetector 的 Layer 2 LLM 分析逻辑
- 不改变 SignalRouter 的信号分流规则
- 不改变现有的 polling interval 或 stable threshold 配置

## Decisions

### Decision 1: 在 StateDetector 上新增 `waitForSettled()` 方法

**选择**: 将阻塞等待逻辑封装为 StateDetector 的新方法，而非在 MainAgent 中实现。

**理由**: StateDetector 已拥有 tmux 轮询、hash 对比、模式匹配、LLM 分析的全部基础设施。`waitForSettled` 是这些能力的同步化封装，放在 StateDetector 中最自然。MainAgent 只需在工具执行时调用即可。

**替代方案**: 在 MainAgent 的 `executeTool` 中直接实现轮询逻辑。但这会让 MainAgent 承担状态检测职责，违反单一职责。

### Decision 2: 两阶段等待模型（Phase 1 + Phase 2）

**选择**:
- Phase 1: 等待 hash 变化（agent 开始响应）
- Phase 2: 等待内容稳定（agent 完成工作）

**理由**: 两阶段清晰地分离了"agent 是否收到指令"和"agent 是否完成工作"这两个关注点。Phase 1 保证我们不会在 agent 还没开始时就误判为完成。

### Decision 3: preHash 替代 cooldown

**选择**: 发送指令前记录 tmux 的 content hash，用 hash 变化作为 agent 已响应的判据，移除基于时间的 cooldown。

**理由**: preHash 是精确的事实判断——"内容确实变了"比"3 秒应该够了"可靠得多。它同时解决了：
- 快速完成的 agent：hash 变了又稳定了，无需等不必要的 cooldown
- 慢启动的 agent：hash 没变就继续等，不受固定时间窗口限制
- 误判问题：cooldown 期间跳过的 pattern 现在天然被 Phase 1/2 分离覆盖

**替代方案**: 保留 cooldown 作为 Phase 1 的最小等待时间。但 preHash 已完全覆盖其功能，增加 cooldown 只会延迟快速 agent 的响应。

### Decision 4: 超时保护设为 30 分钟

**选择**: `waitForSettled` 默认 timeoutMs = 1800000 (30 分钟)。

**理由**: agent 执行大型任务（如全面重构、大量测试）可能耗时很长。30 分钟是合理的上限。超时后返回当前内容 + timeout 状态，让 LLM 自行决策。

### Decision 5: Phase 2 中 error 快速逃逸

**选择**: 在 Phase 2 的每次轮询中，如果内容变化时 quickPatternCheck 检测到 error pattern，立即返回，不等待稳定阈值。`waiting_input` 只在稳定后检测。

**理由**: error 是确定性事件，尽早返回可以让 MainAgent 快速响应。而 `waiting_input` 的 pattern（如 `y/n`）可能出现在 agent 输出的中间过程中，只有在内容稳定后检测才可靠。

### Decision 6: 保留 fetch_more 但限制使用场景

**选择**: 保留 `fetch_more` 工具，但通过 tool description 明确限制其使用场景：仅在 agent 已完成工作、输出明显截断时使用。

**理由**: `send_to_agent` 返回的内容受 captureLines 限制（默认 50 行），对于长输出的任务，LLM 确实可能需要看到更多历史内容。但不应再用于轮询 agent 进度。

## Risks / Trade-offs

**[长时间阻塞 tool execution]** → MainAgent 在 `waitForSettled` 期间完全阻塞，无法响应用户交互或 abort 信号。→ Mitigation: 在 `waitForSettled` 的轮询循环中检查 `signalRouter.isAborted()`，支持中途退出。

**[Phase 1 永不满足（hash 不变化）]** → 某些情况下 agent 可能不产生可见输出（如内部处理）。→ Mitigation: 总超时覆盖此情况。30 分钟后返回 timeout 状态让 LLM 决策。

**[稳定阈值太长（10s）导致响应延迟]** → 快速任务完成后仍需等 10 秒才能判定为稳定。→ 这是现有配置的 trade-off，本次不调整。可通过配置 `stableThresholdMs` 微调。

**[现有 startMonitoring/stopMonitoring 路径影响]** → 移除 cooldown 后，`waitForSignal` 路径中 StateDetector 的 `quickPatternCheck` 不再跳过 cooldown 期间的 completion/waiting patterns。→ Mitigation: `waitForSignal` 只在 `send_to_agent` 已返回后进入，此时 tmux 内容已经是 agent 完成后的状态，不存在误判风险。
