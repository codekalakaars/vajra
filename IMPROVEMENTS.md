# Vajra — Remaining Improvements

All completed items removed. Remaining tasks grouped by disjoint file sets so
multiple groups can be worked on in parallel with zero merge conflicts.

Each group lists the files it touches. No two groups share a file.

---

## Group 1: Architectural

**Files:** New files / major restructures

### 7.2 Make the Master an actual agent

The Master is a scheduler with an LLM provider it never calls. It cannot
re-plan when a task fails, cannot split a task, cannot reassign work.

**Fix.** Give it a real tool loop with get_task_status, retry_task, amend_task,
split_task, and abort_plan tools.

**Completed:** The master now has an LLM decision loop that activates when
a task fails after exhausting retries. Five orchestration tools are defined:
`get_task_status`, `retry_task`, `amend_task`, `split_task`, `abort_plan`.
After rollback, the LLM receives failure context (task details, validation
output, queue status) and decides the next action. The `split_task` tool
creates sub-tasks with proper dependency wiring. The `amend_task` tool
modifies instructions/files and re-queues. `abort_plan` triggers the abort
signal to stop all work. The deterministic scheduling loop is preserved
for normal operation — the LLM only介入 on terminal failures.

---

## Summary

**Completed (45 tasks):**
- Groups 1-4 (Worker Pool, Master Loop, Developer Agent, Project Manager): All 9 tasks
- Group 5 (Database & Schema): 6.4 removed agent_messages table
- Group 6 (Orchestration Tests): 6.6 added 5 test files
- Group 7 (Dead Code & CLI Dedup): 6.1 removed dead code, 6.2 created agent-core package
- Group 8 (Architectural): 7.1 worktree isolation, 7.3 validatePlan with path/command checks, 7.4 per-agent events

**Deferred (1 task):**
- 7.2: Master as agent (requires major refactoring)

**Total: 45 completed, 1 deferred**
