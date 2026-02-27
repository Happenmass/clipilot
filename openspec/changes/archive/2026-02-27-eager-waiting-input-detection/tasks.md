## 1. Pattern 增强

- [x] 1.1 在 `src/agents/claude-code.ts` 的 `waitingPatterns` 数组中增加 `/❯\s*\d+\.\s/` 模式
- [x] 1.2 在 `src/tmux/state-detector.ts` 的 `quickPatternCheck` 中将 `slice(-5)` 改为 `slice(-8)`

## 2. waitForSettled Fast-Escape

- [x] 2.1 在 `src/tmux/state-detector.ts` 的 `waitForSettled` Phase 2 hash-change 分支中，在 error fast-escape 之后增加 `waiting_input` fast-escape

## 3. 测试

- [x] 3.1 在 `test/tmux/state-detector-wait-for-settled.test.ts` 中增加测试: 内容变化中检测到 waiting_input 时立即返回
- [x] 3.2 在 `test/tmux/state-detector-wait-for-settled.test.ts` 中增加测试: 动画与编号选项菜单同时出现时正确检测为 waiting_input
- [x] 3.3 运行全部测试确认无回归
