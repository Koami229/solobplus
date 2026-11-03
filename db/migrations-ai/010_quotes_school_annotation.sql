-- 010 : vague 3 (additive, idempotente, aucune suppression ni modification de données existantes).
-- Business : demandes de devis (tarification « sur devis », pas de grille publique) · S06 validation des contenus
-- en langues africaines · T05 annotation audio (droits + consentement, second relecteur) · A01 journal des refus d'import SAKC.
-- Toutes les nouvelles tables sont sous RLS pour le rôle applicatif solob_app (créé par 009).

-- ===== Business : demande de devis depuis l'espace Entreprise =====
CREATE TABLE IF NOT EXISTS business_quote_requests (
  quote_id   TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES users(id),
  need       TEXT NOT NULL CHECK (char_length(need) BETWEEN 10 AND 4000),
  volume     TEXT NOT NULL CHECK (char_length(volume) BETWEEN 1 AND 300),
  languages  TEXT NOT NULL CHECK (char_length(languages) BETWEEN 1 AND 300),
  deadline   DATE NOT NULL,
  status     TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','in_review','quote_sent','accepted','declined','closed')),
  staff_note TEXT NOT NULL DEFAULT '' CHECK (char_length(staff_note) <= 2000),
  handled_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS business_quote_requests_client_idx ON business_quote_requests(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS business_quote_requests_status_idx ON business_quote_requests(status, created_at);
GRANT SELECT, INSERT, UPDATE ON business_quote_requests TO solob_app;
ALTER TABLE business_quote_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quote_owner_or_staff ON business_quote_requests;
CREATE POLICY quote_owner_or_staff ON business_quote_requests TO solob_app
  USING (client_id = current_setting('app.user_id', true) OR current_setting('app.staff', true) = 'on')
  WITH CHECK (client_id = current_setting('app.user_id', true) OR current_setting('app.staff', true) = 'on');
-- un client ne peut changer que ses propres champs à la création ; le statut est réservé à l'équipe (trigger)
CREATE OR REPLACE FUNCTION quote_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'submitted' THEN RAISE EXCEPTION 'QUOTE_STATUS: une demande démarre à submitted'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND coalesce(current_setting('app.staff', true), 'off') <> 'on'
     AND current_user = 'solob_app' THEN RAISE EXCEPTION 'QUOTE_STATUS: statut réservé à l''équipe SOLOB'; END IF;
  NEW.updated_at := NOW(); RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS quote_status_guard_trg ON business_quote_requests;
CREATE TRIGGER quote_status_guard_trg BEFORE INSERT OR UPDATE ON business_quote_requests FOR EACH ROW EXECUTE FUNCTION quote_status_guard();

-- ===== S06 : contenus School en langue africaine, visibles seulement après validation par un spécialiste =====
CREATE TABLE IF NOT EXISTS school_language_contents (
  content_id     TEXT PRIMARY KEY,
  author_id      TEXT NOT NULL REFERENCES users(id),
  language       TEXT NOT NULL CHECK (language ~ '^[a-z]{2,3}$'),
  level_id       TEXT,
  title          TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  body           TEXT NOT NULL CHECK (char_length(body) BETWEEN 10 AND 20000),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validated','rejected')),
  validator_id   TEXT REFERENCES users(id),
  validated_at   TIMESTAMPTZ,
  review_comment TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status <> 'validated' OR (validator_id IS NOT NULL AND validated_at IS NOT NULL)),
  CHECK (status <> 'rejected' OR (validator_id IS NOT NULL AND char_length(review_comment) > 0))
);
CREATE INDEX IF NOT EXISTS school_language_contents_pub_idx ON school_language_contents(language, status);
CREATE OR REPLACE FUNCTION language_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.validator_id IS NOT NULL AND NEW.validator_id = NEW.author_id THEN RAISE EXCEPTION 'SELF_REVIEW: l''auteur ne peut pas valider son contenu'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.body IS DISTINCT FROM OLD.body AND NEW.status = 'validated' THEN
    RAISE EXCEPTION 'STEP_ORDER: un contenu modifié doit être revalidé'; END IF;
  NEW.updated_at := NOW(); RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS language_content_guard_trg ON school_language_contents;
CREATE TRIGGER language_content_guard_trg BEFORE INSERT OR UPDATE ON school_language_contents FOR EACH ROW EXECUTE FUNCTION language_content_guard();

-- ===== T05 : annotation audio (transcription + traduction) =====
CREATE TABLE IF NOT EXISTS annotation_audio_sources (
  source_id          TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  language           TEXT NOT NULL,
  license            TEXT NOT NULL,
  rights_proof       TEXT NOT NULL CHECK (char_length(rights_proof) > 0),
  speaker_consent_ref TEXT NOT NULL CHECK (char_length(speaker_consent_ref) > 0),
  consent_recorded_at TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS annotation_tasks (
  task_id       TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES annotation_audio_sources(source_id),
  segment_start_ms INTEGER NOT NULL CHECK (segment_start_ms >= 0),
  segment_end_ms   INTEGER NOT NULL,
  author_id     TEXT REFERENCES users(id),
  transcription TEXT,
  translation_fr TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','to_review','validated','rejected','delivered')),
  submitted_at  TIMESTAMPTZ,
  reviewer_id   TEXT REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ,
  review_comment TEXT NOT NULL DEFAULT '',
  delivered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (segment_end_ms > segment_start_ms)
);
CREATE INDEX IF NOT EXISTS annotation_tasks_status_idx ON annotation_tasks(status, created_at);
CREATE OR REPLACE FUNCTION annotation_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'to_review' AND (NEW.author_id IS NULL OR coalesce(NEW.transcription,'') = '' OR coalesce(NEW.translation_fr,'') = '') THEN
    RAISE EXCEPTION 'STEP_ORDER: transcription et traduction requises'; END IF;
  IF NEW.reviewer_id IS NOT NULL AND NEW.reviewer_id = NEW.author_id THEN RAISE EXCEPTION 'SELF_REVIEW: un second relecteur différent de l''auteur est requis'; END IF;
  IF NEW.status IN ('validated','rejected') AND (NEW.reviewer_id IS NULL OR NEW.submitted_at IS NULL) THEN RAISE EXCEPTION 'STEP_ORDER: relecture sans soumission'; END IF;
  IF NEW.status = 'delivered' AND (TG_OP = 'INSERT' OR OLD.status <> 'validated') THEN RAISE EXCEPTION 'STEP_ORDER: livraison sans validation du second relecteur'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS annotation_task_guard_trg ON annotation_tasks;
CREATE TRIGGER annotation_task_guard_trg BEFORE INSERT OR UPDATE ON annotation_tasks FOR EACH ROW EXECUTE FUNCTION annotation_task_guard();

GRANT SELECT, INSERT, UPDATE ON school_language_contents, annotation_tasks TO solob_app;
GRANT SELECT ON annotation_audio_sources TO solob_app;
ALTER TABLE school_language_contents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lang_content_visibility ON school_language_contents;
-- élèves : uniquement le validé ; auteur : ses contenus ; spécialistes/équipe : tout
CREATE POLICY lang_content_visibility ON school_language_contents TO solob_app
  USING (status = 'validated' OR author_id = current_setting('app.user_id', true) OR current_setting('app.staff', true) = 'on')
  WITH CHECK (author_id = current_setting('app.user_id', true) OR current_setting('app.staff', true) = 'on');
ALTER TABLE annotation_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS annotation_tasks_access ON annotation_tasks;
CREATE POLICY annotation_tasks_access ON annotation_tasks TO solob_app
  USING (status = 'open' OR author_id = current_setting('app.user_id', true) OR current_setting('app.staff', true) = 'on')
  WITH CHECK (author_id = current_setting('app.user_id', true) OR current_setting('app.staff', true) = 'on');

-- ===== A01 : refus d'import SAKC journalisés en base (append-only) =====
CREATE TABLE IF NOT EXISTS sakc_import_refusals (
  id          BIGSERIAL PRIMARY KEY,
  resource_id TEXT NOT NULL,
  url         TEXT NOT NULL DEFAULT '',
  rights_status TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION sakc_refusals_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'sakc_import_refusals est en ajout seul'; END $$;
DROP TRIGGER IF EXISTS sakc_refusals_append_only_trg ON sakc_import_refusals;
CREATE TRIGGER sakc_refusals_append_only_trg BEFORE UPDATE OR DELETE ON sakc_import_refusals FOR EACH ROW EXECUTE FUNCTION sakc_refusals_append_only();
