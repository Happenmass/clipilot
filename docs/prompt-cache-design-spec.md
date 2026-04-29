# Prompt Cache 友好型 Agent 上下文设计规范

> 提炼自 OpenAI Codex CLI（Rust 实现）的实战经验，供另一个 Agent 在设计/重构其上下文组织时参照。

---

## 0. 核心目标

在面向支持 prompt caching 的大模型 API（OpenAI Responses / Chat、Anthropic Messages 等）调用时，**最大化稳定前缀的字节级一致性**，使得跨轮请求能命中缓存条目，从而显著降低 token 消耗与延迟。

衡量标准：
- 跨轮 hash 命中率（cache hit ratio）
- 单轮新增 token 数（incremental tokens）
- 上下文重写频率（prefix invalidation events / 会话）

---

## 1. 第一性原则（铁律）

> **稳定前缀，追加尾部。**

所有上下文内容必须被划分为两类，并严格执行：

| 类别 | 特征 | 行为 |
|------|------|------|
| **稳定前缀（Stable Prefix）** | 跨轮不变，构成缓存哈希基础 | 一旦设定，**绝不改写**，仅在不得已时整体失效 |
| **易变尾部（Volatile Tail）** | 每轮新增的内容 | 只允许 `append` 到 input 末尾 |

任何让前缀字节发生变化的操作（即使语义等价的重排、字段改名、空白调整）都视为缓存灾难，需要明确决策。

---

## 2. 请求 Payload 的字段顺序（强约定）

按"由稳到变"自上而下排列，序列化器必须按声明顺序输出（如 serde 默认行为），不允许 HashMap 等无序结构出现在顶层：

```
1. model                  ← 会话内固定
2. instructions / system  ← 会话开始固定
3. input / messages       ← 历史只 append
4. tools                  ← 由确定性函数从 MCP/插件状态生成
5. tool_choice            ← 静态（如 "auto"）
6. parallel_tool_calls    ← 模型能力决定
7. reasoning              ← 推理配置（effort/summary）
8. store                  ← 端点决定
9. stream                 ← 静态
10. include               ← 推理模型固定附加 ["reasoning.encrypted_content"]
11. service_tier
12. prompt_cache_key      ← = conversation_id，会话恒定
13. text / output_schema
14. client_metadata       ← 请求级（不进缓存哈希范围）
```

> 易变字段必须置于稳定字段之后；可选字段使用 `skip_serializing_if` 跳过空值，避免空字段引入版本漂移。

---

## 3. 缓存命中机制（双层锁定）

### 3.1 显式 Cache Key

```
prompt_cache_key = conversation_id
```

整个会话生命周期内 cache key 不变，让服务端命中同一缓存条目。**新会话/分叉会话才生成新 key**。

### 3.2 服务端响应链 `previous_response_id`（WebSocket / 长连接）

在传输层进一步降本：

- 检测条件：上一响应存在 + 本轮请求是历史的"严格扩展"（除 `input` 外所有字段完全相等）；
- 切换发送格式：`previous_response_id = last.response_id`，`input = 仅新增 items`；
- 一旦不满足任何一项 → 回退全量请求。

这意味着传输层**连前缀字节都不发**，是 cache 命中之上的二次优化。

### 3.3 验证不变量的代码契约

实现时必须有等价于以下逻辑的守护：
```
prev_request_without_input == new_request_without_input  // 非 input 字段必须 byte-equal
new_input.starts_with(prev_baseline_input)               // input 必须是前缀扩展
```
不满足则降级到全量。

---

## 4. Tools / MCP 的处理范式

### 4.1 每轮重建，但保证字节一致

工具列表允许每轮重建，**前提是构建过程必须确定性**：
- 同一 MCP 拓扑 → 同一组工具规格、同一顺序、同一 JSON 字段排列；
- 名字冲突走稳定哈希后缀（不是随机数）；
- 集合容器使用有序结构（`Vec`、`BTreeMap`）；不要在序列化路径上出现 `HashMap` 迭代。

> 用单元测试钉死："连续两轮请求中 `tools` 与 `instructions` 必须 byte-equal。"

