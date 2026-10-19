-- Semantic origin of a persisted workspace source file.
--
-- 'initial_checkout': the verified initial base materialized from the
-- connected approved-root repository at its recorded commit, BEFORE any VM
-- create. 'guest_edit': a file created by a successful guest edit (saved
-- only after the guest write succeeded). Existing rows were all saved after
-- guest success, so they default to 'guest_edit'. Origin is set at insert
-- and never rewritten: it records where the file entered the workspace from.
ALTER TABLE workspace_source_files ADD COLUMN origin TEXT NOT NULL DEFAULT 'guest_edit';
