## ADDED Requirements

### Requirement: Goal-driven execution entry point
MainAgent SHALL expose `executeGoal(goal: string): Promise<GoalResult>` as the sole execution entry point. This method replaces the former `executeTask(task)` method.

#### Scenario: Basic goal execution
- **WHEN** `executeGoal("Fix the login bug")` is called
- **THEN** MainAgent injects the goal into ContextManager and enters the main tool-use loop

#### Scenario: Goal with memory context
- **WHEN** `executeGoal` is called and the MemoryStore contains relevant prior context
- **THEN** MainAgent MAY use `memory_search` to retrieve relevant context before sending instructions to the agent

### Requirement: Unbounded tool-use loop
The MainAgent tool-use loop SHALL have no artificial iteration cap. The loop SHALL exit only when a terminal tool is called (`mark_complete`, `mark_failed`, or `escalate_to_human`).

#### Scenario: Long-running goal
- **WHEN** the goal requires more than 15 LLM round-trips to complete
- **THEN** the loop continues executing without termination until a terminal tool is invoked

#### Scenario: Context threshold during loop
- **WHEN** context usage reaches the memory flush threshold (60%) during execution
- **THEN** the system performs memory flush before the next LLM call, and the loop continues

#### Scenario: Context threshold compression
- **WHEN** context usage reaches the compression threshold (70%) during execution
- **THEN** the system compresses conversation history and the loop continues with reset context

### Requirement: Terminal tools for goal-level exit
The following tools SHALL be the only way to exit the execution loop:
- `mark_complete`: goal accomplished successfully, returns `GoalResult { success: true }`
- `mark_failed`: goal cannot be accomplished, returns `GoalResult { success: false }`
- `escalate_to_human`: goal requires human intervention, returns `GoalResult { success: false }`

#### Scenario: mark_complete exits loop
- **WHEN** MainAgent calls `mark_complete` with a summary
- **THEN** the loop exits and `executeGoal` returns `GoalResult { success: true, summary }`

#### Scenario: mark_failed exits loop
- **WHEN** MainAgent calls `mark_failed` with an error description
- **THEN** the loop exits and `executeGoal` returns `GoalResult { success: false, summary, errors }`

#### Scenario: escalate_to_human exits loop
- **WHEN** MainAgent calls `escalate_to_human` with a reason
- **THEN** the loop exits, emits `need_human` event, and returns `GoalResult { success: false }`

### Requirement: request_replan tool removed
The `request_replan` tool SHALL NOT exist in the tool definitions. MainAgent adapts its approach autonomously without external replanning.

#### Scenario: Agent encounters failure mid-goal
- **WHEN** the coding agent in tmux reports an error
- **THEN** MainAgent decides how to proceed (retry, try alternative approach, or mark_failed) using its own judgment via the tool-use loop, without a replan mechanism

### Requirement: Signal-driven agent monitoring
When MainAgent has an active pane target (tmux session created via `create_session`) and the tool-use loop produces no further tool calls, MainAgent SHALL wait for signals from SignalRouter before continuing.

#### Scenario: Agent completes work in tmux
- **WHEN** StateDetector detects the agent has completed its work (status=completed)
- **THEN** SignalRouter injects a completion signal into the conversation and the tool-use loop resumes, allowing the LLM to decide whether the overall goal is done

#### Scenario: Agent needs input
- **WHEN** StateDetector detects the agent is waiting for input (status=waiting_input)
- **THEN** SignalRouter emits a DECISION_NEEDED signal, the signal is injected into conversation, and the tool-use loop resumes for the LLM to respond

#### Scenario: No pane target yet
- **WHEN** the tool-use loop produces no tool calls and no pane target exists
- **THEN** the loop continues to the next LLM call without waiting for signals

### Requirement: GoalResult type
`executeGoal` SHALL return a `GoalResult` with the following shape:
```typescript
interface GoalResult {
  success: boolean;
  summary: string;
  filesChanged?: string[];
  errors?: string[];
}
```

#### Scenario: Successful goal completion
- **WHEN** MainAgent calls `mark_complete` with summary "Implemented user auth with JWT"
- **THEN** GoalResult is `{ success: true, summary: "Implemented user auth with JWT" }`

### Requirement: Goal-level events
MainAgent SHALL emit goal-level events instead of task-level events:
- `goal_start` with the goal string
- `goal_complete` with GoalResult
- `goal_failed` with error string
- `need_human` with reason string
- `log` with message string

#### Scenario: Event lifecycle for successful goal
- **WHEN** executeGoal is called and completes successfully
- **THEN** events are emitted in order: `goal_start` → zero or more `log` → `goal_complete`

### Requirement: SignalRouter absorbs execution control
SignalRouter SHALL provide `pause()`, `resume()`, and `abort()` methods to control the execution loop. When `abort()` is called, the current tool-use loop SHALL exit at the next safe point.

#### Scenario: User pauses execution
- **WHEN** `pause()` is called on SignalRouter
- **THEN** the MainAgent loop pauses before the next LLM call and resumes when `resume()` is called

#### Scenario: User aborts execution
- **WHEN** `abort()` is called on SignalRouter
- **THEN** the MainAgent loop exits and `executeGoal` returns `GoalResult { success: false, summary: "Aborted by user" }`

### Requirement: Simplified main.ts flow
The `main.ts` entry point SHALL execute in 3 phases:
1. **Bootstrap**: Initialize MemoryStore, EmbeddingProvider, sync memory files, discover skills, create ContextManager, SignalRouter, MainAgent
2. **Execution**: Call `mainAgent.executeGoal(goal)` directly
3. **Summary**: Generate session summary and persist to memory

#### Scenario: Normal execution
- **WHEN** user runs `clipilot "Fix the login bug"`
- **THEN** the system bootstraps, calls `executeGoal("Fix the login bug")`, and summarizes the session

### Requirement: TUI log-based timeline
The TUI SHALL display a chronological log timeline from MainAgent events instead of a task list with progress bars.

#### Scenario: TUI displays execution progress
- **WHEN** MainAgent emits `log` events during execution
- **THEN** TUI displays each log entry with timestamp in a scrollable timeline view

#### Scenario: TUI displays goal completion
- **WHEN** MainAgent emits `goal_complete`
- **THEN** TUI displays a completion summary with success/failure status

### Requirement: ContextManager without task_graph_summary
ContextManager SHALL NOT include a `task_graph_summary` module. The system prompt modules SHALL be: `goal`, `compressed_history`, `memory`, `agent_capabilities`.

#### Scenario: System prompt construction
- **WHEN** ContextManager builds the system prompt for LLM
- **THEN** the prompt includes goal, compressed history, memory context, and agent capabilities — but no task graph summary
