## ADDED Requirements

### Requirement: 滑动窗口保留最近 N 个工具结果完整内容

`transformContext()` SHALL 统计所有 `role: "tool"` 消息，仅保留最近 N 个（由 `toolResultRetention` 配置，默认 20）的完整内容。超出窗口的 tool result SHALL 被替换为摘要字符串。

#### Scenario: 工具调用未超出窗口

- **WHEN** 对话中有 15 个 tool result 消息，`toolResultRetention` 为 20
- **THEN** 所有 tool result 保持原始内容不变

#### Scenario: 工具调用超出窗口

- **WHEN** 对话中有 25 个 tool result 消息，`toolResultRetention` 为 20
- **THEN** 前 5 个 tool result 被替换为摘要，后 20 个保持完整

### Requirement: 工具结果摘要包含工具名称、状态和首行信息

超出窗口的 tool result SHALL 被替换为格式 `[{tool_name} → {status}] {first_line_summary}` 的摘要字符串。

- `tool_name` SHALL 通过 `toolCallId` 反向查找对应 assistant 消息中的 `tool_call` content block 获取
- `status` SHALL 为 `✓`（成功）或 `✗`（失败）
- `first_line_summary` SHALL 为原始内容第一行的前 150 个字符

#### Scenario: 成功的 send_to_agent 摘要

- **WHEN** tool result 内容为 `[Agent completed] (Refactored auth module)\nsrc/auth.ts ...` 且对应 tool_call name 为 `send_to_agent`
- **THEN** 摘要为 `[send_to_agent → ✓] [Agent completed] (Refactored auth module)`

#### Scenario: 失败的 exec_command 摘要

- **WHEN** tool result 内容为 `[exit code: 1]\ncommand not found: rg` 且对应 tool_call name 为 `exec_command`
- **THEN** 摘要为 `[exec_command → ✗] [exit code: 1]`

#### Scenario: 无法找到工具名称

- **WHEN** tool result 的 `toolCallId` 在之前的 assistant 消息中找不到匹配的 tool_call
- **THEN** 摘要中 `tool_name` SHALL 为 `unknown`

### Requirement: 失败状态判断基于内容模式匹配

状态判断 SHALL 基于 tool result 内容的首行进行模式匹配：
- 以 `Error:` 开头 → ✗
- 以 `Failed` 开头 → ✗
- 包含 `[exit code:` → ✗
- 其他 → ✓

#### Scenario: Error 前缀

- **WHEN** tool result 内容首行为 `Error: No active session. Call create_session first.`
- **THEN** status 为 `✗`

#### Scenario: 正常返回

- **WHEN** tool result 内容首行为 `Session "clipilot-auth" created in /home/user/project`
- **THEN** status 为 `✓`

### Requirement: 超出窗口的 tool_call 参数 SHALL 被截断

对于超出窗口的 tool result，其对应的 assistant 消息中 `tool_call` content block 的 `arguments` SHALL 被压缩：arguments 中类型为 string 且长度超过 200 字符的值 SHALL 被截断为前 200 字符并追加 `"..."`。

#### Scenario: 长 prompt 参数截断

- **WHEN** 超出窗口的 tool_call arguments 为 `{ prompt: "请帮我...(500字)" }`
- **THEN** arguments 变为 `{ prompt: "请帮我...(前200字符)..." }`

#### Scenario: 短参数保持不变

- **WHEN** 超出窗口的 tool_call arguments 为 `{ value: "y" }`
- **THEN** arguments 保持不变

### Requirement: 滑动窗口在 transformContext 中最先执行

滑动窗口压缩 SHALL 作为 `transformContext()` 的 Step 0 执行，在现有的单条截断（Step 1）和预算溢出压缩（Step 2）之前。

#### Scenario: 执行顺序

- **WHEN** `transformContext()` 被调用且有超出窗口的 tool result
- **THEN** Step 0 先将旧 tool result 替换为摘要，然后 Step 1 对保留的 tool result 做单条截断检查，最后 Step 2 做预算溢出兜底
