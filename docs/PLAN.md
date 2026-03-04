# CLIPilot 实施计划

## 项目定义

CLIPilot 是一个基于 tmux 的 TUI 元调度器，它不直接写代码，而是通过 tmux 指挥 Claude Code、Codex、Pi 等专业编码 Agent 完成复杂的开发任务。通过分层状态检测和 LLM 推理实现长时间无人值守的自主开发。

## 技术栈

- **语言**: TypeScript (Node.js >= 20)
- **TUI**: 参考 pi-tui 的差分渲染架构自建
- **tmux 交互**: child_process 调用 tmux CLI
- **LLM 调用**: 参考 pi-ai 的接口设计，初期直接用 Anthropic SDK
- **构建**: tsc + npm
- **格式化**: Biome
- **测试**: Vitest

## 项目结构

```
clipilot/
├── package.json
├── tsconfig.json
├── biome.json
├── src/
│   ├── main.ts                    # 入口
│   ├── cli.ts                     # CLI 参数解析
│   │
│   ├── core/
│   │   ├── planner.ts             # LLM 驱动的任务规划器
│   │   ├── scheduler.ts           # 任务调度器（串行/并行）
│   │   ├── task.ts                # 任务数据结构和生命周期
│   │   └── session.ts             # CLIPilot 会话管理
│   │
│   ├── tmux/
│   │   ├── bridge.ts              # tmux 命令封装层
│   │   ├── state-detector.ts      # 分层状态检测
│   │   └── types.ts               # tmux 相关类型
│   │
│   ├── agents/
│   │   ├── adapter.ts             # Agent 适配器接口
│   │   ├── claude-code.ts         # Claude Code 适配器
│   │   ├── codex.ts               # Codex 适配器
│   │   └── pi.ts                  # Pi 适配器
│   │
│   ├── llm/
│   │   ├── client.ts              # LLM 调用客户端
│   │   ├── prompts.ts             # 系统提示和模板
│   │   └── types.ts               # LLM 相关类型
│   │
│   ├── tui/
│   │   ├── app.ts                 # 主 TUI 应用
│   │   ├── dashboard.ts           # Dashboard 主面板
│   │   ├── task-list.ts           # 任务列表组件
│   │   ├── log-stream.ts          # 日志/事件流组件
│   │   ├── agent-preview.ts       # Agent pane 内容预览
│   │   └── components/
│   │       ├── renderer.ts        # 差分渲染引擎（参考 pi-tui）
│   │       ├── text.ts            # 文本组件
│   │       ├── box.ts             # 框/容器组件
│   │       ├── progress.ts        # 进度条组件
│   │       └── input.ts           # 输入组件
│   │
│   └── utils/
│       ├── logger.ts              # 日志工具
│       └── config.ts              # 配置管理
│
├── test/
│   ├── tmux/
│   │   ├── bridge.test.ts
│   │   └── state-detector.test.ts
│   ├── core/
│   │   ├── planner.test.ts
│   │   └── scheduler.test.ts
│   └── agents/
│       └── adapter.test.ts
│
└── docs/
    └── (暂不创建)
```

---

## 阶段划分

### Phase 1: 基础设施 (Steps 1-4)
建立项目骨架、tmux 桥接、基础 TUI 渲染

### Phase 2: 核心引擎 (Steps 5-8)
LLM 客户端、状态检测、任务规划、调度器

### Phase 3: Agent 集成 (Steps 9-11)
Agent 适配器、Claude Code 集成、端到端流程

### Phase 4: TUI 完善 (Steps 12-14)
Dashboard、交互控制、用户体验

---

## 详细实施步骤

### Step 1: 项目初始化

**目标**: 建立可编译运行的项目骨架

**具体任务**:
1. 初始化 npm 项目，配置 package.json
   - name: "clipilot"
   - type: "module"
   - bin: { "clipilot": "./dist/main.js" }
   - scripts: build, dev, test, check
2. 配置 tsconfig.json
   - target: ES2022, module: Node16
   - strict: true, sourceMap: true
   - outDir: dist, rootDir: src
