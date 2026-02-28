## Why

工具调用次数增多后，tool result 和 tool_call 的原始内容累积占用大量上下文窗口。当前仅在总量超过 75% 时才被动压缩，且压缩后的占位符（`[compacted: tool output removed...]`）不携带任何有用信息，导致模型丢失决策链路。需要一种主动的滑动窗口机制，保留最近 N 次工具调用的完整内容，将更早的替换为携带关键信息的简短摘要。

## What Changes

- 在 `transformContext()` 中新增 Step 0：滑动窗口压缩，仅保留最近 N 个 tool result 的完整内容
- 超出窗口的 tool result 替换为中等信息量的摘要：`[{tool_name} → {status}] {first_line_summary}`
- 超出窗口的 assistant 消息中对应的 tool_call content block，其 arguments 中超长字符串截断至 200 字符
- N 作为可配置参数 `toolResultRetention`，默认值 20
- 现有 Step 1（单条截断）和 Step 2（预算溢出兜底）保持不变，作为安全网

## Capabilities

### New Capabilities

- `tool-result-sliding-window`: 工具结果滑动窗口压缩机制，包括 tool result 摘要生成、tool_call 参数截断、关联查找逻辑

### Modified Capabilities

- `context-manager`: 新增 `toolResultRetention` 配置项，`transformContext` 增加 Step 0 滑动窗口阶段

## Impact

- `src/core/context-manager.ts` — 主要改动文件：新增配置项、三个 private 方法、transformContext 新增 Step 0
- `src/utils/config.ts` — 可选：暴露 `toolResultRetention` 到用户配置
- `test/core/context-manager.test.ts` — 新增滑动窗口相关测试
- 不影响 LLM 消息格式、不影响 main-agent 工具定义、不影响其他组件
