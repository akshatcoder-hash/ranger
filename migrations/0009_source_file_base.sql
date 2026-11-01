-- The content a file had before Ranger first overwrote it, so the Changes view
-- can show a real diff. One row per path, written once (INSERT OR IGNORE) from
-- the previous content at save time; never rewritten afterwards.
CREATE TABLE workspace_source_base (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  content BLOB NOT NULL,
  size_bytes INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, relative_path)
);
