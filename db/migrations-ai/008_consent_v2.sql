-- 008 — Phase E : nouvelle version du texte de consentement des contributions (contrib-v2).
-- STRICTEMENT ADDITIVE et idempotente : INSERT ... ON CONFLICT DO NOTHING. La ligne 'contrib-v1' n'est JAMAIS modifiée
-- (trigger trg_consent_texts_immutable de 006) : les contributions déjà soumises restent liées au texte qu'elles ont accepté.
-- Prérequis : 005 puis 006. Les nouvelles soumissions de la passerelle utilisent contrib-v2 dès que cette ligne existe.
INSERT INTO contribution_consent_texts(version, license, body) VALUES ('contrib-v2', 'CC-BY-4.0',
 'Je confirme être l''auteur de ce texte ou en détenir les droits, qu''il ne contient aucune donnée personnelle d''autrui, '
 'et je le place sous licence Creative Commons Attribution 4.0 International (CC BY 4.0), avec attribution au nom ou pseudonyme indiqué. '
 'SOLOB+ peut l''utiliser pour évaluer et entraîner SOLOB AI après double validation humaine. '
 'Je peux retirer ma contribution à tout moment : elle est alors exclue de tous les entraînements futurs. '
 'En revanche, une contribution déjà utilisée pour entraîner un modèle ne peut plus être retirée des modèles déjà entraînés '
 '(ses effets restent dans ces modèles), même si elle est retirée des entraînements futurs.')
ON CONFLICT (version) DO NOTHING;