### 4.2 元工具折叠（Meta-Tool Pattern）

面对潜在数十~数百个 MCP/插件工具时，**绝不全量塞进 `tools` 数组**。改用：

```
{
  "name": "search_tools",
  "description": "Search and load tools matching the task...",
  "parameters": { "query": "string" }
}
```

机制：
- 每个工具有 `defer_loading: bool` 标记；
- `defer_loading=true` 的工具从 `model_visible_specs` 中过滤掉；
- 模型按需调用 `search_tools(query)` → 返回匹配工具的 schema → 进入当轮 `input` 末尾；
- 后续轮次，被发现的工具自然处于历史尾部，仍在缓存范围内。

### 4.3 工具上下线就是缓存破坏事件

要承认这一点并设计退出路径：
- MCP server 连接/断开 → tools 变化 → 前缀失效（应破坏）；
- 不要试图通过"占位空规格"伪装稳定，那只会让模型困惑且仍然破坏哈希；
- 由用户/系统层显式触发，告知缓存失效是预期行为。

---

## 5. Skills（或类似的"知识包"）的处理范式

Codex 的核心选择：**Skill 不是 tool**。

### 5.1 元数据 vs 正文

- 元数据（`name / description / path`）：在会话开始时渲染为一段 `<available_skills>...</available_skills>` 的 **developer/system 角色消息**，进入稳定前缀；
- 正文（SKILL.md）：仅在用户**显式提及**时（`$skill-name` 或 `[$x](skill:///path)` 链接解析）才读入，作为 developer-role `ResponseItem` 追加到当轮 input 末尾。

### 5.2 为什么不做成 tool

- 工具调用走 schema 校验、JSON args 解析、handler 分发，重；
- 工具列表是稳定前缀的一部分，加 skill 会污染前缀；
- Skill 正文是大段 markdown，不适合塞进 tool description。

把 skill 当 "可被消息引用的 markdown 片段" 来管理，是把"易变内容"彻底隔离到尾部的关键。

### 5.3 提及解析

- 词法解析（state machine），不依赖 LLM；
- 过滤常见误报（`$PATH`、`$HOME` 等环境变量）；
- 同名歧义时要求显式路径，否则放弃匹配。

---

## 6. Reasoning（推理模型）的跨轮保留

### 6.1 不要依赖服务端 `store=true`

对默认 `store=false` 的端点（OpenAI 直连）必须用：
```
include = ["reasoning.encrypted_content"]
```
服务端把推理 token 加密回传 → 客户端在下一轮把这些 reasoning item **原样塞回 input** → 服务端验证连续性，并与前一轮 cached prefix 衔接。

### 6.2 reasoning 配置字段属于稳定前缀

`reasoning.effort` / `reasoning.summary` 一旦设定不要轻易变；用户改 effort 是合法的"应当破坏缓存"事件。

### 6.3 适用面

任何返回"思维 token / 思考摘要"的模型都应套用同一模式：把模型私有的中间状态存进 input 尾部，让前缀保持稳定。

---

## 7. 配置变更的"只追加"纪律

会话中常见的运行时变化（cwd 切换、sandbox 策略调整、权限升级、个性化设定切换）**绝不改写已发送的前缀**。统一处理范式：

1. 把变更渲染成一段新的 developer/system 消息（带明确开闭 marker，如 `<environment_context>...</environment_context>`）；
2. **追加到当轮 input 末尾**；
3. 历史中前面已经存在的旧版同类消息保留不动（让模型从消息时间序自行理解"以最新为准"）。

> 这是 Codex 用 `prompt_caching.rs` 单元测试守护的最重要不变量之一。
> 测试模式：模拟"用户中途修改 sandbox/cwd"→ 断言 `body2["input"][0..N]` 与 `body1["input"][0..N]` byte-equal，新内容只能出现在 `body2["input"][N..]`。

---

## 8. 历史压缩（Compact）：可控的缓存失效

历史压缩本质上重写了 input 前缀，**必然破坏缓存**。设计要点：