3. 配置 biome.json（参考 pi-mono 的配置）
4. 安装核心依赖:
   - typescript, @anthropic-ai/sdk, chalk
   - vitest (dev)
   - @biomejs/biome (dev)
5. 创建 src/main.ts 入口，能成功编译和运行
6. 创建 src/cli.ts，使用 Node.js 内置 parseArgs 解析参数:
   - `clipilot "目标描述"` — 启动任务
   - `clipilot` — 交互式输入
   - `--agent <name>` — 指定 Agent (claude-code/codex/pi)
   - `--autonomy <level>` — 自主度 (low/medium/high/full)
   - `--model <id>` — 指定 LLM 模型
   - `--dry-run` — 只规划不执行

**验收标准**: `npm run build && node dist/main.js --help` 输出帮助信息

---

### Step 2: tmux Bridge 核心

**目标**: 封装 tmux CLI 操作，提供可靠的 TypeScript API

**具体任务**:
1. 创建 `src/tmux/types.ts`:
   ```typescript
   interface TmuxSession {
     name: string;
     windows: TmuxWindow[];
     created: number;
   }
   interface TmuxWindow {
     index: number;
     name: string;
     panes: TmuxPane[];
   }
   interface TmuxPane {
     id: string;       // %0, %1, ...
     index: number;
     width: number;
     height: number;
     active: boolean;
     pid: number;
   }
   interface CaptureResult {
     content: string;
     lines: string[];
     timestamp: number;
   }
   ```

2. 创建 `src/tmux/bridge.ts`:
   - `checkTmuxInstalled()`: 检查 tmux 是否可用
   - `createSession(name, opts?)`: 创建新 session（detached）
   - `killSession(name)`: 销毁 session
   - `listSessions()`: 列出所有 session
   - `createWindow(session, name)`: 创建新窗口
   - `createPane(target, direction?)`: 分割面板
   - `sendKeys(target, keys, opts?)`: 发送按键序列
     - 支持特殊键：Enter, Escape, C-c, C-d 等
     - 支持延迟发送（避免输入过快）
   - `capturePane(target, opts?)`: 捕获面板内容
     - 可指定行数范围 (-S/-E 参数)
     - 支持 -p (stdout) 和 -e (包含转义序列)
   - `getPaneInfo(target)`: 获取面板信息（尺寸、pid 等）
   - `selectPane(target)`: 切换焦点面板
   - `runInPane(target, command)`: 在面板中执行命令

   内部使用 `child_process.execFile('tmux', args)` 封装。
   所有命令返回 Promise，错误时抛出 TmuxError。

3. 编写 `test/tmux/bridge.test.ts`:
   - 测试 session 创建/销毁
   - 测试 sendKeys 和 capturePane 来回
   - 测试多窗口/面板管理

**验收标准**: 测试通过，能创建 tmux session、发送命令、捕获输出

**关键设计决策**:
- target 格式统一使用 `session:window.pane`（如 `clipilot:0.0`）
- 所有 tmux 命令使用 execFile 而非 exec（避免 shell 注入）
- 捕获内容自动去除尾部空行

---

### Step 3: 基础差分渲染引擎

**目标**: 建立最小化的 TUI 渲染能力，能在终端中高效显示和更新内容

**具体任务**:
1. 创建 `src/tui/components/renderer.ts`:
   - 参考 pi-tui 的 TUI 类，但大幅简化
   - Component 接口: `{ render(width: number): string[], invalidate(): void }`
   - 差分渲染: 对比新旧行数组，只重写变化的行
   - 使用同步输出 (CSI 2026h/l) 避免闪烁
   - 支持终端 resize 事件
   - 支持 stdin 输入处理

2. 创建基础组件:
   - `src/tui/components/text.ts`: 多行文本（支持 chalk 样式）
   - `src/tui/components/box.ts`: 带边框的容器
   - `src/tui/components/progress.ts`: 进度条 `[████░░░░] 50%`

