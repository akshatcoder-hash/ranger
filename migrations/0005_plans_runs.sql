-- Immutable plan versions, exact-version sandbox approvals, durable runs
-- and per-run tool records (feature: lean-approved-run-workflow).
--
-- A plan version is immutable; a new version supersedes prior versions and
-- invalidates their active approvals (material change). A run binds one
-- active approval of the project's current plan version. Worker claims are
-- fenced with worker_id + claim_epoch so a stale worker can never commit.

CREATE TABLE plan_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  items_json TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL,
  permitted_scope_json TEXT NOT NULL,
  repository_commit TEXT,
  impacted_paths_json TEXT NOT NULL DEFAULT '[]',
  impacted_tests_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'superseded', 'invalidated')),
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, version)
);

CREATE INDEX idx_plan_versions_project ON plan_versions (project_id, version);

CREATE TABLE plan_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  permitted_scope_json TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'invalidated')),
  invalidated_at INTEGER,
  invalidation_reason TEXT
);

CREATE INDEX idx_plan_approvals_project ON plan_approvals (project_id, status);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL REFERENCES plan_approvals(id),
  plan_id TEXT NOT NULL REFERENCES plan_versions(id),
  plan_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  failure_code TEXT,
  failure_message TEXT,
  usage_json TEXT,
  turns INTEGER,
  job_id TEXT NOT NULL UNIQUE,
  worker_id TEXT,
  claim_epoch INTEGER,
  lease_expires_at INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE INDEX idx_runs_project ON runs (project_id, created_at);
CREATE INDEX idx_runs_state ON runs (state);

-- Durable per-run tool records (bounded results) backing the run tools read.
CREATE TABLE run_tool_outcomes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_run_tool_outcomes_run ON run_tool_outcomes (run_id, created_at);

-- Attribute workspace commands (and therefore logs and test outcomes) to the
-- run that executed them, and mark test commands for the tests read.
ALTER TABLE workspace_commands ADD COLUMN run_id TEXT;
ALTER TABLE workspace_commands ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_workspace_commands_run ON workspace_commands (run_id);
