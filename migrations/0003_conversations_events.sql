-- Conversations, durable project event history, per-project sequence
-- allocation and scoped mutation idempotency (feature:
-- conversations-transactional-events).
--
-- State mutations and their events commit in the SAME transaction: a rolled
-- back transaction leaves neither a row nor a consumed sequence, so committed
-- sequences are dense per project and replay never observes a phantom.

-- Per-project sequence allocator. Allocation happens inside the writing
-- transaction (UPDATE ... last_sequence + 1), serializing across API/worker.
CREATE TABLE project_event_sequences (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  last_sequence INTEGER NOT NULL DEFAULT 0
);

-- Immutable append-only event history. `data` holds the type-specific JSON
-- payload validated against the declared event type schema at append time.
CREATE TABLE project_events (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  run_id TEXT,
  session_id TEXT,
  timestamp_ms INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (project_id, sequence)
);

CREATE INDEX idx_project_events_time ON project_events (timestamp_ms);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_conversations_project ON conversations (project_id, created_at);

-- `ordinal` is a per-conversation dense insertion sequence allocated inside
-- the writing transaction, giving stable total message order.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, ordinal)
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_questions_conversation ON questions (conversation_id, created_at);

-- Every answer references the exact question it answers.
CREATE TABLE answers (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_answers_question ON answers (question_id, created_at);

-- Versioned requirement threads: versions append immutably, never in place.
CREATE TABLE requirement_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_requirement_threads_project ON requirement_threads (project_id, created_at);

CREATE TABLE requirement_versions (
  requirement_id TEXT NOT NULL REFERENCES requirement_threads(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (requirement_id, version)
);

-- Versioned decision threads: same append-only versioning.
CREATE TABLE decision_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_decision_threads_project ON decision_threads (project_id, created_at);

CREATE TABLE decision_versions (
  decision_id TEXT NOT NULL REFERENCES decision_threads(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (decision_id, version)
);

-- Scoped mutation idempotency: scope = operationId:projectId, key = the
-- scoped Idempotency-Key header, request_hash = canonical hash of the
-- request input. A record is written in the SAME transaction as the state
-- mutation and its events; identical retries replay the stored response,
-- reuse with different input conflicts.
CREATE TABLE idempotency_records (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);
