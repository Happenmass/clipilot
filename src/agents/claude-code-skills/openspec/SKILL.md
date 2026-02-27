---
name: openspec
description: "Spec-driven development workflow for structured changes"
type: agent-capability
commands:
  - /opsx:new
  - /opsx:ff
  - /opsx:apply
  - /opsx:verify
  - /opsx:explore
  - /opsx:archive
when:
  files: [".openspec.yaml"]
---

# OpenSpec Skill

OpenSpec provides a spec-driven development workflow. Use it for complex or architectural changes that benefit from upfront planning.

## When to Use

- Complex features requiring multiple files/modules
- Architectural changes with design decisions
- Changes that benefit from specs and task tracking

## Commands

### /opsx:new
Create a new change with scaffolded artifacts directory.

### /opsx:ff
Fast-forward: create a change and generate all artifacts (proposal, design, specs, tasks) in one step. Best for well-understood changes.

### /opsx:apply
Implement tasks from an existing change. Reads context files and works through the task list.

### /opsx:verify
Verify that implementation matches the change's specs and design.

### /opsx:explore
Enter explore mode — think through ideas, investigate problems, clarify requirements before committing to a design.

### /opsx:archive
Archive a completed change, syncing delta specs to main specs.

## Workflow

1. **Explore** (`/opsx:explore`) — Optional: think through the problem
2. **Create** (`/opsx:new` or `/opsx:ff`) — Define what to build
3. **Implement** (`/opsx:apply`) — Work through tasks
4. **Verify** (`/opsx:verify`) — Check implementation matches spec
5. **Archive** (`/opsx:archive`) — Finalize and archive

## Tips for MainAgent

- For high-complexity tasks, suggest the agent use `/opsx:ff` to plan before implementing
- When a task involves significant refactoring, consider `/opsx:explore` first
- Include specific context (file paths, function names, constraints) when constructing prompts that reference OpenSpec commands
