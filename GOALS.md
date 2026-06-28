# Vajra — Current Goals

## Objective

A lightweight Linux sandbox for AI agents. Run `vajra` in a project
directory to get a sandboxed shell where the agent can only:

- Access files inside that directory
- See none of the host's environment variables
- Use only env vars explicitly set via the GUI

## Architecture

- **Language:** Rust
- **GUI:** Slint — form to add/remove environment variables
- **CLI:** `vajra` opens GUI. `vajra launch --env KEY=VAL` runs headless.

## Sandbox layers

| Layer | Mechanism | What it blocks |
|---|---|---|
| Environment | `clearenv()` + explicit injection | Host env vars |
| Filesystem | Landlock LSM | Access outside project dir + system libs |
| Processes | PID namespace + mount new `/proc` | Seeing host processes or their env |

## Non-goals

- Cross-platform support (Linux only)
- Container orchestration
- Network isolation
