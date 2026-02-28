## Context

ContextManager 的 `transformContext()` 当前有两层工具结果保护：Step 1 单条截断（> 50% context window）和 Step 2 预算溢出压缩（总量 > 75%）。两者都是被动机制——只有在上下文已经膨胀到危险水平才触发。在长任务中，大量 `send_to_agent`、`respond_to_agent` 返回的 pane content 会快速消耗上下文，而被动压缩后的占位符 `[compacted: tool output removed...]` 不携带任何信息，模型丢失决策链路。

## Goals / Non-Goals

**Goals:**

- 主动控制工具上下文占用：通过滑动窗口，仅保留最近 N 次工具调用的完整内容
- 保留决策链路：压缩后的摘要包含工具名称、成功/失败状态和首行关键信息
- 同时压缩 tool result（role: "tool"）和对应的 tool_call content block（assistant 消息中的参数）
- 可配置的窗口大小，适应不同模型上下文窗口

**Non-Goals:**

- 不改变现有 Step 1 和 Step 2 的逻辑，它们作为安全网保留
- 不引入 LLM 调用来生成摘要（纯规则摘要，零额外开销）
- 不改变对话消息的存储结构或 LLMMessage 类型

## Decisions

### Decision 1: 摘要格式采用"中等方案"

**选择**: `[{tool_name} → {status}] {first_line_summary(150 chars)}`

**替代方案**:
- 极简方案 `[tool: name → success/fail]`：信息量不足，模型无法追踪 agent 经历了哪些状态变迁
- LLM 摘要方案：每次压缩都要调 LLM，延迟和成本不可接受

**理由**: 工具结果的第一行已经是结构化的状态信息（如 `[Agent completed] (detail)`），直接提取即可。150 字符足够传达关键信息，一条摘要大约 40-50 tokens，20 条之外的旧结果压缩到约 1000 tokens，对比原始可能节省 10x+。

### Decision 2: tool_call 参数截断阈值 200 字符

**选择**: 对超出窗口的 tool_call content block，将 arguments 中超过 200 字符的字符串值截断并追加 `"..."`

**理由**: `send_to_agent` 的 prompt 参数经常上千字符，但工具名称和截断后的前 200 字符足以让模型理解"当时发了什么指令"。200 字符约 50 tokens，开销可控。

### Decision 3: 通过 toolCallId 反向关联

**选择**: 从超出窗口的 tool result 出发，收集其 `toolCallId`，然后遍历 assistant 消息中的 `tool_call` blocks 做匹配压缩

**替代方案**: 直接按消息索引位置估算对应关系——不可靠，因为一个 assistant 消息可能包含多个 tool_call

**理由**: `toolCallId` 是精确的 1:1 映射，实现可靠且简单

### Decision 4: 执行顺序为 Step 0 → Step 1 → Step 2

**选择**: 滑动窗口（Step 0）在最前执行，之后是现有的单条截断（Step 1）和预算溢出（Step 2）

**理由**: Step 0 主动减少上下文，减轻后续步骤压力。Step 1 保护保留窗口内的巨大单条结果。Step 2 在极端情况下兜底。

### Decision 5: 成功/失败判断采用首行模式匹配

**选择**: 基于 tool result 内容的模式匹配判断状态：
- `Error:` / `Failed` / `[exit code:` 开头 → 失败 (✗)
- 其他 → 成功 (✓)

**理由**: 所有内置工具的错误输出都遵循这些模式（见 `executeTool` 的实现），规则匹配零开销且准确率足够。

## Risks / Trade-offs

- **[信息丢失]** 超出窗口的工具输出细节不可恢复 → 150 字符首行摘要保留核心状态；如果模型需要回溯旧上下文，可通过 `memory_search` 查找（前提是 memory flush 已持久化关键信息）
- **[固定窗口不适应所有场景]** 20 作为默认值可能对 32k 模型太大、对 200k 模型太保守 → 通过 `toolResultRetention` 配置项暴露，用户可按需调整
- **[tool_call 截断可能丢失指令上下文]** 200 字符可能截掉关键的指令后半段 → 对于超出窗口的旧调用，模型更需要知道"做了什么"而非"具体怎么说的"，200 字符通常覆盖了指令的开头意图
