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