- **由用户/阈值显式触发**，不要悄悄发生；
- 压缩后视作"新的稳定前缀的开始"，cache_key 可保持不变（让服务端按新前缀重新建缓存条目）；
- 压缩点应稀疏——例如直到 input 占用接近上下文上限的 70% 再触发，避免高频失效；
- 把"压缩了哪一段"作为可追溯的 marker 写进新前缀，便于调试。

---

## 9. 必须落地的不变量测试（CI 守护）

最低限度三组：

```
test_1: instructions_and_tools_are_byte_equal_across_turns
  - 起会话 → 跑两轮（不改任何配置）
  - 断言 body0["instructions"] == body1["instructions"]
  - 断言 body0["tools"] == body1["tools"]（含顺序、字段命名）

test_2: prompt_cache_key_stays_constant_across_runtime_overrides
  - 起会话 → 跑一轮 → 改 sandbox/effort → 跑第二轮
  - 断言 body0["prompt_cache_key"] == body1["prompt_cache_key"]
  - 断言 body1["input"][0..len(body0.input)] 与 body0["input"] byte-equal
  - 断言新增内容仅出现在 body1["input"][len(body0.input)..]

test_3: deterministic_tool_serialization
  - 给定同一 MCP 拓扑，重复构造 N 次 tools
  - 断言两两 byte-equal（杜绝 HashMap 顺序漂移）
```

---

## 10. 反模式清单（必须避免）

| 反模式 | 后果 |
|--------|------|
| 在请求顶层使用 HashMap 序列化 | 字段顺序漂移，前缀爆掉 |
| 工具列表用集合迭代序生成 | 同状态不同字节 |
| 配置变更时改写历史中的旧消息 | 前缀全部失效 |
| 把 skill 全文塞进 system prompt | 前缀膨胀且每次提及都失效 |
| 默认全量加载所有 MCP 工具 | 前缀肥大，工具上下线频繁失效 |
| 在 instructions 里嵌时间戳/请求 ID | 永久不命中 |
| 推理模型不回传 encrypted_content | 模型行为漂移 + 缓存断裂 |
| 用 LLM 解析 skill mention | 慢、不确定、引入额外调用 |
| 在 cache key 里塞高基数变量 | 缓存条目爆炸，无命中 |
| 中途切换字段命名（`messages` ↔ `input`） | 整段历史重序列化 |

---

## 11. 决策检查表（设计 review 时逐项过）

- [ ] 顶层 payload 字段顺序是否声明序固定？
- [ ] `prompt_cache_key` 是否绑定 `conversation_id`（或同等粒度）？
- [ ] 是否区分了"稳定前缀"与"易变尾部"两类内容？
- [ ] tools 是否由确定性函数生成？是否有 byte-equal 测试？
- [ ] 大量工具是否走 meta-tool / deferred loading？
- [ ] Skills/知识包是否独立于 tools，按 mention 注入尾部？
- [ ] 推理模型是否走 `include=[reasoning.encrypted_content]` 链路？
- [ ] 运行时配置变更是否走"追加 developer 消息"而非改写？
- [ ] 是否实现了增量 input + `previous_response_id` 优化（长连接场景）？
- [ ] 历史压缩是否仅在显式阈值触发，并视作可控失效？
- [ ] CI 是否有缓存稳定性回归测试？

---

## 12. 一句话总结

> **把一切能在会话内固定的内容固定下来；把一切必须变化的内容追加到尾部；让传输层与服务端缓存层各自做它们最擅长的事。**

---

## 附录 A：Codex 实现参考点

