---
name: commit
description: "Structured git commits with conventional format"
type: agent-capability
commands:
  - /commit
---

# Commit Skill

Use the `/commit` command to create well-structured git commits following conventional commit format.

## When to Use

- After completing a task or group of related changes
- When the agent has made code modifications that should be persisted

## Command

### /commit
Creates a git commit with a conventional commit message. The agent will:
1. Stage relevant changes
2. Generate a descriptive commit message
3. Create the commit

## Tips for MainAgent

- After marking a task complete, consider instructing the agent to `/commit` if significant changes were made
- Include context about what was changed when constructing the commit prompt
- For multi-task changes, prefer committing after each logical group rather than one big commit at the end
