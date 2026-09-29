# Human

## Purpose

This document describes the Human role — their responsibilities, relationship with the Developer, and what they can and cannot do.

## Table of Contents

- [Human Role](#human-role)
- [Responsibilities](#responsibilities)
- [Relationship with Developer](#relationship-with-developer)
- [What Humans Can and Cannot Do](#what-humans-can-and-cannot-do)

## Human Role

The Human is the end user who talks directly to the Developer, and only to the Developer. They define what needs to be built and approve plans made of tasks that are testable — meaning the target files are known, success criteria are clear, and each task declares how it will be verified.

## Responsibilities

- Communicate goals and requirements to the Developer.
- Approve every plan, and every plan revision, before the Developer submits it.
- Decide with the Developer how to answer an escalation: revise the plan, remediate, or abandon the work.
- Approve or reject the final results produced by the system.

## Relationship with Developer

The Human and Developer work together to define tasks. The Human provides direction; the Developer decomposes that direction into concrete, testable tasks, each with its target files, success criteria and [verification ladder](../adr/0012-verification-ladder-replaces-phase-one.md). Everything the Developer does is based on this conversation and on the Human's approval.

The Developer stays available while a run is active. A new request from the Human becomes a plan revision, which the Human approves before it is submitted. A revision never changes a task that is already assigned or in progress.

## What Humans Can and Cannot Do

| Can | Cannot |
|-----|--------|
| Talk to the Developer | Create tasks directly |
| Approve or reject plans and plan revisions | Execute tasks |
| Define requirements | Orchestrate workers |
| Approve or reject final results | Interact directly with Workers or Manager |

## See Also

- [Developer](developer.md)
- [Overview](../overview/overview.md)
