-- 011 (vague 4) : additive et idempotente. Requiert 010.
-- annotation_audio_sources contient les preuves de droits et les références de consentement des locuteurs :
-- accès complet réservé à l'équipe (app.staff = on) via RLS. Les annotatrices ne voient que titre, langue et licence
-- au travers de la vue annotation_sources_catalog (aucune preuve ni référence de consentement exposée).
ALTER TABLE annotation_audio_sources ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON annotation_audio_sources TO solob_app;
DROP POLICY IF EXISTS annotation_sources_staff ON annotation_audio_sources;
CREATE POLICY annotation_sources_staff ON annotation_audio_sources TO solob_app
  USING (current_setting('app.staff', true) = 'on')
  WITH CHECK (current_setting('app.staff', true) = 'on');
CREATE OR REPLACE VIEW annotation_sources_catalog AS
  SELECT source_id, title, language, license FROM annotation_audio_sources;
GRANT SELECT ON annotation_sources_catalog TO solob_app;