3. 创建 `src/tui/app.ts`:
   - 初始化终端（raw mode、备用屏幕）
   - 启动渲染循环
   - 处理 stdin 输入分发
   - 处理退出信号（SIGINT, SIGTERM）

**验收标准**: 能在终端中显示一个带边框的文本框，内容每秒更新，无闪烁

**关键设计决策**:
- 不做覆盖层系统（MVP 不需要）
- 不做焦点管理（MVP 不需要）
- 渲染宽度取 `process.stdout.columns`
- 行号从 0 开始，逐行对比 old vs new

---

### Step 4: 配置和日志系统

**目标**: 建立配置加载和日志记录能力

**具体任务**:
1. 创建 `src/utils/config.ts`:
   - 配置文件路径: `~/.clipilot/config.json`
   - 配置项:
     ```typescript
     interface CLIPilotConfig {
       defaultAgent: string;        // "claude-code"
       autonomyLevel: string;       // "medium"
       llm: {
         provider: string;          // "anthropic"
         model: string;             // "claude-sonnet-4-5-20250929"
         apiKey?: string;           // 优先使用环境变量
       };
       stateDetector: {
         pollIntervalMs: number;    // 2000
         stableThresholdMs: number; // 10000
         captureLines: number;      // 50
       };
       tmux: {
         sessionPrefix: string;     // "clipilot"
       };
     }
     ```
   - `loadConfig()`: 加载配置（合并默认值）
   - `saveConfig(config)`: 保存配置

2. 创建 `src/utils/logger.ts`:
   - 日志写入文件: `~/.clipilot/logs/YYYY-MM-DD.log`
   - 日志级别: debug, info, warn, error
   - 同时写入 TUI 的日志流组件（通过事件）
   - 格式: `[HH:MM:SS] [LEVEL] [MODULE] message`

**验收标准**: 配置文件能正确读写，日志写入文件

---

### Step 5: LLM 客户端

**目标**: 建立 CLIPilot 自身的 LLM 调用能力（用于规划和判断，非编码）

**具体任务**:
1. 创建 `src/llm/types.ts`:
   ```typescript
   interface LLMMessage {
     role: "system" | "user" | "assistant";
     content: string;
   }
   interface LLMResponse {
     content: string;
     usage: { input: number; output: number };
   }
   interface LLMStreamEvent {
     type: "text_delta" | "done";
     delta?: string;
     response?: LLMResponse;
   }
   ```

2. 创建 `src/llm/client.ts`:
   - 使用 @anthropic-ai/sdk
   - `complete(messages, opts?)`: 完整调用
   - `stream(messages, opts?)`: 流式调用，返回 AsyncIterable
   - `completeJson<T>(messages, schema?, opts?)`: 返回结构化 JSON
   - 错误处理: 自动重试（429, 500），指数退避
   - 支持 AbortSignal

3. 创建 `src/llm/prompts.ts`:
   - `PLANNER_SYSTEM_PROMPT`: 规划器系统提示
     - 角色：你是一个开发任务规划器
     - 能力：分解目标为可执行的子任务
     - 输出格式：JSON 数组，每项包含 id, title, description, dependencies, estimatedComplexity
   - `STATE_ANALYZER_PROMPT`: 状态分析器提示
     - 角色：你是一个终端状态分析器
     - 输入：tmux pane 的屏幕截取
     - 输出：JSON { status, detail, suggestedAction }
     - status 枚举: "executing", "waiting_input", "completed", "error", "idle"
   - `ERROR_ANALYZER_PROMPT`: 错误分析器提示
     - 角色：你是一个错误分析专家
     - 输入：错误屏幕内容 + 任务上下文
     - 输出：JSON { errorType, rootCause, suggestedFix, shouldRetry }

**验收标准**: 能调用 Anthropic API 获取响应，能解析 JSON 响应

---

### Step 6: 分层状态检测器

**目标**: 实现通过 tmux capture-pane 的分层状态检测机制

