## 1. 配置扩展

- [x] 1.1 在 `ContextManagerConfig` 接口中添加 `toolResultRetention?: number` 字段
- [x] 1.2 在 constructor 中读取配置，默认值 20，存储为 `private toolResultRetention: number`

## 2. 核心方法实现

- [x] 2.1 实现 `private findToolName(messages, toolCallId, beforeIndex): string` — 从 tool result 向前回溯查找 assistant 消息中匹配的 tool_call block，返回工具名称，找不到返回 `"unknown"`
- [x] 2.2 实现 `private summarizeToolResult(toolName, content): string` — 提取首行（截断 150 字符），判断成功/失败状态（Error:/Failed/[exit code: → ✗，其他 → ✓），返回 `[{name} → {status}] {summary}`
- [x] 2.3 实现 `private truncateToolCallArgs(block: ToolCallContent): void` — 遍历 arguments，将超过 200 字符的 string 值截断并追加 `"..."`

## 3. transformContext 集成

- [x] 3.1 在 `transformContext()` 现有 Step 1 之前添加 Step 0：收集所有 tool result 消息索引，超出 `toolResultRetention` 窗口的收集其 toolCallId 到 Set 中
- [x] 3.2 Step 0 遍历超出窗口的 tool result，调用 `findToolName` + `summarizeToolResult` 替换内容
- [x] 3.3 Step 0 遍历 assistant 消息，对 `compactedCallIds` 中匹配的 tool_call block 调用 `truncateToolCallArgs`
- [x] 3.4 更新 Step 2 的 COMPACTED_PLACEHOLDER 检查条件，使其也跳过已被滑动窗口摘要替换的 tool result（避免重复压缩）

## 4. 测试

- [x] 4.1 测试：工具调用数 < retention 时所有内容保持不变
- [x] 4.2 测试：工具调用数 > retention 时，旧的被替换为正确格式的摘要，新的保持完整
- [x] 4.3 测试：成功/失败状态判断（Error:、Failed、[exit code:、正常内容）
- [x] 4.4 测试：tool_call 参数截断（长字符串截断 + 短字符串不变）
- [x] 4.5 测试：toolCallId 关联查找（正常匹配 + 找不到返回 unknown）
- [x] 4.6 测试：Step 0 → Step 1 → Step 2 执行顺序正确（Step 2 跳过已摘要的结果）

## 5. 配置暴露（可选）

- [x] 5.1 在 `src/utils/config.ts` 中暴露 `toolResultRetention` 到用户配置
