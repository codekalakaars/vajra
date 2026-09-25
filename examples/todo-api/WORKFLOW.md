# Vajra Multi-Agent Workflow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INTERFACE                                │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  "Fix the issues in my Todo API. It needs input validation,        │  │
│  │   better error handling, and some missing features."                │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  SESSION STATUS: talking → confirming → executing → done           │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MANAGER AGENT                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  1. Reads project files to understand codebase                     │  │
│  │  2. Asks clarifying questions                                      │  │
│  │  3. Proposes detailed plan with prescriptive tasks                 │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  PROPOSE_PLAN TOOL CALL:                                           │  │
│  │  {                                                                  │  │
│  │    "tasks": [                                                       │  │
│  │      {                                                              │  │
│  │        "title": "Add input validation",                            │  │
│  │        "instructions": ["Step 1...", "Step 2...", ...],            │  │
│  │        "readFile": ["src/server.js"],                               │  │
│  │        "writeFile": ["src/server.js"],                              │  │
│  │        "validation": ["npm test"],                                  │  │
│  │        ...                                                          │  │
│  │      },                                                             │  │
│  │      ...                                                            │  │
│  │    ]                                                                │  │
│  │  }                                                                  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER CONFIRMS                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  [Confirm & Execute]  [Keep Talking]                               │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MASTER AGENT                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  1. Reads confirmed plan                                           │  │
│  │  2. Resolves task dependencies                                     │  │
│  │  3. Detects file conflicts                                         │  │
│  │  4. Computes scoped permissions for each worker                    │  │
│  │  5. Launches workers in parallel                                   │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│        ┌───────────┬───────────┬───────────┬───────────┐                  │
│        ▼           ▼           ▼           ▼           ▼                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ WORKER 1 │ │ WORKER 2 │ │ WORKER 3 │ │ WORKER 4 │ │ WORKER 5 │       │
│  │          │ │          │ │          │ │          │ │          │       │
│  │ Input    │ │ JSON     │ │ File     │ │ Filtering│ │ Rate     │       │
│  │ Valid.   │ │ Errors   │ │ Locking  │ │ & Pages  │ │ Limiting │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
│        │           │           │           │           │                  │
│        ▼           ▼           ▼           ▼           ▼                  │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  Each worker:                                                      │  │
│  │  - Receives system prompt with exact instructions                  │  │
│  │  - Has read-only access to readFile files                          │  │
│  │  - Has read-write access to writeFile files                        │  │
│  │  - Can only use allowed tools                                      │  │
│  │  - Follows step-by-step instructions                               │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  VALIDATION:                                                       │  │
│  │  - Worker 1: npm test ✓                                            │  │
│  │  - Worker 2: npm test ✓                                            │  │
│  │  - Worker 3: npm test ✓                                            │  │
│  │  - Worker 4: npm test ✓                                            │  │
│  │  - Worker 5: npm test ✗ → retry → ✗ → fail                         │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  RESULTS:                                                          │  │
│  │  - 4 tasks completed successfully                                  │  │
│  │  - 1 task failed after 2 retries                                   │  │
│  │  - Total tool calls: 47                                            │  │
│  │  - Summary: Added input validation, JSON error handling,           │  │
│  │    file locking, and filtering/pagination. Rate limiter needs      │  │
│  │    test fixes.                                                     │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Security Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SANDBOX ENFORCEMENT                              │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  Worker 1:                                                         │  │
│  │  - READ: src/server.js                                             │  │
│  │  - WRITE: src/server.js                                            │  │
│  │  - TOOLS: read_file, write_file, edit_file                         │  │
│  │  - CANNOT: access other files, run commands, delete anything       │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  Worker 5:                                                         │  │
│  │  - READ: src/server.js                                             │  │
│  │  - WRITE: src/rate-limiter.js, src/rate-limiter.test.js            │  │
│  │  - TOOLS: read_file, write_file                                    │  │
│  │  - CANNOT: edit existing files, run commands, delete anything      │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```