| 主题 | 文件 |
|------|------|
| 请求 struct 定义 | `codex-rs/codex-api/src/common.rs:165` |
| 请求装配 | `codex-rs/core/src/client.rs:831`（`build_responses_request`） |
| cache key 设定 | `codex-rs/core/src/client.rs:880` |
| reasoning 加密回放 | `codex-rs/core/src/client.rs:856`（`include`） |
| WS 增量传输 | `codex-rs/core/src/client.rs:985`（`prepare_websocket_request`） |
| 增量校验 | `codex-rs/core/src/client.rs:936`（`get_incremental_items`） |
| 工具构建入口 | `codex-rs/core/src/session/turn.rs:1108`（`built_tools`） |
| ToolRouter 过滤 | `codex-rs/core/src/tools/router.rs:55` |
| 延迟工具过滤 | `codex-rs/core/src/tools/router.rs:300` |
| MCP 工具去重 | `codex-rs/codex-mcp/src/tools.rs:138` |
| Skill 元数据 | `codex-rs/core-skills/src/model.rs:1` |
| Skill 提及解析 | `codex-rs/core-skills/src/injection.rs:114` |
| Skill 注入 | `codex-rs/core/src/session/turn.rs:249` |
| 可用 skill 列表渲染 | `codex-rs/core/src/session/mod.rs:2617` |
| 历史压缩 | `codex-rs/core/src/compact.rs` |
| 缓存稳定性测试 | `codex-rs/core/tests/suite/prompt_caching.rs:100`、`:394` |

---

## 附录 B：OpenAI Responses API 调用参数全字段清单

> 以 Codex 出站 `ResponsesApiRequest`（[`codex-rs/codex-api/src/common.rs:165`](codex-rs/codex-api/src/common.rs:165)）为基准，列出 Codex 实际写入或显式跳过的全部顶层字段。第三方 Agent 在自行实现时，**必须**对每一字段做出"稳定 / 易变 / 跳过"的明确决策。

### B.1 顶层字段表（按声明序，即序列化输出顺序）

| 序 | 字段 | 类型 | Codex 取值 / 来源 | 跳过条件 | 稳定性 | 缓存意义 |
|----|------|------|-------------------|---------|--------|----------|
| 1 | `model` | `String` | `model_info.slug.clone()` | 永不跳过 | 会话内固定 | 模型变 → 缓存条目变 |
| 2 | `instructions` | `String` | `prompt.base_instructions.text` | `String::is_empty()` | 会话开始固定 | 整体作为 system prompt 进入哈希前缀 |
| 3 | `input` | `Vec<ResponseItem>` | `prompt.get_formatted_input()` | 永不跳过（可空数组） | 只 append 扩展 | 前 N 项是历史前缀，第 N+ 项是当轮新增 |
| 4 | `tools` | `Vec<serde_json::Value>` | `create_tools_json_for_responses_api(&prompt.tools)` | 永不跳过（可空数组） | 给定 MCP 状态字节级一致 | 顺序+字段命名都进哈希 |
| 5 | `tool_choice` | `String` | 恒 `"auto"` | 永不跳过 | 静态 | 缓存中性 |
| 6 | `parallel_tool_calls` | `bool` | `prompt.parallel_tool_calls`（= `model_info.supports_parallel_tool_calls`） | 永不跳过 | 模型决定 | 切模型才会变 |
| 7 | `reasoning` | `Option<Reasoning>` | 见 B.2 | `None`（非推理模型） | 用户改 effort 才变 | 改动即破坏前缀 |
| 8 | `store` | `bool` | `provider.is_azure_responses_endpoint()` | 永不跳过 | 端点决定 | 控制服务端是否保留响应 |
| 9 | `stream` | `bool` | 恒 `true` | 永不跳过 | 静态 | 缓存中性 |
| 10 | `include` | `Vec<String>` | 推理模型 `["reasoning.encrypted_content"]`，否则 `[]` | 永不跳过（可空数组） | 与 reasoning 联动 | 推理模型必填 |
| 11 | `service_tier` | `Option<String>` | `Fast→"priority"` / 其他→`service_tier.to_string()` / 不设→`None` | `Option::is_none()` | 用户切档才变 | 一般稳定 |
| 12 | `prompt_cache_key` | `Option<String>` | `Some(state.conversation_id.to_string())` | `Option::is_none()` | **会话恒定** | 显式锁定缓存条目 |
| 13 | `text` | `Option<TextControls>` | 见 B.3 | `Option::is_none()` | 输出 schema/verbosity 改才变 | 改动即破坏前缀 |
| 14 | `client_metadata` | `Option<HashMap<String,String>>` | `{X_CODEX_INSTALLATION_ID_HEADER: installation_id}` | `Option::is_none()` | 安装级常量 | 不进入缓存哈希范围（请求级元数据） |

