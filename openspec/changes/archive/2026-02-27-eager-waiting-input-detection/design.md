## Context

`waitForSettled` 采用两阶段模型：Phase 1 等待 hash 变化，Phase 2 等待内容稳定后分析状态。Phase 2 在 hash 变化时仅对 error 做 fast-escape。

Claude Code 的 UI 是多层并行渲染的——上方的 ⏺ 动画持续变化，下方同时出现权限确认的编号选项菜单。这导致 hash 永远不稳定，`waiting_input` 信号无法被检测。

## Goals / Non-Goals

**Goals:**
- 在内容仍在变化时，能及时检测到交互提示并返回 `waiting_input`
- 保持现有 active 检测的准确性（动画 = 活跃的假设在绝大多数情况下仍成立）

**Non-Goals:**
- 不做内容规范化（去除动画字符后再算 hash），因为动画在 99% 场景下是 agent 活跃的可靠信号
- 不改变 Phase 1 的行为
- 不改变 Layer 2 LLM 分析的触发逻辑

## Decisions

### 1. 在 hash 变化分支增加 waiting_input fast-escape

**选择**: 与 error fast-escape 并列，在 `waitForSettled` Phase 2 每次 hash 变化时，如果 `quickPatternCheck` 返回 `waiting_input`，立即返回。

**理由**: 交互提示出现时必须尽快响应，不能等稳定。error 和 waiting_input 是同等优先级的"需要立刻处理"信号。

**替代方案**:
- 内容规范化后再算 hash → 破坏了"动画=活跃"的核心假设
- 只在稳定后检测 → 就是当前的 bug

### 2. 用 `❯\s*\d+\.\s` 作为编号选项菜单的检测 pattern

**选择**: 在 `waitingPatterns` 增加 `/❯\s*\d+\.\s/`。

**理由**: `❯` + 数字编号是 Claude Code 交互菜单的特异性标记，误报率极低。现有的 `/\?.*:?\s*$/m` 虽然也能匹配 "Do you want to proceed?"，但过于宽泛。新 pattern 作为高置信度补充。

### 3. quickPatternCheck 扫描范围扩到 8 行

**选择**: `slice(-5)` → `slice(-8)`。

**理由**: Claude Code 权限提示通常包含 "Do you want to proceed?" + 2-3 个选项 + 底部提示行 ("Esc to cancel · Tab to amend")，总共约 6-7 行。5 行可能不够，8 行留有余量。

## Risks / Trade-offs

- **误报风险**: agent 输出的内容中可能碰巧包含 `❯ 1.` 格式的文本 → 概率极低，`❯` 是特殊 Unicode 字符，几乎只出现在交互菜单中
- **扫描范围扩大的性能影响**: 从 5 行到 8 行，regex 匹配开销可忽略不计
- **与 active pattern 同时匹配**: 如果 `⏺ Searching...` 匹配 active，`❯ 1.` 匹配 waiting，`quickPatternCheck` 按当前顺序先检查 waiting 再检查 active，所以 waiting 优先 → 行为正确