**具体任务**:
1. 创建 `src/tmux/state-detector.ts`:

   **Layer 1 — 快速变化检测（轮询）**:
   ```typescript
   class StateDetector {
     // 配置
     pollIntervalMs: number;       // 默认 2000ms
     stableThresholdMs: number;    // 默认 10000ms (不变化超时)
     captureLines: number;         // 默认 50 行

     // 核心方法
     startMonitoring(paneTarget: string): void;
     stopMonitoring(): void;

     // 事件
     onStateChange(callback: (state: PaneState) => void): void;
   }
   ```

   实现逻辑:
   - 每 pollIntervalMs 调用 `bridge.capturePane(target, { lines: captureLines })`
   - 计算内容 hash（使用 Node.js crypto.createHash('md5')）
   - 如果 hash 变化 → 状态 "active"，重置稳定计时器
   - 如果 hash 不变且超过 stableThresholdMs → 触发 Layer 2

   **Layer 2 — LLM 语义分析（按需）**:
   ```typescript
   async analyzeState(paneContent: string, taskContext: string): Promise<PaneAnalysis>
   ```

   - 将 pane 内容 + 任务上下文发送给 LLM (使用 Haiku/Flash 等快速模型)
   - LLM 返回结构化判断:
     ```typescript
     interface PaneAnalysis {
       status: "executing" | "waiting_input" | "completed" | "error" | "idle";
       confidence: number;        // 0-1
       detail: string;            // 人可读描述
       suggestedAction?: {
         type: "send_keys" | "retry" | "skip" | "escalate";
         value?: string;          // 如果是 send_keys，发送什么
       };
     }
     ```

   **Layer 3 — 深度分析（复杂异常）**:
   ```typescript
   async deepAnalyze(
     paneContent: string,
     taskContext: string,
     fileChanges?: string,      // git diff 输出
     errorHistory?: string[]    // 之前的错误
   ): Promise<DeepAnalysis>
   ```

   - 使用更强的模型（Opus/Sonnet）
   - 综合多种信息源
   - 返回更详细的决策:
     ```typescript
     interface DeepAnalysis extends PaneAnalysis {
       shouldReplan: boolean;
       alternativeApproach?: string;
       humanInterventionNeeded: boolean;
       reason: string;
     }
     ```

2. 编写 `test/tmux/state-detector.test.ts`:
   - 模拟 pane 内容变化序列
   - 测试 Layer 1 → Layer 2 触发逻辑
   - 测试各种状态判断场景

**验收标准**: 状态检测器能正确检测 pane 内容变化，Layer 2 能正确分析状态

**关键设计决策**:
- Layer 1 只做简单 hash 对比，不调用 LLM（节省成本和延迟）
- Layer 2 使用快速便宜的模型（如 haiku）
- Layer 3 才使用强模型，且仅在多次 Layer 2 判断不确定时触发
- 所有层的判断结果都记录日志，便于调试

---

### Step 7: 任务数据结构和规划器

**目标**: 实现任务分解和管理

**具体任务**:
1. 创建 `src/core/task.ts`:
   ```typescript
   type TaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";

   interface Task {
     id: string;
     title: string;
     description: string;
     status: TaskStatus;
     dependencies: string[];      // 依赖的任务 ID
     agentType?: string;          // 使用哪个 Agent
     prompt?: string;             // 发送给 Agent 的 prompt
     result?: TaskResult;
     attempts: number;
     maxAttempts: number;         // 默认 3
     createdAt: number;
     startedAt?: number;
     completedAt?: number;
   }

   interface TaskResult {
     success: boolean;
     summary: string;
     filesChanged?: string[];
     errors?: string[];
   }

   class TaskGraph {
     addTask(task): void;
     getTask(id): Task | undefined;
     updateStatus(id, status, result?): void;
     getReadyTasks(): Task[];       // 所有依赖已完成的 pending 任务
     getAllTasks(): Task[];
     isComplete(): boolean;         // 所有任务是否都结束了
     getProgress(): { total, completed, failed, running, pending };
   }
   ```

