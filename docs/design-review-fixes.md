# CLIPilot 当前设计待修复问题

> 基于当前代码实现的设计审查整理。本文只记录需要优先修复的问题、风险和建议方向，不展开实现细节。

## 目标

- 给当前设计中的关键缺陷建立一份可追踪的问题清单
- 按优先级说明风险，避免后续修复顺序失焦
- 为后续拆分任务、补测试和设计重构提供依据

## 修复优先级

### P1

需要优先修复。问题会直接破坏主流程正确性、状态一致性或记忆可靠性。

### P2

建议尽快修复。问题会导致用户体验、系统可控性或安全边界明显退化。

### P3

可排入后续迭代。问题不会立即破坏主流程，但会持续增加维护成本或误导使用者。

---

## P1 问题

### 1. `handleMessage()` 缺少串行化保护 `[已修复]`

**现象**

- 多条用户消息在 `idle` 状态下可能并发进入处理流程
- 两次调用都可能在状态切换到 `executing` 之前完成 `streamLLMResponse()`
- 会导致上下文交叉写入、重复 LLM 调用、工具调用顺序错乱

**涉及代码**

- `src/core/main-agent.ts`
- `src/server/ws-handler.ts`

**风险**

- 破坏 MainAgent 单线程状态机假设
- 导致 conversation 持久化内容与真实执行顺序不一致
- 可能触发重复执行、重复写 memory、重复发 agent 指令

**建议方向**

- 在 `MainAgent.handleMessage()` 入口增加互斥锁或串行消息队列
- 所有 WebSocket 用户消息进入统一 dispatcher，而不是直接 fire-and-forget 执行
- 增加并发到达消息的单测

**修复说明**

- 已在 `MainAgent` 中增加入站消息串行排队逻辑
- 执行中的消息仍然进入 `MessageQueue`，保持原有“在工具轮次之间注入人类消息”的语义
- 已补充并发消息串行处理测试

---

### 2. Memory 搜索与读取的项目边界不一致 `[已修复]`

**现象**

- `memory_search` 默认跨所有项目检索
- 搜索结果路径会包含 `{project}/{path}` 前缀
- `memory_get` 读取时会裁掉项目名前缀，然后到当前项目的 `storageDir` 下找文件

**涉及代码**

- `src/memory/search.ts`
- `src/core/main-agent.ts`

**修复说明**

- 保留“记忆可跨项目检索”的既定设计
- `memory_get` 现在会识别 `{project}/memory/...` 形式的路径，并从对应项目的存储目录读取文件
- 普通 `memory/...` 路径仍然默认读取当前项目
- 已补充跨项目路径读取测试

---

### 3. 执行期间抛异常时，状态可能永久停留在 `executing` `[已修复]`

**现象**

- `handleMessage()` 和 `handleResume()` 在进入执行态后，没有统一的 `try/finally` 兜底
- `ws-handler` 只广播错误消息，不负责修复状态机状态

**涉及代码**

- `src/core/main-agent.ts`
- `src/server/ws-handler.ts`

**风险**

- 任意未捕获异常都可能让系统卡死在 `executing`
- `/resume`、新消息处理、前端状态显示都会被污染
- 用户只能通过重启进程恢复

**建议方向**

- 在 `handleMessage()`、`handleResume()` 外围加统一 error boundary
- 在 `finally` 中确保状态回到 `idle`
- 对失败场景补充 system 广播和日志
- 增加“工具执行异常后状态恢复”的测试

**修复说明**

- 已为 `handleMessage()` 和 `handleResume()` 增加统一异常恢复逻辑
- 当异常发生在执行态时，会强制将状态恢复为 `idle`
- 已补充执行态异常恢复测试

---

## P2 问题

### 4. `/clear` 不是强一致清理，存在执行竞态 `[已修复]`

**现象**

- `/clear` 在执行中只发出 stop 请求并等待固定 200ms
- 当前工具轮未必已经结束
- 清空后，旧执行流仍可能继续写入 conversation

**涉及代码**

- `src/server/command-router.ts`
- `src/core/main-agent.ts`

**风险**

- 前端看到“对话已清空”，但旧任务结果可能再次出现
- 持久化消息与用户认知不一致
- memory flush 和压缩逻辑可能基于已经“清空”的旧内容继续运行

**建议方向**

