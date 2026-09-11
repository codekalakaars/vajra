-- Structured turns, not byte blobs. This is deliberately different from the
-- byte-replay scrollback schema an earlier draft of this design used for
-- mirroring a third-party CLI in a PTY: there is no PTY here, so there is no
-- arbitrary terminal-byte stream to replay, only structured plan steps and
-- conversation turns.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,
  task TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,            -- starting | planning | executing | done | failed | stopped
  sandbox_enforced INTEGER,        -- NULL until the worker reports; 0/1 after
  sandbox_mechanism TEXT,
  sandbox_warnings TEXT,           -- JSON array
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS plan_steps (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  step_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending | active | done | skipped
  PRIMARY KEY (session_id, step_index)
);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,              -- user | assistant | tool
  content TEXT,
  tool_name TEXT,
  tool_call_id TEXT,
  tool_args TEXT,                  -- JSON
  tool_result TEXT,                -- JSON
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

-- Agent registry: tracks manager, master, and worker agents within a session.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,              -- 'manager' | 'master' | 'worker'
  status TEXT NOT NULL,            -- 'pending' | 'running' | 'done' | 'failed'
  task_summary TEXT,
  parent_agent_id TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);

-- Task decomposition and tracking.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_task_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,            -- 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'skipped'
  assigned_agent_id TEXT REFERENCES agents(id),
  validation_command TEXT,
  validation_output TEXT,
  validation_passed INTEGER,      -- NULL until validated, 0/1 after
  file_permissions TEXT,           -- JSON: PermissionsConfig for this task
  tool_permissions TEXT,           -- JSON: string[] of allowed tool names
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- Task dependency DAG.
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on)
);

-- Inter-agent message bus (coordination, conflict resolution, progress).
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  from_agent_id TEXT NOT NULL REFERENCES agents(id),
  to_agent_id TEXT REFERENCES agents(id),  -- NULL for broadcast
  message_type TEXT NOT NULL,      -- 'task_assigned' | 'task_completed' | 'conflict_detected' | 'coordination'
  payload TEXT NOT NULL,           -- JSON
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id);