2. 创建 `src/core/planner.ts`:
   ```typescript
   class Planner {
     constructor(llmClient: LLMClient);

     // 将用户目标分解为任务图
     async plan(
       goal: string,
       context?: {
         projectInfo?: string;      // 项目描述（README等）
         fileTree?: string;         // 文件树
         recentGitLog?: string;     // 最近 git 历史
       }
     ): Promise<TaskGraph>;

     // 根据执行结果调整计划
     async replan(
       originalGoal: string,
       currentTasks: TaskGraph,
       failedTask: Task,
       errorAnalysis: DeepAnalysis
     ): Promise<TaskGraph>;

     // 为单个任务生成 Agent prompt
     async generatePrompt(
       task: Task,
       completedTasks: Task[]   // 已完成的前置任务
     ): Promise<string>;
   }
   ```

   规划器的 LLM 调用使用 `completeJson` 获取结构化输出。

3. 编写 `test/core/planner.test.ts`:
   - 使用模拟 LLM 响应测试计划分解
   - 测试依赖关系正确性

**验收标准**: 给定一个目标字符串，能输出合理的任务图

---

### Step 8: 任务调度器

**目标**: 实现任务的串行/并行调度执行

**具体任务**:
1. 创建 `src/core/scheduler.ts`:
   ```typescript
   interface SchedulerOptions {
     maxParallel: number;           // 最大并行数，默认 1（MVP）
     autonomyLevel: "low" | "medium" | "high" | "full";
   }

   class Scheduler extends EventEmitter {
     constructor(
       taskGraph: TaskGraph,
       tmuxBridge: TmuxBridge,
       stateDetector: StateDetector,
       planner: Planner,
       agents: Map<string, AgentAdapter>,
       options: SchedulerOptions
     );

     // 开始执行
     async start(): Promise<void>;

     // 暂停/继续
     pause(): void;
     resume(): void;

     // 中止所有
     abort(): void;

     // 用户修正指令
     steer(instruction: string): void;

     // 事件
     on("task_start", (task: Task) => void);
     on("task_complete", (task: Task, result: TaskResult) => void);
     on("task_failed", (task: Task, error: string) => void);
     on("state_update", (paneState: PaneAnalysis) => void);
     on("need_human", (task: Task, reason: string) => void);
     on("all_complete", (results: TaskResult[]) => void);
     on("log", (entry: LogEntry) => void);
   }
   ```

   **执行循环**:
   ```
   while (!taskGraph.isComplete() && !aborted) {
     1. 获取就绪任务 readyTasks = taskGraph.getReadyTasks()
     2. 如果没有就绪任务且有 running 任务 → 等待
     3. 如果没有就绪任务且没有 running → 检查是否死锁
     4. 取一个就绪任务（按优先级）
     5. 选择 Agent 适配器
     6. 在 tmux pane 中启动 Agent
     7. 发送任务 prompt
     8. 启动状态监控
     9. 等待状态检测结果:
        - "completed" → 标记完成，继续下一个
        - "error" → 分析错误，决定重试/跳过/重规划
        - "waiting_input" → 根据自主度决定自动回应或请求人工
        - "executing" → 继续等待
   }
   ```

2. 创建 `src/core/session.ts`:
   ```typescript
   class Session {
     id: string;
     goal: string;
     taskGraph: TaskGraph;
     logs: LogEntry[];
     startedAt: number;
     status: "planning" | "executing" | "paused" | "completed" | "failed";

     // 持久化
     async save(path: string): Promise<void>;
     static async load(path: string): Promise<Session>;
   }
   ```

**验收标准**: 调度器能串行执行一个任务图，正确处理状态转换

---

### Step 9: Agent 适配器接口

**目标**: 定义统一的 Agent 控制接口

