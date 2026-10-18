-- Identity, projects and repository references (feature: identity-projects-repository-state).
--
-- Secret material policy: API tokens, browser session secrets and connection
-- ticket secrets are stored ONLY as a sha256 lookup key (indexed) plus a
-- salted scrypt hash. Plaintext secrets never reach the database.

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'api_token')),
  name TEXT NOT NULL,
  secret_lookup TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX idx_credentials_principal ON credentials (principal_id, kind);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  engineer_display_name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE memberships (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, principal_id)
);

CREATE INDEX idx_memberships_principal ON memberships (principal_id);

CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  secret_lookup TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX idx_browser_sessions_principal ON browser_sessions (principal_id);

CREATE TABLE connection_tickets (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('events', 'voice-relay', 'desktop-stream', 'app-preview')),
  origin TEXT,
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('api_token', 'browser_session')),
  credential_id TEXT NOT NULL,
  secret_lookup TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX idx_connection_tickets_project ON connection_tickets (project_id);

CREATE TABLE project_repositories (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  checkout_path TEXT NOT NULL,
  checkout_policy TEXT NOT NULL DEFAULT '{}',
  connected_by TEXT NOT NULL REFERENCES principals(id),
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
