-- Opt-in shared demo access (RANGER_DEMO_PROJECT_ID).
--
-- A row records that a membership on `project_id` was created by the demo
-- grant itself, never by an owner. It is the only thing the startup
-- reconciliation may revoke: when the flag is removed or points at another
-- project, the matching 'member' rows are deleted together with the grant.
CREATE TABLE demo_access_grants (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, principal_id)
);
