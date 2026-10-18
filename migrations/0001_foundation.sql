-- Foundation schema: durable job queue used by the worker entrypoint.
-- Later features add their own migrations (principals, projects, events, ...).

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  claimed_by TEXT,
  claim_epoch INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_jobs_claimable ON jobs (status, lease_expires_at);
CREATE INDEX idx_jobs_type ON jobs (type);
