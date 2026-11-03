-- 007 — Phase D : traçabilité de l'usage des contributions à l'entraînement.
-- STRICTEMENT ADDITIVE et idempotente (CREATE ... IF NOT EXISTS, CREATE OR REPLACE). Aucune suppression, aucune table
-- existante modifiée dans sa structure. La seule écriture sur `contributions` passe par la fonction ci-dessous, qui ne
-- renseigne `used_in_training_at` QUE s'il est NULL et QUE pour des contributions approuvées (jamais retirées).
-- Appelée par solob_ai.pipeline.retrain UNIQUEMENT après un entraînement réel (>= 1 pas d'optimisation).

CREATE TABLE IF NOT EXISTS contribution_training_audit (
  audit_id           BIGSERIAL PRIMARY KEY,
  run_id             TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
  contribution_id    TEXT NOT NULL REFERENCES contributions(contribution_id),
  checkpoint_sha256  TEXT NOT NULL CHECK (checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  outcome            TEXT NOT NULL CHECK (outcome IN ('marked','already_marked','not_eligible')),
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contrib_training_audit_run ON contribution_training_audit(run_id);
CREATE INDEX IF NOT EXISTS idx_contrib_training_audit_contrib ON contribution_training_audit(contribution_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_contribution_training_audit_append_only') THEN
    CREATE TRIGGER trg_contribution_training_audit_append_only BEFORE UPDATE OR DELETE ON contribution_training_audit
      FOR EACH ROW EXECUTE FUNCTION contrib_append_only();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION ai_mark_contributions_trained(p_run_id TEXT, p_ids TEXT[], p_checkpoint_sha256 TEXT)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE cid TEXT; c RECORD; n INTEGER := 0; oc TEXT;
BEGIN
  FOREACH cid IN ARRAY COALESCE(p_ids, ARRAY[]::TEXT[]) LOOP
    SELECT contribution_id, status, used_in_training_at INTO c FROM contributions WHERE contribution_id = cid FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF c.status <> 'approved' THEN oc := 'not_eligible';
    ELSIF c.used_in_training_at IS NOT NULL THEN oc := 'already_marked';
    ELSE
      UPDATE contributions SET used_in_training_at = NOW(), updated_at = NOW() WHERE contribution_id = cid;
      oc := 'marked'; n := n + 1;
    END IF;
    INSERT INTO contribution_training_audit(run_id, contribution_id, checkpoint_sha256, outcome) VALUES (p_run_id, cid, p_checkpoint_sha256, oc);
  END LOOP;
  RETURN n;
END $$;