**具体任务**:
1. 创建 `src/agents/adapter.ts`:
   ```typescript
   interface AgentAdapter {
     name: string;                    // "claude-code", "codex", "pi"

     // 启动 Agent（返回 tmux pane target）
     launch(tmuxBridge: TmuxBridge, opts: LaunchOptions): Promise<string>;

     // 发送任务 prompt
     sendPrompt(paneTarget: string, prompt: string): Promise<void>;

     // 发送确认/回应（处理 Agent 的等待输入）
     sendResponse(paneTarget: string, response: string): Promise<void>;

     // 中止当前操作
     abort(paneTarget: string): Promise<void>;

     // 获取 Agent 特征（帮助状态检测）
     getCharacteristics(): AgentCharacteristics;
   }

   interface LaunchOptions {
     workingDir: string;
     sessionName: string;
     windowName?: string;
     env?: Record<string, string>;
   }

   interface AgentCharacteristics {
     // Agent 等待输入时的典型模式（用于 Layer 1 快速检测）
     waitingPatterns: RegExp[];     // 例如 [/^> $/, /\$ $/]
     // Agent 完成时的典型模式
     completionPatterns: RegExp[];  // 例如 [/✓.*completed/]
     // Agent 报错时的典型模式
     errorPatterns: RegExp[];       // 例如 [/Error:/, /✗/]
     // Agent 执行中的典型模式（动画、进度条等）
     activePatterns: RegExp[];      // 例如 [/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/]
     // 发送确认的按键
     confirmKey: string;            // "Enter" 或 "y\nEnter"
     // 发送中止的按键
     abortKey: string;              // "C-c" 或 "Escape"
   }
   ```

**验收标准**: 接口定义清晰，TypeScript 编译通过

---

### Step 10: Claude Code 适配器

**目标**: 实现 Claude Code 的 tmux 控制适配器

**具体任务**:
1. 创建 `src/agents/claude-code.ts`:
   ```typescript
   class ClaudeCodeAdapter implements AgentAdapter {
     name = "claude-code";

     async launch(bridge, opts): Promise<string> {
       // 1. 在 tmux 中创建新 pane
       // 2. 执行 `claude` 命令（或指定路径）
       //    - 可带参数: --model, --allowedTools 等
       // 3. 等待 Claude Code 启动完成（检测特征模式）
       // 4. 返回 pane target
     }

     async sendPrompt(paneTarget, prompt): Promise<void> {
       // 1. 将 prompt 分段发送（避免过长被截断）
       // 2. 使用 tmux send-keys 发送文本
       // 3. 发送 Enter 键提交
       // 长文本策略:
       //   - 短于 200 字符: 直接 send-keys
       //   - 长于 200 字符: 写入临时文件，用 tmux load-buffer + paste-buffer
     }

     async sendResponse(paneTarget, response): Promise<void> {
       // 处理 Claude Code 的各种等待场景:
       // - "Allow?" 提示 → 发送 'y' + Enter
       // - 等待用户输入 → 发送 response + Enter
       // - 文件编辑确认 → 发送确认键
     }

     async abort(paneTarget): Promise<void> {
       // 发送 Escape 或 Ctrl+C
     }

     getCharacteristics(): AgentCharacteristics {
       return {
         waitingPatterns: [
           /^> /,                   // 主输入提示
           /\(y\/n\)/,              // 确认提示
           /Allow/,                 // 权限提示
         ],
         completionPatterns: [
           /^> $/,                  // 回到空白输入提示
         ],
         errorPatterns: [
           /Error:/,
           /Failed/,
           /Connection refused/,
         ],
         activePatterns: [
           /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,   // spinner
           /\.\.\./,               // thinking dots
         ],
         confirmKey: "y Enter",
         abortKey: "Escape",
       };
     }
   }
   ```

2. 编写测试（需要 Claude Code 安装在系统上，可以用条件跳过）

**验收标准**: 能在 tmux 中启动 Claude Code，发送 prompt，检测完成状态

**关键注意事项**:
- Claude Code 的输入可能有字符限制，超长 prompt 需要用 paste-buffer 方式
- Claude Code 可能需要确认工具使用权限，需要自动处理
- Claude Code 的 spinner 动画会使 Layer 1 判断为 "active"（正确行为）

---

### Step 11: 端到端流程整合

**目标**: 将所有组件串联，实现完整的"目标 → 规划 → 执行 → 完成"流程

