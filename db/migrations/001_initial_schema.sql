-- ============================================================================
-- SOLOB+ Initial Relational Schema (PostgreSQL 16 Compatible)
-- Pillars: SOLOB Core, SOLOB School (Academic), SOLOB Business (Managed Talent)
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1. USERS & SESSIONS (SOLOB CORE)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'org_client', 'contributor', 'reviewer', 'operator', 'admin')),
  pillar TEXT NOT NULL CHECK (pillar IN ('school', 'business', 'core')),
  preferred_ui_lang TEXT NOT NULL DEFAULT 'fr' CHECK (preferred_ui_lang IN ('fr', 'en')),
  country_code TEXT NOT NULL DEFAULT 'BJ',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  privacy_retention_days INTEGER NOT NULL DEFAULT 365,
  marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
  voice_data_consent BOOLEAN NOT NULL DEFAULT FALSE,
  linguistic_data_consent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_pillar ON users(pillar);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);

-- 2. LANGUAGES & DIALECTS REGISTRY
CREATE TABLE IF NOT EXISTS languages_registry (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  native_name TEXT NOT NULL,
  region TEXT NOT NULL,
  dialects_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  school_verified BOOLEAN NOT NULL DEFAULT FALSE,
  business_verified BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. SOLOB SCHOOL: CURRICULA, LEVELS, SUBJECTS & ACADEMIC PROFILES
CREATE TABLE IF NOT EXISTS academic_curricula (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  education_system TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS academic_levels (
  id TEXT PRIMARY KEY,
  curriculum_id TEXT NOT NULL REFERENCES academic_curricula(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  stage_order INTEGER NOT NULL DEFAULT 1,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(curriculum_id, code)
);

CREATE TABLE IF NOT EXISTS academic_subjects (
  id TEXT PRIMARY KEY,
  curriculum_id TEXT NOT NULL REFERENCES academic_curricula(id) ON DELETE CASCADE,
  level_id TEXT REFERENCES academic_levels(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(curriculum_id, code)
);

CREATE TABLE IF NOT EXISTS academic_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  profile_type TEXT NOT NULL CHECK (profile_type IN ('student', 'teacher')),
  country TEXT NOT NULL,
  curriculum_id TEXT REFERENCES academic_curricula(id) ON DELETE SET NULL,
  level_id TEXT REFERENCES academic_levels(id) ON DELETE SET NULL,
  primary_subject_id TEXT REFERENCES academic_subjects(id) ON DELETE SET NULL,
  institution_name TEXT,
  learning_goals TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. PRIVATE OBJECT STORAGE METADATA
CREATE TABLE IF NOT EXISTS stored_files (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pillar TEXT NOT NULL CHECK (pillar IN ('school', 'business', 'core')),
  original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256_checksum TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'assigned_task', 'curriculum_resource')),
  project_id TEXT,
  task_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stored_files_owner ON stored_files(owner_user_id);

-- 5. SOLOB SCHOOL: DOCUMENTS, STUDY MATERIALS, EXERCISES, SUBMISSIONS & ACTIVITY
CREATE TABLE IF NOT EXISTS school_documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES stored_files(id) ON DELETE CASCADE,
  curriculum_id TEXT REFERENCES academic_curricula(id) ON DELETE SET NULL,
  subject_id TEXT REFERENCES academic_subjects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  extracted_text TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'PROCESSED' CHECK (processing_status IN ('PENDING', 'PROCESSED', 'FAILED')),
  word_count INTEGER NOT NULL DEFAULT 0,
  is_teacher_resource BOOLEAN NOT NULL DEFAULT FALSE,
  verified_source BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_school_documents_user ON school_documents(user_id);

CREATE TABLE IF NOT EXISTS school_study_materials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES school_documents(id) ON DELETE SET NULL,
  subject_id TEXT REFERENCES academic_subjects(id) ON DELETE SET NULL,
  material_type TEXT NOT NULL CHECK (material_type IN ('EXPLANATION', 'SUMMARY', 'FLASHCARDS', 'QUIZ', 'EXAM_PREP', 'FACT_CHECK', 'TEACHER_ASSESSMENT')),
  title TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  content_json JSONB NOT NULL,
  grounding_sources_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  uncertainty_level TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (uncertainty_level IN ('LOW', 'MEDIUM', 'HIGH')),
  ai_mode TEXT NOT NULL CHECK (ai_mode IN ('LIVE', 'MOCK_DEMO')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_school_study_materials_user ON school_study_materials(user_id);

CREATE TABLE IF NOT EXISTS school_exercises (
  id TEXT PRIMARY KEY,
  creator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES school_documents(id) ON DELETE SET NULL,
  subject_id TEXT REFERENCES academic_subjects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  difficulty TEXT NOT NULL DEFAULT 'INTERMEDIATE' CHECK (difficulty IN ('FOUNDATION', 'INTERMEDIATE', 'EXAM_LEVEL')),
  questions_json JSONB NOT NULL,
  marking_criteria_json JSONB NOT NULL,
  max_score NUMERIC(6,2) NOT NULL DEFAULT 20.00,
  ai_mode TEXT NOT NULL CHECK (ai_mode IN ('LIVE', 'MOCK_DEMO')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS school_exercise_submissions (
  id TEXT PRIMARY KEY,
  exercise_id TEXT NOT NULL REFERENCES school_exercises(id) ON DELETE CASCADE,
  student_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers_json JSONB NOT NULL,
  score NUMERIC(6,2) NOT NULL,
  max_score NUMERIC(6,2) NOT NULL,
  percentage NUMERIC(5,2) NOT NULL,
  corrections_json JSONB NOT NULL,
  overall_feedback TEXT NOT NULL,
  uncertainty_note TEXT NOT NULL,
  ai_mode TEXT NOT NULL CHECK (ai_mode IN ('LIVE', 'MOCK_DEMO')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_school_submissions_student ON school_exercise_submissions(student_user_id);

CREATE TABLE IF NOT EXISTS school_learning_activities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL,
  subject_id TEXT REFERENCES academic_subjects(id) ON DELETE SET NULL,
  reference_id TEXT,
  summary TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  progress_delta NUMERIC(5,2) NOT NULL DEFAULT 0,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_school_activities_user ON school_learning_activities(user_id);

-- 6. SOLOB BUSINESS: ORGANIZATIONS & MANAGED PROJECTS
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  industry TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  billing_currency TEXT NOT NULL DEFAULT 'USD',
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  service_mode TEXT NOT NULL CHECK (service_mode IN ('MANAGED_PROJECT', 'QUALIFIED_TALENT_PROVISION')),
  service_category TEXT NOT NULL CHECK (service_category IN (
    'AFRICAN_LANG_TRANSCRIPTION_ANNOTATION',
    'TRANSLATION_LINGUISTIC_VALIDATION',
    'MULTILINGUAL_DATA_PREP',
    'AI_EVALUATION_MODEL_TESTING',
    'EXPERT_DATA_ANNOTATION_QA',
    'SPECIALIZED_AI_PROJECT_TEAM'
  )),
  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN (
    'DRAFT',
    'SUBMITTED',
    'UNDER_REVIEW',
    'APPROVED_ACTIVE',
    'IN_EXECUTION',
    'QA_REVIEW',
    'DELIVERED',
    'CLOSED',
    'REJECTED'
  )),
  description TEXT NOT NULL,
  deliverables_spec TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  target_languages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_dialects_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  budget_amount_cents BIGINT NOT NULL CHECK (budget_amount_cents >= 0),
  estimated_cost_cents BIGINT NOT NULL DEFAULT 0 CHECK (estimated_cost_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  deadline_date TEXT,
  operator_notes TEXT,
  reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_projects_client ON business_projects(client_user_id);
CREATE INDEX IF NOT EXISTS idx_business_projects_status ON business_projects(status);

-- 7. SOLOB BUSINESS: TALENT PROFILES & VERIFIED ASSESSMENTS
CREATE TABLE IF NOT EXISTS talent_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  headline TEXT NOT NULL,
  country TEXT NOT NULL,
  native_languages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  dialects_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  skills_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  work_samples_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  availability_hours_per_week INTEGER NOT NULL DEFAULT 20,
  availability_status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (availability_status IN ('AVAILABLE', 'PARTIALLY_AVAILABLE', 'UNAVAILABLE')),
  consent_voice_dataset BOOLEAN NOT NULL DEFAULT FALSE,
  consent_linguistic_corpus BOOLEAN NOT NULL DEFAULT FALSE,
  consent_signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS talent_assessments (
  id TEXT PRIMARY KEY,
  talent_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assessment_type TEXT NOT NULL CHECK (assessment_type IN ('LANGUAGE_PROFICIENCY', 'DOMAIN_SKILL', 'ANNOTATION_QA')),
  language_code TEXT,
  dialect TEXT,
  skill_name TEXT NOT NULL,
  score NUMERIC(5,2) NOT NULL,
  passing_score NUMERIC(5,2) NOT NULL DEFAULT 75.00,
  passed BOOLEAN NOT NULL,
  verified_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_talent_assessments_user ON talent_assessments(talent_user_id);

-- 8. SOLOB BUSINESS: TEAMS, ASSIGNMENTS, TASKS, SUBMISSIONS & QA REVIEWS
CREATE TABLE IF NOT EXISTS project_teams (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES business_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lead_operator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES project_teams(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES business_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL CHECK (member_role IN ('CONTRIBUTOR', 'REVIEWER', 'PROJECT_MANAGER')),
  match_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  match_explanation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  assigned_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, user_id, member_role)
);

CREATE TABLE IF NOT EXISTS business_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES business_projects(id) ON DELETE CASCADE,
  assigned_contributor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  language_code TEXT NOT NULL,
  dialect TEXT,
  source_file_id TEXT REFERENCES stored_files(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ASSIGNED', 'SUBMITTED', 'REVISION_REQUESTED', 'APPROVED', 'REJECTED')),
  compensation_cents BIGINT NOT NULL DEFAULT 0 CHECK (compensation_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  due_date TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_tasks_project ON business_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_business_tasks_contributor ON business_tasks(assigned_contributor_id);

CREATE TABLE IF NOT EXISTS task_submissions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES business_tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES business_projects(id) ON DELETE CASCADE,
  contributor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL DEFAULT 1,
  content_text TEXT NOT NULL,
  structured_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  language_code TEXT NOT NULL,
  dialect TEXT,
  attachment_file_id TEXT REFERENCES stored_files(id) ON DELETE SET NULL,
  contributor_notes TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_submissions_task ON task_submissions(task_id);

CREATE TABLE IF NOT EXISTS task_reviews (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES task_submissions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES business_tasks(id) ON DELETE CASCADE,
  reviewer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE', 'REQUEST_REVISION', 'REJECT')),
  quality_score NUMERIC(5,2) NOT NULL CHECK (quality_score >= 0 AND quality_score <= 100),
  accuracy_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  linguistic_fidelity_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  disagreement_flag BOOLEAN NOT NULL DEFAULT FALSE,
  disagreement_resolution_notes TEXT,
  feedback TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. SOLOB BUSINESS: DELIVERY REPORTS & COMPENSATION RECORDS
CREATE TABLE IF NOT EXISTS delivery_reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES business_projects(id) ON DELETE CASCADE,
  prepared_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  executive_summary TEXT NOT NULL,
  deliverables_summary_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  quality_metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_tasks_approved INTEGER NOT NULL DEFAULT 0,
  average_quality_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  client_authorized BOOLEAN NOT NULL DEFAULT TRUE,
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compensation_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES business_projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE REFERENCES business_tasks(id) ON DELETE CASCADE,
  contributor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING', 'APPROVED', 'READY_FOR_PAYOUT', 'PAID_SIMULATED', 'HELD')),
  provider_mode TEXT NOT NULL DEFAULT 'DISABLED_NO_LIVE_TRANSFER' CHECK (provider_mode IN ('DISABLED_NO_LIVE_TRANSFER', 'SANDBOX_SIMULATED')),
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  audit_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compensation_contributor ON compensation_records(contributor_user_id);

-- 10. SOLOB CORE: NOTIFICATIONS, AUDIT EVENTS, AI USAGE, FEATURE FLAGS & PRIVACY
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link_path TEXT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT,
  pillar TEXT NOT NULL CHECK (pillar IN ('school', 'business', 'core')),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'DENIED', 'ERROR')),
  redacted_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS ai_usage_records (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  pillar TEXT NOT NULL CHECK (pillar IN ('school', 'business', 'core')),
  operation TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  is_mock BOOLEAN NOT NULL DEFAULT TRUE,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FALLBACK_MOCK', 'ERROR', 'RATE_LIMITED')),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  pillar TEXT NOT NULL CHECK (pillar IN ('school', 'business', 'core')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS privacy_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL CHECK (request_type IN ('DATA_EXPORT', 'ACCOUNT_DELETION_REQUEST', 'CONSENT_UPDATE')),
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'PENDING_REVIEW')),
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