> **重要**：`tools` 字段虽是 `Vec<serde_json::Value>`，但其 JSON 内容来自 `create_tools_json_for_responses_api`，必须保证字段顺序一致——见 B.4。

### B.2 `reasoning` 子字段（推理模型必填）

```rust
struct Reasoning {
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<ReasoningEffortConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<ReasoningSummaryConfig>,
}
```

| 字段 | 取值 | Codex 来源 | 稳定性 |
|------|------|-----------|--------|
| `effort` | `"minimal" / "low" / "medium" / "high"` | `effort.or(model_info.default_reasoning_level)` | 用户/配置切档才变 |
| `summary` | `"auto" / "concise" / "detailed"` | `summary` 配置；为 `None` 时整字段省略 | 设定后稳定 |

构造逻辑（[`client.rs:844`](codex-rs/core/src/client.rs:844)）：
```rust
let reasoning = if model_info.supports_reasoning_summaries {
    Some(Reasoning {
        effort: effort.or(default_reasoning_effort),
        summary: if summary == ReasoningSummaryConfig::None { None } else { Some(summary) },
    })
} else { None };
```

> **联动 `include`**：当 `reasoning.is_some()` 时必须设 `include = ["reasoning.encrypted_content"]`，否则空数组。这是把推理 token 安全跨轮回放的唯一开关。

### B.3 `text` 子字段（输出格式控制）

```rust
struct TextControls {
    #[serde(skip_serializing_if = "Option::is_none")]
    verbosity: Option<OpenAiVerbosity>,        // "low" / "medium" / "high"
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<TextFormat>,                 // 结构化输出 schema
}

enum TextFormat {
    JsonSchema {
        name: String,
        schema: serde_json::Value,
        strict: bool,
    },
}
```

来自 `create_text_param_for_request(verbosity, output_schema, strict)`（[`client.rs:875`](codex-rs/core/src/client.rs:875)）：
- 不需要任何控制时整个 `text` 字段输出为 `None` 并跳过；
- `verbosity` 仅在 `model_info.support_verbosity` 时生效，否则警告并丢弃；
- `output_schema` 由 turn-level `final_output_json_schema` 提供；`strict` 由是否为 guardian reviewer 决定。

> **缓存影响**：对话型场景中 `text` 通常为 `None`；一旦设了 schema 且后续轮次 schema 变化，整段缓存失效。

### B.4 `tools` 数组中每个工具规格的字段

由 [`ToolSpec`](codex-rs/core/src/tools/) 经 `create_tools_json_for_responses_api` 序列化为以下两种 variant 之一：

**Function tool**（最常见）：
```json
{
  "type": "function",
  "name": "string",
  "description": "string",
  "strict": false,
  "parameters": { /* JSON Schema */ }
}
```

**Namespace tool**（用于把多个 MCP 工具归入同一命名空间）：
```json
{
  "type": "namespace",
  "name": "string",
  "description": "string",
  "tools": [
    { "type": "function", "name": "...", "description": "...", "parameters": {...} }
  ]
}
```

字段稳定性要点：
- `name` 必须经 `qualify_tools` 确定性命名（碰撞走 SHA1 后缀，不用随机数）；
- `parameters` JSON Schema 内的字段顺序由原始 schema 决定——上游 MCP 服务返回顺序漂移会传染到这里，必要时在客户端用 `BTreeMap` 重排；
- `description` 不要拼接时间戳、请求 ID、随机 nonce。

### B.5 `input` 数组中 ResponseItem 的形态

以下形态都允许出现在 `input` 中，按 chronological 顺序排列：

| `type` | 角色 | 用途 | 稳定性 |
|--------|------|------|--------|
| `message` (`role: "system"`) | system | 极少使用，优先用 `instructions` | 不应出现在 input |
| `message` (`role: "developer"`) | developer | 环境上下文、可用 skill 列表、运行时配置变更 | 历史项稳定，新增项追加尾部 |
| `message` (`role: "user"`) | user | 用户输入 | 每轮追加 |
| `message` (`role: "assistant"`) | assistant | 模型上一轮回复 | 历史稳定 |
| `function_call` | — | 模型发起的工具调用 | 历史稳定 |
| `function_call_output` | — | 工具调用返回 | 历史稳定 |
| `reasoning` | — | 推理模型私有思维（含 `encrypted_content`） | 必须原样回传 |
| `custom_tool_call` / `custom_tool_call_output` | — | 自定义工具协议 | 历史稳定 |

