-- Ephemeral Instabox workspaces, persisted source, commands and viewing
-- sessions. Provider stream URLs, certificates and private keys are NOT
-- columns: those stay in process memory and protected temp files only.

CREATE TABLE workspaces (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL UNIQUE,
  machine_id TEXT,
  reservation_id TEXT,
  source_revision TEXT,
  desired_state TEXT NOT NULL,
  observed_state TEXT NOT NULL,
  vault INTEGER NOT NULL DEFAULT 0,
  kill_timeout_ms INTEGER,
  deadline_at INTEGER,
  uncertain INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  destroyed_at INTEGER
);

CREATE TABLE workspace_source_files (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  content BLOB NOT NULL,
  size_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, relative_path)
);

CREATE TABLE workspace_commands (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  argv_json TEXT NOT NULL,
  state TEXT NOT NULL,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  pid INTEGER,
  logs TEXT NOT NULL DEFAULT '',
  log_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX idx_workspace_commands_project ON workspace_commands (project_id, started_at);

CREATE TABLE workspace_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content BLOB NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE desktop_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE preview_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  guest_port INTEGER NOT NULL,
  local_port INTEGER,
  state TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  stopped_at INTEGER,
  created_at INTEGER NOT NULL
);
