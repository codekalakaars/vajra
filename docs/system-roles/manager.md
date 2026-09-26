# Manager

## Purpose

This document describes the Manager role — task assignment, worker supervision, inspection, and escalation responsibilities.

## Table of Contents

- [Manager Agent](#manager-agent)
- [Task Assignment](#task-assignment)
- [Worker Supervision](#worker-supervision)
- [Inspection and Reporting](#inspection-and-reporting)
- [Escalation Responsibilities](#escalation-responsibilities)
- [Constraints](#constraints)

## Manager Agent

The Manager is the orchestrator of the system. They receive all tasks from the Developer, assign them to Workers, inspect the results, and report problems back to the Developer.

## Task Assignment

- Receive all tasks from the Developer.
- Assign one task at a time to each Worker.
- Ensure each Worker has the permissions and context needed for their assigned task.

## Worker Supervision

- Monitor Worker progress on assigned tasks.
- Ensure Workers complete their tasks end to end.

## Inspection and Reporting

- Inspect Worker output for correctness and completeness.
- Report all problems to the Developer.
- The Developer then creates new tasks to handle the situation.

## Escalation Responsibilities

- When a Worker fails or produces incorrect output, the Manager escalates to the Developer.
- The Manager does not fix problems directly — it reports them so the Developer can create remediation tasks.

## Constraints

- Cannot create tasks.
- Cannot execute tasks.
- Cannot modify Worker output — only inspect and report.

## See Also

- [Developer](developer.md)
- [Worker](worker.md)
- [Execution](../execution/README.md)
