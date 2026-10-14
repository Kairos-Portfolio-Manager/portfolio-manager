-- Pitch Lab's canonical, append-only record.
--
-- Pitch Lab starts directly on Postgres. Redis carries peer/candidate inputs
-- plus namespaced completion, Telegram-dedupe, and report projections; local
-- JSONL remains a development/demo adapter. These tables store the complete
-- validated records so schema evolution does not discard provenance while
-- indexed columns keep operational reads simple.

CREATE TABLE IF NOT EXISTS pitch_lab_selections (
  selection_date DATE PRIMARY KEY,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (record ? 'date' AND record->>'date' = to_char(selection_date, 'YYYY-MM-DD'))
);

CREATE TABLE IF NOT EXISTS pitch_lab_pitches (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  pitched_at TIMESTAMPTZ NOT NULL,
  pitch_date DATE NOT NULL,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (record ? 'id' AND record->>'id' = id),
  CHECK (record ? 'agentId' AND record->>'agentId' = agent_id),
  CHECK (record ? 'ticker' AND record->>'ticker' = ticker),
  CHECK (record ? 'pitchedAt' AND (record->>'pitchedAt')::timestamptz = pitched_at),
  CHECK (pitch_date = (pitched_at AT TIME ZONE 'America/New_York')::date),
  UNIQUE (agent_id, ticker, pitch_date)
);

CREATE INDEX IF NOT EXISTS pitch_lab_pitches_pitched_at_idx
  ON pitch_lab_pitches(pitched_at DESC, id);

CREATE INDEX IF NOT EXISTS pitch_lab_pitches_ticker_pitched_at_idx
  ON pitch_lab_pitches(agent_id, ticker, pitched_at DESC);

CREATE TABLE IF NOT EXISTS pitch_lab_outcomes (
  pitch_id TEXT NOT NULL REFERENCES pitch_lab_pitches(id),
  horizon_days INTEGER NOT NULL CHECK (horizon_days > 0),
  graded_at TIMESTAMPTZ NOT NULL,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pitch_id, horizon_days),
  CHECK (record ? 'pitchId' AND record->>'pitchId' = pitch_id),
  CHECK (record ? 'horizonDays' AND (record->>'horizonDays')::integer = horizon_days),
  CHECK (record ? 'gradedAt' AND (record->>'gradedAt')::timestamptz = graded_at),
  CHECK (record ? 'status' AND record->>'status' = 'matured')
);

CREATE INDEX IF NOT EXISTS pitch_lab_outcomes_graded_at_idx
  ON pitch_lab_outcomes(graded_at DESC, pitch_id);

-- These are observations, not editable documents. Corrections are represented
-- by new versioned records rather than rewriting the evidence after outcomes
-- are known.
CREATE OR REPLACE FUNCTION reject_pitch_lab_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Pitch Lab records are append-only; % is not allowed on %', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pitch_lab_selections_immutable ON pitch_lab_selections;
CREATE TRIGGER pitch_lab_selections_immutable
  BEFORE UPDATE OR DELETE ON pitch_lab_selections
  FOR EACH ROW EXECUTE FUNCTION reject_pitch_lab_mutation();
DROP TRIGGER IF EXISTS pitch_lab_selections_no_truncate ON pitch_lab_selections;
CREATE TRIGGER pitch_lab_selections_no_truncate
  BEFORE TRUNCATE ON pitch_lab_selections
  FOR EACH STATEMENT EXECUTE FUNCTION reject_pitch_lab_mutation();

DROP TRIGGER IF EXISTS pitch_lab_pitches_immutable ON pitch_lab_pitches;
CREATE TRIGGER pitch_lab_pitches_immutable
  BEFORE UPDATE OR DELETE ON pitch_lab_pitches
  FOR EACH ROW EXECUTE FUNCTION reject_pitch_lab_mutation();
DROP TRIGGER IF EXISTS pitch_lab_pitches_no_truncate ON pitch_lab_pitches;
CREATE TRIGGER pitch_lab_pitches_no_truncate
  BEFORE TRUNCATE ON pitch_lab_pitches
  FOR EACH STATEMENT EXECUTE FUNCTION reject_pitch_lab_mutation();

DROP TRIGGER IF EXISTS pitch_lab_outcomes_immutable ON pitch_lab_outcomes;
CREATE TRIGGER pitch_lab_outcomes_immutable
  BEFORE UPDATE OR DELETE ON pitch_lab_outcomes
  FOR EACH ROW EXECUTE FUNCTION reject_pitch_lab_mutation();
DROP TRIGGER IF EXISTS pitch_lab_outcomes_no_truncate ON pitch_lab_outcomes;
CREATE TRIGGER pitch_lab_outcomes_no_truncate
  BEFORE TRUNCATE ON pitch_lab_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_pitch_lab_mutation();