- 将 `/clear` 改为三阶段：请求停止、等待执行环确认退出、再清理上下文
- 给长耗时工具增加可中断能力
- 增加 `/clear` 与长工具并发时的集成测试

**修复说明**

- `/clear` 已改为三阶段：请求停止、等待 `MainAgent` 确认回到 `idle`、再执行清理
- 移除了固定 200ms 等待的脆弱做法
- 已补充命令路由测试，验证执行中清理会先等待执行环退出

---

### 5. Memory 写入后索引不会及时同步 `[已修复]`

**现象**

- `memory_write` 和 memory flush 写入 markdown 后，只会 `markDirty()`
- 索引同步目前只在启动阶段执行
- 新写入的记忆在当前进程中可能无法被 `memory_search` 命中

**涉及代码**

- `src/memory/store.ts`
- `src/memory/sync.ts`
- `src/main.ts`
- `src/core/main-agent.ts`

**风险**

- “刚写入就搜不到”，记忆系统行为不符合直觉
- memory flush 的收益延迟到重启后才生效
- 代理可能重复总结、重复写入同类记忆

**建议方向**

- 在 `memory_write` 成功后触发增量 sync
- 或在 `memory_search` 前检测 dirty 状态并按需同步
- 为 flush 写入后的可搜索性增加端到端测试

**修复说明**

- 已增加增量 memory sync runner
- 手动 `memory_write` 成功后会立即触发索引同步
- memory flush 写入完成后也会统一触发一次索引同步
- 已补充 `memory_write` 和 memory flush 的同步测试

---

### 6. 服务默认暴露面偏宽，且日志会输出完整 prompt `[部分修复]`

**现象**

- HTTP 服务启动时没有显式绑定 `127.0.0.1`
- REST API 和 WebSocket 默认无鉴权
- 首次 LLM 调用会打印完整 system prompt 和消息内容

**涉及代码**

- `src/server/index.ts`
- `src/core/main-agent.ts`

**风险**

- 服务可能对局域网暴露，而日志却暗示只在 localhost 可见
- 历史消息、执行状态、命令列表可被未授权访问
- 完整 prompt 日志可能泄露敏感上下文、密钥片段、用户数据

**建议方向**

- 默认只绑定 `127.0.0.1`，通过 CLI 显式开放 host
- 给 API / WebSocket 设计最小认证方案
- 完整 prompt 日志仅在 debug 模式下启用，并做敏感字段脱敏

**修复说明**

- 默认绑定地址已改为 `127.0.0.1`
- 新增 `--host` 参数，允许显式开放到其他网卡地址
- `/api/*` 和 `/ws` 已增加基于 HttpOnly cookie 的最小认证
- 已补充 server 测试，验证未授权 API/WS 访问会被拒绝
- 但“首次 LLM 调用打印完整 prompt”这一项尚未收紧，仍需后续处理

---

## P3 问题

### 7. Memory 路径能力定义存在不一致

**现象**

- 分类模块仍定义了 `legacy` 类型，支持 `MEMORY.md` / `memory.md` 的分类识别
- 但 `isMemoryPath()` 实际只允许 `memory/*.md`
- 测试和错误文案中还残留“允许根目录 legacy memory 文件”的旧认知

**涉及代码**

- `src/memory/category.ts`
- `src/memory/store.ts`
- `test/core/memory-tools.test.ts`
- `test/memory/store.test.ts`

**风险**

- 设计文档、实现和测试语义不一致
- 后续维护者无法快速判断 legacy memory 是否仍被正式支持
- 容易在改动 memory_write、安全校验或迁移逻辑时引入回归

**建议方向**

- 明确是否继续支持 legacy memory 文件
- 若不支持，移除相关分类或将其限定为“只读兼容”
- 统一更新错误文案、测试描述和文档

---

## 推荐修复顺序

1. 先修 `MainAgent` 串行化和异常兜底，恢复状态机可靠性
2. 再修 memory 的项目隔离和写后同步，恢复记忆链路正确性
3. 然后修 `/clear` 的一致性问题，避免执行与清理互相污染
4. 最后收紧网络暴露面、日志行为和 legacy memory 语义

## 后续落地建议

- 每个问题单独拆成一张实现任务卡
- 每次修复至少补一组回归测试
- 修复过程中同步更新 `docs/` 中相关设计文档，避免实现和文档再次分叉
