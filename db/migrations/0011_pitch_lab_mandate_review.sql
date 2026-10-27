-- Mandate Review history — one row per generated review (monthly cadence).
-- Append-only: corrections are new rows, never rewrites.

CREATE TABLE IF NOT EXISTS pitch_lab_mandate_reviews (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (record ? 'schemaVersion'),
  CHECK (record ? 'agentId' AND record->>'agentId' = agent_id),
  CHECK (record ? 'generatedAt' AND (record->>'generatedAt')::timestamptz = generated_at),
  CHECK (record ? 'status' AND record->>'status' = status)
);

CREATE INDEX IF NOT EXISTS pitch_lab_mandate_reviews_agent_generated_idx
  ON pitch_lab_mandate_reviews(agent_id, generated_at DESC);

CREATE OR REPLACE FUNCTION reject_mandate_review_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Mandate reviews are append-only; % is not allowed on %', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pitch_lab_mandate_reviews_immutable ON pitch_lab_mandate_reviews;
CREATE TRIGGER pitch_lab_mandate_reviews_immutable
  BEFORE UPDATE OR DELETE ON pitch_lab_mandate_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_mandate_review_mutation();

DROP TRIGGER IF EXISTS pitch_lab_mandate_reviews_no_truncate ON pitch_lab_mandate_reviews;
CREATE TRIGGER pitch_lab_mandate_reviews_no_truncate
  BEFORE TRUNCATE ON pitch_lab_mandate_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mandate_review_mutation();
