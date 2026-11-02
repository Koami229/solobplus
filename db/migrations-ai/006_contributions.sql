-- ============================================================================
-- SOLOB+ Migration 006: contributions des utilisateurs à SOLOB AI (Phase C)
-- ============================================================================
-- Strictement ADDITIVE et idempotente: nouvelles tables/fonctions/triggers/vues uniquement (IF NOT EXISTS,
-- CREATE OR REPLACE, ON CONFLICT DO NOTHING). Aucun DROP, TRUNCATE, DELETE, aucune table existante modifiée.
-- Prérequis: 001-003 puis 005 (double relecture). Comme 004/005, opt-in dans db/migrations-ai/.
-- Réutilise 005: chaque contribution crée un ai_review_items (required_reviews=2, UNIQUE(item, reviewer))
-- relu par deux relecteurs DISTINCTS habilités; ai_review_audit (ajout seul) journalise tout.

-- Textes de consentement versionnés (immuables une fois publiés).
CREATE TABLE IF NOT EXISTS contribution_consent_texts (
  version     TEXT PRIMARY KEY,
  license     TEXT NOT NULL CHECK (license = 'CC-BY-4.0'),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO contribution_consent_texts(version, license, body) VALUES ('contrib-v1', 'CC-BY-4.0',
 'Je confirme être l''auteur de ce texte ou en détenir les droits, qu''il ne contient aucune donnée personnelle d''autrui, '
 'et je le place sous licence Creative Commons Attribution 4.0 International (CC BY 4.0), avec attribution au nom ou pseudonyme indiqué. '
 'SOLOB+ peut l''utiliser pour évaluer et entraîner SOLOB AI après double validation humaine. '
 'Je peux retirer ma contribution tant qu''elle n''a pas été intégrée à un entraînement.')
ON CONFLICT (version) DO NOTHING;

CREATE TABLE IF NOT EXISTS contributions (
  contribution_id      TEXT PRIMARY KEY,
  contributor_id       TEXT NOT NULL REFERENCES users(id),
  kind                 TEXT NOT NULL CHECK (kind IN ('text','translation','correction')),
  language             TEXT NOT NULL CHECK (language IN ('fon','yo','ha','wo','ig','sw','fr','en')),
  source_text          TEXT CHECK (source_text IS NULL OR length(source_text) <= 4000),
  body                 TEXT NOT NULL CHECK (length(body) BETWEEN 10 AND 8000),
  body_sha256          TEXT NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  license              TEXT NOT NULL DEFAULT 'CC-BY-4.0' CHECK (license = 'CC-BY-4.0'),
  attribution          TEXT NOT NULL CHECK (length(attribution) BETWEEN 1 AND 120),
  consent_version      TEXT NOT NULL REFERENCES contribution_consent_texts(version),
  consent_at           TIMESTAMPTZ NOT NULL,
  is_minor             BOOLEAN NOT NULL DEFAULT FALSE,
  parental_consent_at  TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  review_item_id       TEXT UNIQUE REFERENCES ai_review_items(item_id),
  provenance           JSONB NOT NULL,
  used_in_training_at  TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind = 'text' OR source_text IS NOT NULL),
  CHECK (NOT is_minor OR parental_consent_at IS NOT NULL),
  CHECK (status <> 'withdrawn' OR used_in_training_at IS NULL),
  UNIQUE (contributor_id, body_sha256)               -- anti-spam: même texte une seule fois par contributeur
);
CREATE INDEX IF NOT EXISTS idx_contributions_contributor ON contributions(contributor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contributions_status ON contributions(status, language);

-- Journal de consentement (ajout seul): GIVEN à la soumission, WITHDRAWN au retrait.
CREATE TABLE IF NOT EXISTS contribution_consents (
  id               BIGSERIAL PRIMARY KEY,
  contribution_id  TEXT NOT NULL REFERENCES contributions(contribution_id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  event            TEXT NOT NULL CHECK (event IN ('GIVEN','WITHDRAWN','PARENTAL_GIVEN')),
  consent_version  TEXT NOT NULL REFERENCES contribution_consent_texts(version),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Réputation (ajout seul) + vue agrégée.
CREATE TABLE IF NOT EXISTS reputation_events (
  id               BIGSERIAL PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  delta            INTEGER NOT NULL CHECK (delta BETWEEN -50 AND 50),
  reason           TEXT NOT NULL CHECK (reason IN ('CONTRIBUTION_APPROVED','CONTRIBUTION_REJECTED','REVIEW_AGREED_WITH_OUTCOME',
                                                    'REPORT_UPHELD','CONTRIBUTION_REPORT_UPHELD')),
  contribution_id  TEXT REFERENCES contributions(contribution_id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_reputation_user ON reputation_events(user_id);
CREATE OR REPLACE VIEW contributor_reputation AS
  SELECT user_id, SUM(delta)::int AS points, COUNT(*)::int AS events FROM reputation_events GROUP BY user_id;

-- Signalements d'abus (contenu toxique, plagiat, données personnelles, spam...).
CREATE TABLE IF NOT EXISTS contribution_reports (
  report_id        TEXT PRIMARY KEY,
  contribution_id  TEXT NOT NULL REFERENCES contributions(contribution_id),
  reporter_id      TEXT NOT NULL REFERENCES users(id),
  reason           TEXT NOT NULL CHECK (reason IN ('toxic','plagiarism','personal_data','spam','wrong_language','other')),
  details          TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 2000),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','dismissed')),
  resolved_by      TEXT REFERENCES users(id),
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contribution_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_contribution_reports_open ON contribution_reports(status, created_at);

-- « Réponse utile » sur les réponses IA de School (school_study_materials). Un avis par utilisateur et réponse.
CREATE TABLE IF NOT EXISTS ai_answer_feedback (
  feedback_id  TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  material_id  TEXT NOT NULL REFERENCES school_study_materials(id),
  helpful      BOOLEAN NOT NULL,
  comment      TEXT NOT NULL DEFAULT '' CHECK (length(comment) <= 2000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, material_id)
);

-- Ajout seul pour les journaux de consentement et de réputation (même mécanisme que ai_review_audit).
CREATE OR REPLACE FUNCTION contrib_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% est en ajout seul', TG_TABLE_NAME; END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_contribution_consents_append_only') THEN
    CREATE TRIGGER trg_contribution_consents_append_only BEFORE UPDATE OR DELETE ON contribution_consents
      FOR EACH ROW EXECUTE FUNCTION contrib_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_reputation_events_append_only') THEN
    CREATE TRIGGER trg_reputation_events_append_only BEFORE UPDATE OR DELETE ON reputation_events
      FOR EACH ROW EXECUTE FUNCTION contrib_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_consent_texts_immutable') THEN
    CREATE TRIGGER trg_consent_texts_immutable BEFORE UPDATE OR DELETE ON contribution_consent_texts
      FOR EACH ROW EXECUTE FUNCTION contrib_append_only();
  END IF;
END $$;

-- Garde-fous à la relecture: pas d'auto-relecture, pas de relecture d'une contribution retirée/close.
CREATE OR REPLACE FUNCTION contrib_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c RECORD;
BEGIN
  SELECT contributor_id, status INTO c FROM contributions WHERE review_item_id = NEW.item_id;
  IF FOUND THEN
    IF c.contributor_id = NEW.reviewer_id THEN RAISE EXCEPTION 'SELF_REVIEW: un contributeur ne peut pas relire sa propre contribution'; END IF;
    IF c.status <> 'pending' THEN RAISE EXCEPTION 'CONTRIBUTION_CLOSED: contribution %', c.status; END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_contrib_review_guard') THEN
    CREATE TRIGGER trg_contrib_review_guard BEFORE INSERT ON ai_reviews FOR EACH ROW EXECUTE FUNCTION contrib_review_guard();
  END IF;
END $$;

-- Synchronisation du verdict de la double relecture (005) vers la contribution + réputation.
-- validated (2 accept unanimes) → approved ; rejected (unanime) → rejected ; disputed → reste pending (arbitrage lang_lead/admin).
CREATE OR REPLACE FUNCTION contrib_sync_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c RECORD; outcome TEXT;
BEGIN
  IF NEW.status = OLD.status OR NEW.status NOT IN ('validated','rejected') THEN RETURN NEW; END IF;
  SELECT contribution_id, contributor_id, status INTO c FROM contributions WHERE review_item_id = NEW.item_id FOR UPDATE;
  IF NOT FOUND OR c.status <> 'pending' THEN RETURN NEW; END IF;
  outcome := CASE NEW.status WHEN 'validated' THEN 'approved' ELSE 'rejected' END;
  UPDATE contributions SET status = outcome, updated_at = NOW() WHERE contribution_id = c.contribution_id;
  INSERT INTO reputation_events(user_id, delta, reason, contribution_id)
    VALUES (c.contributor_id, CASE outcome WHEN 'approved' THEN 10 ELSE -2 END,
            CASE outcome WHEN 'approved' THEN 'CONTRIBUTION_APPROVED' ELSE 'CONTRIBUTION_REJECTED' END, c.contribution_id);
  INSERT INTO reputation_events(user_id, delta, reason, contribution_id)
    SELECT reviewer_id, 1, 'REVIEW_AGREED_WITH_OUTCOME', c.contribution_id FROM ai_reviews
     WHERE item_id = NEW.item_id AND decision = CASE outcome WHEN 'approved' THEN 'accept' ELSE 'reject' END;
  INSERT INTO ai_review_audit(actor_id, action, item_id, meta)
    VALUES (NULL, 'CONTRIBUTION_' || upper(outcome), NEW.item_id, jsonb_build_object('contribution_id', c.contribution_id));
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_contrib_sync_status') THEN
    CREATE TRIGGER trg_contrib_sync_status AFTER UPDATE OF status ON ai_review_items FOR EACH ROW EXECUTE FUNCTION contrib_sync_status();
  END IF;
END $$;

-- Porte des droits pour l'export SAKC: seules ces lignes peuvent sortir (le script d'export revérifie en Python).
CREATE OR REPLACE VIEW contributions_exportable AS
SELECT c.contribution_id, c.kind, c.language, c.source_text, c.body, c.body_sha256, c.license, c.attribution,
       c.consent_version, c.consent_at, c.provenance, c.created_at, i.item_id AS review_item_id,
       (SELECT COUNT(DISTINCT r.reviewer_id) FROM ai_reviews r WHERE r.item_id = i.item_id AND r.decision = 'accept'
                                                              AND r.reviewer_id <> c.contributor_id)::int AS distinct_accepts
FROM contributions c
JOIN ai_review_items i ON i.item_id = c.review_item_id
JOIN contribution_consent_texts t ON t.version = c.consent_version AND t.license = 'CC-BY-4.0'
WHERE c.status = 'approved' AND i.status = 'validated' AND c.license = 'CC-BY-4.0'
  AND c.consent_at IS NOT NULL AND (NOT c.is_minor OR c.parental_consent_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM contribution_reports p WHERE p.contribution_id = c.contribution_id AND p.status IN ('open','upheld'))
  AND (SELECT COUNT(DISTINCT r.reviewer_id) FROM ai_reviews r WHERE r.item_id = i.item_id AND r.decision = 'accept'
                                                              AND r.reviewer_id <> c.contributor_id) >= 2;
