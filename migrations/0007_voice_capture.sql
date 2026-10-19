-- Voice sessions, capture sessions and frame metadata (feature: lean-voice-latest-frame).
--
-- Voice sessions bind one principal/conversation to one explicit provider
-- relay session; ending is terminal and a reconnect always creates a NEW
-- session (no upstream state reconstruction). Capture sessions own one
-- in-memory latest validated frame; ONLY frame metadata persists here — raw
-- frame bytes and audio are never stored (no recordings, no retained media).

CREATE TABLE voice_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'ended')),
  end_reason TEXT,
  audio_seconds REAL NOT NULL DEFAULT 0,
  text_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX idx_voice_sessions_project ON voice_sessions (project_id, created_at);
CREATE INDEX idx_voice_sessions_conversation ON voice_sessions (conversation_id);

CREATE TABLE capture_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'ended')),
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX idx_capture_sessions_project ON capture_sessions (project_id, created_at);

-- Frame metadata only: dimensions/size/times for observability. The raw
-- image bytes live exclusively in the bounded in-memory latest-frame slot
-- and are cleared when the capture session ends.
CREATE TABLE capture_frame_metadata (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES capture_sessions(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  frame_id TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  capture_timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, frame_id)
);

CREATE INDEX idx_capture_frame_metadata_session ON capture_frame_metadata (session_id, created_at);
