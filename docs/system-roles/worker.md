# Worker

## Purpose

This document describes the Worker role — the single-task principle, responsibilities, and limitations.

## Table of Contents

- [Worker Agent](#worker-agent)
- [Single Task Principle](#single-task-principle)
- [Responsibilities](#responsibilities)
- [Limitations](#limitations)

## Worker Agent

The Worker is the execution engine of the system. Each Worker receives one task from the Manager and completes it end to end.

## Single Task Principle

A Worker executes **one task at a time**. This principle exists because:
- It keeps Worker state simple — at most one active task.
- It ensures focused, end-to-end completion before moving on.
- It gives the Manager full control over assignment and scheduling.

## Responsibilities

- Execute the assigned task end to end.
- Stay within the permissions and scope of the assigned task.
- Report completion or failure back to the Manager.

## Limitations

- Cannot create tasks.
- Cannot see or pick up additional tasks.
- Cannot interact directly with the Human or Developer.
- Permissions are confined to the assigned task only.

## See Also

- [Manager](manager.md)
- [Tasks](../tasks/README.md)
- [ADR-0002](../adr/0002-single-task-workers.md)
