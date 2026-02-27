## Why

CLIPilot's current execution flow requires a Planner to pre-decompose goals into a TaskGraph before MainAgent can act. In practice, the pre-planning is often inaccurate (insufficient context at planning time), and MainAgent's `request_replan` mechanism adds complexity without proportional value. A sufficiently capable MainAgent with memory and skill support can drive goal completion autonomously — deciding what to do next, adapting to failures, and knowing when the goal is done — without upfront task decomposition.

## What Changes

- **BREAKING**: Remove `Planner` class and `TaskGraph` data structure entirely — no more upfront task decomposition
- **BREAKING**: Remove `Scheduler` class — its task-dispatch loop is no longer needed; its tmux monitoring responsibility is already handled by `SignalRouter + StateDetector`
- **BREAKING**: Remove `request_replan` tool from MainAgent — no TaskGraph means no replan
- Refactor `MainAgent.executeTask(task)` into `MainAgent.executeGoal(goal)` — a single continuous tool-use loop that runs until a terminal tool is called
- Remove the 15-iteration cap on the tool-use loop — MainAgent runs indefinitely, exiting only via `mark_complete`, `mark_failed`, or `escalate_to_human`
- Merge Scheduler's event forwarding and control methods (pause/resume/abort) into `SignalRouter`
- Simplify `main.ts` from 4-phase flow (Bootstrap → Planning → Execution → Summary) to 3-phase (Bootstrap → Execution → Summary)
- Update TUI from task-list progress display to log-based timeline
- Remove `prompts/planner.md`
- Delete `task_graph_summary` module from ContextManager

## Capabilities

### New Capabilities
- `goal-driven-execution`: MainAgent autonomously executes a development goal in a continuous loop without pre-planned task decomposition. Includes goal injection, infinite tool-use loop, signal-driven monitoring, and terminal tool exit conditions.

### Modified Capabilities

(none — existing specs for memory, skills, context-manager remain unchanged at the requirement level)

## Impact

- **Core execution pipeline**: `main.ts`, `MainAgent`, `Scheduler`, `SignalRouter`, `ContextManager` — major refactor
- **Deleted files**: `src/core/planner.ts`, `src/core/task.ts`, `src/core/scheduler.ts`, `prompts/planner.md`
- **Test files**: `test/core/scheduler.test.ts`, `test/core/task.test.ts` deleted; `test/core/main-agent.test.ts`, `test/core/integration.test.ts` rewritten
- **TUI**: `src/tui/app.ts` updated to consume log events instead of TaskGraph
- **Session**: `src/core/session.ts` drops `taskGraph` field
- **No external API changes**: CLI interface (`clipilot <goal>`) remains the same
- **No dependency changes**: No new packages needed
