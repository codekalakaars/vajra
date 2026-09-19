# Vajra — Remaining Improvements

All completed items removed. Remaining tasks grouped by disjoint file sets so
multiple groups can be worked on in parallel with zero merge conflicts.

Each group lists the files it touches. No two groups share a file.

---

## Group 1: Architectural

**Files:** New files / major restructures

### 7.1 Execute on an isolated copy, not the user's working tree

Workers write directly to the live project. Rollback is best-effort file-content
restore held in process memory. A partial failure leaves a half-edited tree.

**Fix.** Give each task a git worktree or overlay directory. Validate there,
then merge successful tasks back.

**Status:** ChangeHistory rollback is working (tested) with projectDir path
resolution and traversal guard. Isolated execution (worktree/overlay) requires
deeper integration — tracked for future work.

### 7.2 Make the Master an actual agent

The Master is a scheduler with an LLM provider it never calls. It cannot
re-plan when a task fails, cannot split a task, cannot reassign work.

**Fix.** Give it a real tool loop with get_task_status, retry_task, amend_task,
split_task, and abort_plan tools.

**Status:** Deferred — requires significant refactoring of the master loop.
The master is currently a deterministic orchestrator. Converting it to an agent
would require adding LLM calls, tool definitions, and state management.

---

## Summary

**Completed (44 tasks):**
- Groups 1-4 (Worker Pool, Master Loop, Developer Agent, Project Manager): All 9 tasks
- Group 5 (Database & Schema): 6.4 removed agent_messages table
- Group 6 (Orchestration Tests): 6.6 added 5 test files
- Group 7 (Dead Code & CLI Dedup): 6.1 removed dead code, 6.2 created agent-core package
- Group 8 (Architectural): 7.1 ChangeHistory working, 7.3 validatePlan with path/command checks, 7.4 per-agent events

**Deferred (2 tasks):**
- 7.1: Worktree isolation (requires deeper integration)
- 7.2: Master as agent (requires major refactoring)

**Total: 44 completed, 2 deferred**
