## Context

CLIPilot currently uses a 4-phase execution model: Bootstrap → Planner → Scheduler → Summary. The Planner pre-decomposes a goal into a TaskGraph, and the Scheduler iterates through tasks, delegating each to MainAgent's `executeTask()` method. Each task runs an independent tool-use loop (max 15 iterations) with signal-driven tmux monitoring.

In practice, pre-planning is unreliable (limited project context at planning time), and the `request_replan` recovery mechanism adds complexity. Meanwhile, MainAgent already has the tools and intelligence to autonomously drive goal completion — it just needs to run as a continuous loop rather than being fed pre-planned tasks.

**Current components involved:**
- `Planner` — single LLM call to produce TaskGraph (to be removed)
- `TaskGraph` / `Task` — dependency-tracked task data structure (to be removed)
- `Scheduler` — iterates ready tasks, delegates to MainAgent, forwards events (to be removed)
- `SignalRouter` — routes StateDetector signals to MainAgent (to absorb Scheduler's event/control roles)
- `MainAgent` — tool-use decision loop, 13 built-in tools (to be refactored)
- `ContextManager` — manages system prompt modules including `task_graph_summary` (to be simplified)

## Goals / Non-Goals

**Goals:**
- MainAgent runs a single continuous loop driven by a goal string, with no pre-planned task decomposition
- The loop has no artificial iteration cap — it exits only when MainAgent calls a terminal tool (`mark_complete`, `mark_failed`, `escalate_to_human`)
- SignalRouter absorbs Scheduler's event forwarding and control surface (pause/resume/abort)
- `main.ts` simplifies to 3 phases: Bootstrap → Execution → Summary
- TUI displays log-based timeline instead of task-list progress
- Context management (Memory Flush + Compression) handles long-running sessions naturally

**Non-Goals:**
- Parallel task execution (not needed without TaskGraph)
- Automatic timeout (MainAgent decides when to give up, or user can abort)
- TUI deep interaction redesign (log timeline is sufficient for now)
- Dual-model configuration (separate change)

## Decisions

### 1. MainAgent: `executeGoal(goal)` replaces `executeTask(task)`

**Choice:** Single method `executeGoal(goal: string): Promise<GoalResult>` that runs an unbounded tool-use + signal loop.

**Rationale:** The current `executeTask` already contains the full decision engine. The only reason it's task-scoped is because Scheduler feeds it tasks. Without Scheduler, the natural boundary becomes the entire goal.

**Alternative considered:** Keep `executeTask` but have MainAgent internally create its own tasks. Rejected because it reintroduces TaskGraph complexity without benefit — the LLM can track progress via memory and conversation context.

**Loop structure:**
```
executeGoal(goal):
  inject goal into ContextManager
  while true:
    check memory flush / compression thresholds
    call LLM with tools
    if terminal tool → return GoalResult
    execute non-terminal tools
    if paneTarget exists and no more tool calls:
      await SignalRouter signals
      inject signal into conversation
      continue loop
```

### 2. Remove 15-iteration cap

**Choice:** No iteration limit. Loop exits only via terminal tools.

**Rationale:** With memory flush at 60% and compression at 70%, context overflow is already handled. The 15-iteration cap was a safety net for per-task scope; with goal-level scope, artificial limits would prematurely terminate complex goals.

**Safety:** The existing `escalate_to_human` tool and user-initiated abort (via TUI/SignalRouter) provide escape hatches.

### 3. SignalRouter absorbs Scheduler's responsibilities

**Choice:** Extend SignalRouter with `pause()`, `resume()`, `abort()` control methods and event emission (`goal_complete`, `goal_failed`, `log`).

**Rationale:** SignalRouter already manages the monitoring loop and signal dispatch. Scheduler's remaining logic after removing TaskGraph iteration is just event forwarding and start/stop control — a natural fit for SignalRouter.

**Alternative considered:** Keep Scheduler as a thin wrapper. Rejected because it would be a pass-through class with no logic, adding indirection.

### 4. Signal handling: completed signals re-enter tool-use loop

**Choice:** When SignalRouter detects agent completion (NOTIFY with status=completed), instead of auto-resolving the goal, inject the signal into conversation and let the LLM decide whether the *goal* is done.

**Rationale:** In the old model, task completion = auto-resolve because each task was small. In the new model, agent completing one command doesn't mean the goal is done. The LLM must evaluate: "Agent finished X. Is the overall goal achieved, or should I send another command?"

**Fast-path change:** The existing fast-path auto-completion in SignalRouter should emit a DECISION_NEEDED instead of NOTIFY for completion signals, since goal-level completion requires LLM judgment.

### 5. ContextManager: drop `task_graph_summary` module

**Choice:** Remove the `task_graph_summary` module. Keep `goal`, `compressed_history`, `memory`, `agent_capabilities`.

**Rationale:** No TaskGraph means no summary to inject. The goal string in the `goal` module is sufficient context for the LLM to stay focused.

### 6. GoalResult replaces TaskResult

**Choice:** New `GoalResult` type identical to `TaskResult` in shape but with goal-level semantics:
```typescript
interface GoalResult {
  success: boolean;
  summary: string;
  filesChanged?: string[];
  errors?: string[];
}
```

**Rationale:** The data shape is the same; the semantic change is that `success` means "the entire goal was accomplished" rather than "one sub-task succeeded."

### 7. MainAgent events change from task-level to goal-level

**Choice:** Replace `MainAgentEvents` with:
```typescript
interface MainAgentEvents {
  goal_start: [goal: string];
  goal_complete: [result: GoalResult];
  goal_failed: [error: string];
  need_human: [reason: string];
  log: [message: string];
}
```

**Rationale:** Without tasks, events must reflect goal-level lifecycle. TUI and main.ts consume these for display and session summary.

### 8. TUI: log timeline instead of task list

**Choice:** TUI subscribes to `log` events and displays a chronological timeline. Remove task list panel and progress bar.

**Rationale:** Without TaskGraph, there's no structured progress to display. Log events from MainAgent (tool calls, agent responses, completions) provide sufficient visibility. This is explicitly a minimal change — deeper TUI improvements are deferred.

## Risks / Trade-offs

**[Long-running context consumption]** → Mitigated by existing Memory Flush (60%) + Compression (70%) + memory tools. MainAgent can always `memory_search` to recall earlier work.

**[No progress visibility]** → Mitigated by log timeline in TUI. For structured progress, MainAgent can use `memory_write` to track milestones — this is a pattern that can be encouraged via prompt engineering.

**[Runaway loop without exit]** → Mitigated by user abort via TUI, `escalate_to_human` tool, and optional configurable timeout (can be added later).

**[Loss of parallelism potential]** → Accepted. Current Scheduler already runs tasks sequentially (`maxParallel: 1`). No real capability lost.

**[Test coverage gap]** → Integration test must be rewritten. Risk of regressions in signal handling during refactor. Mitigation: rewrite tests before refactoring production code (TDD approach for the new loop).
