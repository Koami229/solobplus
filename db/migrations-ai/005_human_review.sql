-- ============================================================================
-- SOLOB+ Migration 005: validation humaine des contenus SOLOB AI (double relecture, accord, audit)
-- ============================================================================
-- Strictement ADDITIVE: aucune table existante modifiée, aucun DROP/DELETE. Idempotente (IF NOT EXISTS).
-- Le rôle 'reviewer' existe déjà dans users.role (001); on n'y touche pas. L'habilitation à relire du contenu IA
-- est une table séparée (ai_reviewer_profiles) attribuée par un admin, avec les langues relues.
-- Comme 004, placée dans db/migrations-ai/ (opt-in), à appliquer manuellement après 001-004.

CREATE TABLE IF NOT EXISTS ai_reviewer_profiles (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  languages   TEXT[] NOT NULL DEFAULT '{}',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by  TEXT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_review_items (
  item_id          TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('question','answer','translation','explanation','correction','resource')),
  language         TEXT NOT NULL,
  source_ref       TEXT NOT NULL,               -- ex. sakc:v1:<sha256>, bench:<id>
  sakc_sha256      TEXT CHECK (sakc_sha256 IS NULL OR sakc_sha256 ~ '^[0-9a-f]{64}$'),
  payload          JSONB NOT NULL,
  required_reviews SMALLINT NOT NULL DEFAULT 2 CHECK (required_reviews BETWEEN 2 AND 5),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','in_review','validated','rejected','disputed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_review_items_queue ON ai_review_items(status, language, kind);

CREATE TABLE IF NOT EXISTS ai_reviews (
  review_id    TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES ai_review_items(item_id),
  reviewer_id  TEXT NOT NULL REFERENCES users(id),
  decision     TEXT NOT NULL CHECK (decision IN ('accept','needs_fix','reject')),
  score        SMALLINT CHECK (score IS NULL OR score BETWEEN 1 AND 5),
  comment      TEXT NOT NULL DEFAULT '' CHECK (length(comment) <= 4000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (item_id, reviewer_id)                  -- double relecture = deux relecteurs DISTINCTS
);
CREATE INDEX IF NOT EXISTS idx_ai_reviews_item ON ai_reviews(item_id, created_at);

-- Journal d'audit dédié, append-only (UPDATE/DELETE refusés par trigger).
CREATE TABLE IF NOT EXISTS ai_review_audit (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  item_id     TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION ai_review_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ai_review_audit est en ajout seul'; END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ai_review_audit_append_only') THEN
    CREATE TRIGGER trg_ai_review_audit_append_only BEFORE UPDATE OR DELETE ON ai_review_audit
      FOR EACH ROW EXECUTE FUNCTION ai_review_audit_append_only();
  END IF;
END $$;

-- Statut dérivé après chaque relecture: unanimité sur N relectures → validated/rejected, sinon disputed.
CREATE OR REPLACE FUNCTION ai_review_update_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n INT; req INT; acc INT; rej INT;
BEGIN
  SELECT required_reviews INTO req FROM ai_review_items WHERE item_id = NEW.item_id FOR UPDATE;
  SELECT COUNT(*), COUNT(*) FILTER (WHERE decision='accept'), COUNT(*) FILTER (WHERE decision='reject')
    INTO n, acc, rej FROM ai_reviews WHERE item_id = NEW.item_id;
  UPDATE ai_review_items SET updated_at = NOW(), status = CASE
      WHEN n < req THEN 'in_review'
      WHEN acc = n THEN 'validated'
      WHEN rej = n THEN 'rejected'
      ELSE 'disputed' END
    WHERE item_id = NEW.item_id;
  INSERT INTO ai_review_audit(actor_id, action, item_id, meta)
    VALUES (NEW.reviewer_id, 'REVIEW_SUBMITTED', NEW.item_id, jsonb_build_object('decision', NEW.decision, 'n', n));
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ai_review_status') THEN
    CREATE TRIGGER trg_ai_review_status AFTER INSERT ON ai_reviews
      FOR EACH ROW EXECUTE FUNCTION ai_review_update_status();
  END IF;
END $$;

-- Paires (relecteur 1 = plus ancien, relecteur 2 = suivant) pour l'accord inter-annotateurs.
CREATE OR REPLACE VIEW ai_review_pairs AS
SELECT i.item_id, i.kind, i.language, r1.decision AS decision_1, r2.decision AS decision_2
FROM ai_review_items i
JOIN LATERAL (SELECT decision FROM ai_reviews WHERE item_id=i.item_id ORDER BY created_at, review_id LIMIT 1) r1 ON TRUE
JOIN LATERAL (SELECT decision FROM ai_reviews WHERE item_id=i.item_id ORDER BY created_at, review_id OFFSET 1 LIMIT 1) r2 ON TRUE;

-- Kappa de Cohen par (kind, language), calculé en SQL (même formule que solob_ai/review/agreement.py).
CREATE OR REPLACE VIEW ai_review_agreement AS
WITH p AS (SELECT kind, language, decision_1, decision_2 FROM ai_review_pairs),
n AS (SELECT kind, language, COUNT(*)::float AS n, AVG((decision_1=decision_2)::int)::float AS po FROM p GROUP BY 1,2),
m1 AS (SELECT kind, language, decision_1 AS d, COUNT(*)::float c FROM p GROUP BY 1,2,3),
m2 AS (SELECT kind, language, decision_2 AS d, COUNT(*)::float c FROM p GROUP BY 1,2,3),
pe AS (SELECT n.kind, n.language, COALESCE(SUM(m1.c*m2.c),0)/(n.n*n.n) AS pe FROM n
       LEFT JOIN m1 ON m1.kind=n.kind AND m1.language=n.language
       LEFT JOIN m2 ON m2.kind=n.kind AND m2.language=n.language AND m2.d=m1.d GROUP BY n.kind, n.language, n.n)
SELECT n.kind, n.language, n.n::int AS items_double_relus, n.po AS accord_observe,
       CASE WHEN pe.pe = 1 THEN CASE WHEN n.po = 1 THEN 1.0 ELSE 0.0 END ELSE (n.po - pe.pe)/(1 - pe.pe) END AS kappa
FROM n JOIN pe ON pe.kind=n.kind AND pe.language=n.language;
