-- 009 : stories Must du lancement (additive, idempotente, aucune suppression).
-- S04 examens blancs · T01 parcours talent · C01 demandes client · C02 shortlists · P02 délai des demandes de suppression
-- FTS français (bibliothèque SAKC, missions) · RLS par espace sur les nouvelles tables (rôle applicatif solob_app).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'solob_app') THEN CREATE ROLE solob_app NOLOGIN; END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;  -- rôle global au cluster : création concurrente tolérée
END $$;
DO $$ BEGIN EXECUTE format('GRANT solob_app TO %I', current_user); EXCEPTION WHEN others THEN NULL; END $$;

-- ===== S04 : examens blancs (School, gratuit) =====
CREATE TABLE IF NOT EXISTS school_mock_exams (
  exam_id TEXT PRIMARY KEY,
  exam_code TEXT NOT NULL CHECK (exam_code IN ('BEPC','BAC','WAEC')),
  country TEXT NOT NULL, level TEXT NOT NULL, subject TEXT NOT NULL, title TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 1 AND 300),
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  questions JSONB NOT NULL,           -- [{"q":..., "choices":[...], "answer": index}] ; la clé "answer" n'est jamais envoyée au navigateur
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS school_exam_attempts (
  attempt_id TEXT PRIMARY KEY,
  exam_id TEXT NOT NULL REFERENCES school_mock_exams(exam_id),
  user_id TEXT NOT NULL REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deadline_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  answers JSONB,
  score INTEGER, max_score INTEGER,
  late BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS school_exam_attempts_user_idx ON school_exam_attempts(user_id, started_at DESC);
INSERT INTO school_mock_exams(exam_id, exam_code, country, level, subject, title, duration_minutes, verified, questions) VALUES
('exam_bepc_bj_math_pilote','BEPC','BJ','3e','Mathématiques','BEPC blanc — Mathématiques (pilote)',20,FALSE,
 '[{"q":"Combien vaut 3 × (4 + 2) ?","choices":["14","18","24","10"],"answer":1},
   {"q":"La solution de 2x + 6 = 0 est :","choices":["x = 3","x = -3","x = 6","x = -6"],"answer":1},
   {"q":"Le périmètre d’un carré de côté 5 cm est :","choices":["10 cm","20 cm","25 cm","15 cm"],"answer":1},
   {"q":"Quelle fraction est égale à 0,75 ?","choices":["1/4","2/3","3/4","7/5"],"answer":2},
   {"q":"Dans un triangle rectangle de côtés 3 et 4, l’hypoténuse mesure :","choices":["5","6","7","12"],"answer":0}]'::jsonb)
ON CONFLICT (exam_id) DO NOTHING;

-- ===== T01 : parcours talent (test → entretien IA → revue humaine → essai supervisé → badge) =====
CREATE TABLE IF NOT EXISTS talent_journeys (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  skills TEXT NOT NULL DEFAULT '',
  test_score INTEGER, test_passed_at TIMESTAMPTZ,
  interview_answer TEXT, interview_submitted_at TIMESTAMPTZ,
  review_status TEXT NOT NULL DEFAULT 'none' CHECK (review_status IN ('none','approved','rejected')),
  reviewer_id TEXT REFERENCES users(id), review_comment TEXT, reviewed_at TIMESTAMPTZ,
  trial_validator_id TEXT REFERENCES users(id), trial_validated_at TIMESTAMPTZ,
  badge_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION talent_journey_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.interview_submitted_at IS NOT NULL AND NEW.test_passed_at IS NULL THEN RAISE EXCEPTION 'STEP_ORDER: test non réussi'; END IF;
  IF NEW.review_status <> 'none' AND NEW.interview_submitted_at IS NULL THEN RAISE EXCEPTION 'STEP_ORDER: entretien manquant'; END IF;
  IF NEW.reviewer_id IS NOT NULL AND NEW.reviewer_id = NEW.user_id THEN RAISE EXCEPTION 'SELF_REVIEW: auto-revue interdite'; END IF;
  IF NEW.trial_validated_at IS NOT NULL AND NEW.review_status <> 'approved' THEN RAISE EXCEPTION 'STEP_ORDER: revue humaine non validée'; END IF;
  IF NEW.trial_validator_id IS NOT NULL AND NEW.trial_validator_id = NEW.user_id THEN RAISE EXCEPTION 'SELF_REVIEW: auto-validation interdite'; END IF;
  IF NEW.badge_at IS NOT NULL AND NEW.trial_validated_at IS NULL THEN RAISE EXCEPTION 'STEP_ORDER: essai supervisé non validé'; END IF;
  NEW.updated_at := NOW(); RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS talent_journey_order_trg ON talent_journeys;
CREATE TRIGGER talent_journey_order_trg BEFORE INSERT OR UPDATE ON talent_journeys FOR EACH ROW EXECUTE FUNCTION talent_journey_order();

-- ===== C01 : demande client + réservation d'appel de 15 min (sans calendrier externe) =====
CREATE TABLE IF NOT EXISTS client_requests (
  request_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES users(id),
  need TEXT NOT NULL CHECK (char_length(need) BETWEEN 10 AND 4000),
  skills TEXT NOT NULL DEFAULT '',
  call_at TIMESTAMPTZ NOT NULL,
  client_tz TEXT NOT NULL DEFAULT 'Africa/Porto-Novo',
  status TEXT NOT NULL DEFAULT 'call_booked' CHECK (status IN ('call_booked','shortlist_sent','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS client_requests_slot_uq ON client_requests(call_at) WHERE status = 'call_booked';
-- ===== C02 : shortlist de talents badgés uniquement =====
CREATE TABLE IF NOT EXISTS client_shortlists (
  request_id TEXT NOT NULL REFERENCES client_requests(request_id),
  talent_user_id TEXT NOT NULL REFERENCES users(id),
  added_by TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (request_id, talent_user_id)
);
CREATE OR REPLACE FUNCTION shortlist_badged_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM talent_journeys WHERE user_id = NEW.talent_user_id AND badge_at IS NOT NULL) THEN
    RAISE EXCEPTION 'NOT_BADGED: seul un talent badgé peut figurer dans une shortlist'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS shortlist_badged_only_trg ON client_shortlists;
CREATE TRIGGER shortlist_badged_only_trg BEFORE INSERT OR UPDATE ON client_shortlists FOR EACH ROW EXECUTE FUNCTION shortlist_badged_only();

-- ===== P02 : délai défini pour les demandes de suppression =====
ALTER TABLE privacy_requests ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;

-- ===== RLS par espace (rôle applicatif solob_app ; l'utilisateur courant est passé par app.user_id / app.staff) =====
GRANT USAGE ON SCHEMA public TO solob_app;
GRANT SELECT ON school_mock_exams TO solob_app;
GRANT SELECT, INSERT, UPDATE ON school_exam_attempts, talent_journeys, client_requests, client_shortlists TO solob_app;
ALTER TABLE school_exam_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_journeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_shortlists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_attempts ON school_exam_attempts;
CREATE POLICY own_attempts ON school_exam_attempts TO solob_app
  USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
DROP POLICY IF EXISTS journey_owner_or_staff ON talent_journeys;
CREATE POLICY journey_owner_or_staff ON talent_journeys TO solob_app
  USING (user_id = current_setting('app.user_id', true) OR current_setting('app.staff', true) = 'on')
  WITH CHECK (user_id = current_setting('app.user_id', true) OR current_setting('app.staff', true) = 'on');
DROP POLICY IF EXISTS request_owner_or_staff ON client_requests;
CREATE POLICY request_owner_or_staff ON client_requests TO solob_app
  USING (client_id = current_setting('app.user_id', true) OR current_setting('app.staff', true) = 'on')
  WITH CHECK (client_id = current_setting('app.user_id', true) OR current_setting('app.staff', true) = 'on');
DROP POLICY IF EXISTS shortlist_client_or_staff ON client_shortlists;
CREATE POLICY shortlist_client_or_staff ON client_shortlists TO solob_app
  USING (current_setting('app.staff', true) = 'on' OR EXISTS (SELECT 1 FROM client_requests r WHERE r.request_id = client_shortlists.request_id AND r.client_id = current_setting('app.user_id', true)))
  WITH CHECK (current_setting('app.staff', true) = 'on');
-- le trigger de shortlist lit talent_journeys sous RLS : il s'exécute avec les droits du propriétaire
ALTER FUNCTION shortlist_badged_only() SECURITY DEFINER;

-- ===== Recherche plein texte (configuration french) =====
CREATE INDEX IF NOT EXISTS sakc_resources_fts_idx ON sakc_resources USING GIN (to_tsvector('french', coalesce(title,'') || ' ' || discipline || ' ' || level));
CREATE INDEX IF NOT EXISTS business_projects_fts_idx ON business_projects USING GIN (to_tsvector('french', title));
CREATE INDEX IF NOT EXISTS client_requests_client_idx ON client_requests(client_id, created_at DESC);
