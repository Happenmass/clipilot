## 1. Define new types and interfaces

- [x] 1.1 Create `GoalResult` type in `src/core/main-agent.ts` (replacing `TaskResult` dependency) with fields: `success`, `summary`, `filesChanged?`, `errors?`
- [x] 1.2 Replace `MainAgentEvents` with goal-level events: `goal_start`, `goal_complete`, `goal_failed`, `need_human`, `log`
- [x] 1.3 Add `pause()`, `resume()`, `abort()` methods and `aborted` state flag to `SignalRouter`

## 2. Refactor MainAgent core loop

- [x] 2.1 Rename `executeTask(task)` to `executeGoal(goal: string): Promise<GoalResult>` — inject goal string into ContextManager as `[GOAL]` message instead of `[TASK_READY]`
- [x] 2.2 Remove 15-iteration cap from `runToolUseLoop()` — change to `while (true)` loop that exits only on terminal tool
- [x] 2.3 Remove `request_replan` from `TERMINAL_TOOLS` set and `TOOL_DEFINITIONS` array
- [x] 2.4 Remove `Planner` and `TaskGraph` imports/fields from MainAgent constructor and all internal references
- [x] 2.5 Refactor signal handling: when SignalRouter emits completion signal (NOTIFY status=completed), inject into conversation and continue loop instead of auto-resolving. Let LLM decide if goal is done
- [x] 2.6 Integrate abort check: before each LLM call, check `signalRouter.isAborted()` — if true, return `GoalResult { success: false, summary: "Aborted by user" }`

## 3. Extend SignalRouter and remove Scheduler

- [x] 3.1 Remove `TaskGraph` dependency from `SignalRouter` constructor and all internal references (`setTaskGraph`, `taskGraph` field)
- [x] 3.2 Add execution control to SignalRouter: `pause()` sets paused flag, `resume()` clears it, `abort()` sets aborted flag; expose `isPaused()`, `isAborted()` getters
- [x] 3.3 Add event emission to SignalRouter: extend with EventEmitter for `goal_complete`, `goal_failed`, `need_human`, `log` events (forwarded from MainAgent)
- [x] 3.4 Delete `src/core/scheduler.ts`

## 4. Delete Planner and TaskGraph

- [x] 4.1 Delete `src/core/planner.ts`
- [x] 4.2 Delete `src/core/task.ts`
- [x] 4.3 Delete `prompts/planner.md`

## 5. Simplify ContextManager

- [x] 5.1 Remove `task_graph_summary` from ContextManager's module set — update `buildSystemPrompt()` and any references to this module
- [x] 5.2 Update `prompts/main-agent.md` — remove task-related instructions, add goal-driven autonomous decision guidelines (emphasize: you decide what to do next, use memory to track progress, call mark_complete when the overall goal is achieved)

## 6. Refactor main.ts

- [x] 6.1 Remove Planner instantiation and `planner.plan()` call (Phase 1 Planning)
- [x] 6.2 Remove Scheduler instantiation and all Scheduler event listeners
- [x] 6.3 Remove TaskGraph from SignalRouter constructor call
- [x] 6.4 Call `mainAgent.executeGoal(goal)` directly instead of `scheduler.start()`
- [x] 6.5 Update Session: remove `taskGraph` field from session object
- [x] 6.6 Update session summary phase to use `GoalResult` instead of iterating `taskGraph.getAllTasks()`

## 7. Update TUI

- [x] 7.1 Replace Scheduler dependency with SignalRouter in `src/tui/app.ts` constructor
- [x] 7.2 Remove task list panel and `refreshTaskList()` method; replace with log timeline display
- [x] 7.3 Subscribe to `log`, `goal_complete`, `goal_failed` events from SignalRouter/MainAgent
- [x] 7.4 Wire TUI input (pause/resume/abort) to SignalRouter methods instead of Scheduler

## 8. Update tests

- [x] 8.1 Delete `test/core/scheduler.test.ts`
- [x] 8.2 Delete `test/core/task.test.ts` (if exists)
- [x] 8.3 Rewrite `test/core/main-agent.test.ts` — test `executeGoal()`, unbounded loop, terminal tools, signal injection, abort behavior
- [x] 8.4 Rewrite `test/core/integration.test.ts` — test full Goal → executeGoal → GoalResult flow with mocked LLM and tmux
- [x] 8.5 Update `test/core/signal-router.test.ts` (if exists) — test new pause/resume/abort methods and removed TaskGraph dependency

## 9. Build verification and documentation

- [x] 9.1 Run `npm run build` — fix any TypeScript compilation errors from removed imports/types
- [x] 9.2 Run `npm test` — ensure all tests pass
- [x] 9.3 Run `npm run check` — ensure Biome linting passes
- [x] 9.4 Update `CLAUDE.md` — reflect new 3-phase architecture, updated MainAgent tools (remove request_replan), updated events, removed Planner/TaskGraph/Scheduler, simplified ContextManager modules
- [x] 9.5 Update `uml.md` — reflect new architecture diagrams (Goal → MainAgent → SignalRouter flow, removed Planner/Scheduler)