**具体任务**:
1. 完善 `src/main.ts`:
   ```typescript
   async function main() {
     // 1. 解析 CLI 参数
     const args = parseCliArgs();

     // 2. 加载配置
     const config = await loadConfig();

     // 3. 检查前置条件（tmux 安装、Agent 可用）
     await checkPrerequisites();

     // 4. 初始化组件
     const bridge = new TmuxBridge();
     const llm = new LLMClient(config.llm);
     const planner = new Planner(llm);
     const detector = new StateDetector(bridge, llm, config.stateDetector);
     const agents = new Map([
       ["claude-code", new ClaudeCodeAdapter()],
     ]);

     // 5. 获取目标
     const goal = args.goal || await promptForGoal();

     // 6. 收集项目上下文
     const context = await gatherProjectContext(args.cwd);

     // 7. 规划
     const taskGraph = await planner.plan(goal, context);

     // 8. 创建调度器
     const scheduler = new Scheduler(
       taskGraph, bridge, detector, planner, agents,
       { autonomyLevel: args.autonomy, maxParallel: 1 }
     );

     // 9. 启动 TUI（如果不是 dry-run）
     if (!args.dryRun) {
       const tui = new AppTUI(scheduler);
       tui.start();
       await scheduler.start();
     } else {
       // dry-run: 只输出计划
       printPlan(taskGraph);
     }
   }
   ```

2. 实现 `gatherProjectContext()`:
   - 读取 README.md（如果存在）
   - 执行 `find . -type f -name '*.ts' -o -name '*.js' | head -50` 获取文件树
   - 执行 `git log --oneline -10` 获取最近历史

3. 实现完整的执行循环测试:
   - 创建一个简单的测试项目
   - 给定目标："在 test-project 中创建一个 hello.ts 文件，内容是打印 Hello World"
   - 验证 CLIPilot 能规划、启动 Claude Code、发送 prompt、检测完成

**验收标准**: 能完成一个简单的端到端任务

---

### Step 12: Dashboard TUI

**目标**: 实现 CLIPilot 的主界面

**具体任务**:
1. 创建 `src/tui/dashboard.ts`:
   - 布局（自上而下）:
     ```
     ┌─ Header ──────────────────────────────────┐
     │ CLIPilot | 目标: "加上JWT认证" | ⏱ 00:05:23 │
     ├─ Tasks ───────────────────────────────────┤
     │ ✓ 1. 安装 jsonwebtoken 依赖              │
     │ ▶ 2. 创建 auth middleware     [Claude Code]│
     │ ○ 3. 添加登录路由                         │
     │ ○ 4. 添加路由保护                         │
     ├─ Agent Preview ──────────────────────────┤
     │ (当前 Agent pane 的最后 10 行内容)          │
     │ > Creating auth/middleware.ts...           │
     │ > Writing JWT verification logic...        │
     ├─ Log ────────────────────────────────────┤
     │ [14:02] 规划完成: 4个子任务                │
     │ [14:03] 启动 Claude Code (pane %1)        │
     │ [14:03] 发送任务: 安装 jsonwebtoken        │
     │ [14:04] ✓ 任务1完成 (38秒)                │
     │ [14:04] 发送任务: 创建 auth middleware      │
     ├─ Status Bar ─────────────────────────────┤
     │ [q]退出 [p]暂停 [s]指令 [Tab]切换Agent视图  │
     └─────────────────────────────────────────┘
     ```

2. 创建 `src/tui/task-list.ts`:
   - 显示任务列表，带状态图标 (✓ ▶ ○ ✗ ⊘)
   - 高亮当前执行的任务
   - 显示每个任务使用的 Agent

3. 创建 `src/tui/agent-preview.ts`:
   - 定期从 tmux capture-pane 获取内容
   - 显示最后 N 行（与终端高度相关）
   - 自动更新

4. 创建 `src/tui/log-stream.ts`:
   - 滚动日志显示
   - 支持不同级别的颜色区分
   - 自动滚动到最新

**验收标准**: TUI 能实时显示任务进度和 Agent 输出

---