> **关键纪律**：永远不要修改/删除/重排已经发送过的 `input` 项。配置变更走"在尾部追加新 developer 消息"。

### B.6 WebSocket 增量请求形态

```rust
struct ResponseCreateWsRequest {
    // 与 ResponsesApiRequest 完全同构，但额外允许：
    previous_response_id: Option<String>,
}
```

切换为增量发送时（[`client.rs:1006`](codex-rs/core/src/client.rs:1006)）：
- `previous_response_id = Some(last_response.response_id)`；
- `input` 仅包含相对 `previous_request.input + last_response.items_added` 的**新增 item**；
- 其他所有字段必须与上一轮完全 byte-equal（[`client.rs:948`](codex-rs/core/src/client.rs:948) 校验）。

### B.7 HTTP 路径专属：请求头

虽不属于 body，但影响调用形态：

| Header | 来源 | 说明 |
|--------|------|------|
| `Authorization` | API key / OAuth | 不进缓存哈希 |
| `OpenAI-Beta` | 如需启用未 GA 特性 | 影响服务端解释，谨慎 |
| `OpenAI-Organization` / `OpenAI-Project` | 多租户路由 | 与 cache key 联合作为命名空间 |
| `User-Agent` / 自定义诊断头 | Codex 安装 ID 等 | 不进缓存哈希 |

### B.8 默认值与省略策略速查

| 字段 | 默认 | 何时显式写出 |
|------|------|--------------|
| `instructions` | `""` | 非空才出 |
| `tool_choice` | — | Codex 总是写 `"auto"` |
| `parallel_tool_calls` | — | 总是写 |
| `reasoning` | `None` | 推理模型才写 |
| `store` | — | 总是写（端点决定） |
| `stream` | — | 总是写 `true` |
| `include` | `[]` | 总是写（数组可空） |
| `service_tier` | `None` | 用户切档才写 |
| `prompt_cache_key` | `None` | Codex 总是写（= conversation_id） |
| `text` | `None` | 需 verbosity / schema 才写 |
| `client_metadata` | `None` | Codex 总是写（installation_id） |

### B.9 字段对缓存命中的影响等级

| 等级 | 字段 | 任意改动后果 |
|------|------|-------------|
| 🔴 致命（前缀失效） | `model` / `instructions` / `tools` / `reasoning` / `store` / `stream` / `parallel_tool_calls` / `include` / `text` / `tool_choice` | 缓存条目作废，全量计费 |
| 🟡 显著（条目漂移） | `prompt_cache_key` | 改动即指向新缓存条目，原条目失效 |
| 🟢 中性 | `service_tier`（视实现）/ `client_metadata` / 请求头 | 通常不进哈希范围 |
| ⚪️ 仅尾部计费 | `input` 末尾新增项 | 命中前缀缓存，仅按新增 token 计费 |

### B.10 实现自查清单

- [ ] 是否有一个**唯一**的请求构造函数（如 Codex 的 `build_responses_request`）？
- [ ] 该函数对每一字段都有显式赋值或显式跳过，无遗漏？
- [ ] 序列化器是否保证字段按声明序输出（serde 默认 OK；若用其他库需验证）？
- [ ] `Option` 字段是否正确使用 `skip_serializing_if`，避免空字段进入 payload？
- [ ] `tools` JSON 内字段顺序是否在跨轮间 byte-equal？
- [ ] `reasoning.is_some()` 与 `include` 中 `"reasoning.encrypted_content"` 的存在严格联动？
- [ ] `prompt_cache_key` 是否绑定 `conversation_id` 这一稳定值？
- [ ] WebSocket 增量发送时是否实现了"非 input 字段全等 + input 严格扩展"双重校验？
- [ ] 是否有针对每条字段的"何时变化"决策记录在团队文档？

