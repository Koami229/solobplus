-- Demandes publiques du site (devis et candidatures). Additive, idempotente.
-- Le message reste en base pour que l'équipe réponde. Aucun prix, aucun paiement.

CREATE TABLE IF NOT EXISTS public_inquiries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('quote', 'talent')),
  service TEXT NOT NULL CHECK (char_length(service) BETWEEN 2 AND 40),
  full_name TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 120),
  email TEXT NOT NULL CHECK (char_length(email) BETWEEN 6 AND 200),
  organization TEXT NOT NULL DEFAULT '' CHECK (char_length(organization) <= 160),
  availability TEXT NOT NULL DEFAULT '' CHECK (char_length(availability) <= 40),
  skills TEXT NOT NULL DEFAULT '' CHECK (char_length(skills) <= 500),
  languages TEXT NOT NULL DEFAULT '' CHECK (char_length(languages) <= 200),
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 10 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_public_inquiries_created ON public_inquiries (created_at DESC);