### Step 13: 交互控制

**目标**: 实现用户在运行中的交互能力

**具体任务**:
1. 快捷键处理 (在 `src/tui/app.ts` 中):
   - `q`: 确认退出（清理 tmux session）
   - `p`: 暂停/继续调度
   - `s`: 打开指令输入（发送修正指令给调度器）
   - `Tab`: 切换到 tmux Agent 视图（attach to session）
   - `Ctrl+C`: 中止当前任务
   - `r`: 重试当前失败的任务
   - `n`: 跳过当前任务

2. 指令输入模式:
   - 按 `s` 后在底部出现输入框
   - 用户输入修正指令（如 "不要用 bcrypt，换成 argon2"）
   - 发送给调度器的 `steer()` 方法
   - 调度器根据自主度决定如何处理

3. Agent 视图切换:
   - 按 `Tab` 切换到 tmux session
   - 用户可以直接看到底层 Agent 的完整终端
   - 按 `Tab` 返回 CLIPilot 视图（或自定义快捷键）

**验收标准**: 用户能通过快捷键控制执行流程

---

### Step 14: 错误处理和恢复

**目标**: 实现完善的错误处理、重试和恢复机制

**具体任务**:
1. 在 `src/core/scheduler.ts` 中完善错误处理:
   - Agent 崩溃 → 重启 Agent pane，重试当前任务
   - 任务超时 → Layer 3 深度分析，决定策略
   - 连续失败 → 触发重规划（调用 planner.replan）
   - 无法恢复 → 标记 "need_human"，在 TUI 中提示

2. 会话恢复:
   - 调度状态持久化到 `~/.clipilot/sessions/<id>/state.json`
   - 支持 `clipilot --resume <session-id>` 恢复中断的任务
   - 恢复时检查 tmux session 是否还在，不在则重建

3. 优雅退出:
   - `Ctrl+C` → 保存状态，清理 tmux session
   - SIGTERM → 同上
   - 异常崩溃 → 下次启动时检测残留的 tmux session

**验收标准**: 程序异常退出后能恢复继续，Agent 崩溃能自动重启

---

## 依赖关系图

```
Step 1 (项目初始化)
  ├── Step 2 (tmux Bridge)
  │   └── Step 6 (状态检测器) ← Step 5 (LLM 客户端)
  │       └── Step 8 (调度器) ← Step 7 (任务规划) ← Step 5
  │           └── Step 11 (端到端整合) ← Step 9 (适配器接口) ← Step 10 (CC适配器)
  ├── Step 3 (渲染引擎)
  │   └── Step 12 (Dashboard) → Step 13 (交互控制)
  └── Step 4 (配置/日志)

Step 14 (错误处理) 依赖 Step 11
```

## 里程碑

| 里程碑 | 包含步骤 | 交付物 |
|--------|---------|--------|
| **M1: 能跑起来** | 1-4 | 项目骨架 + tmux 操作 + 基础 TUI + 配置 |
| **M2: 能思考** | 5-7 | LLM 调用 + 状态检测 + 任务规划 |
| **M3: 能干活** | 8-11 | 调度执行 + Claude Code 集成 + 端到端 |
| **M4: 好用** | 12-14 | 完整 TUI + 交互控制 + 错误恢复 |

## 风险和缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| tmux capture-pane 内容包含 ANSI 转义序列，干扰解析 | L2/L3 判断不准 | 使用 -p 参数获取纯文本，或正则清理 ANSI 码 |
| Claude Code 更新后界面模式变化 | 适配器失效 | AgentCharacteristics 使用宽松模式匹配，定期更新模式 |
| 长文本 prompt 通过 tmux send-keys 被截断 | 任务描述不完整 | 使用 tmux load-buffer + paste-buffer 发送 |
| LLM 调用成本（频繁的状态分析） | 费用高 | Layer 1 不用 LLM，Layer 2 用最便宜模型，Layer 3 按需 |
| Agent 输出速度快于轮询频率 | 错过中间状态 | 接受这个限制，关注最终状态即可 |
