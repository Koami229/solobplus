'use client';

import React, { useState, useEffect } from 'react';
import {
  BookOpen,
  Upload,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  FileText,
  GraduationCap,
  CheckSquare,
  History,
  ShieldAlert,
} from 'lucide-react';

interface SchoolViewProps {
  user: any;
  sessionToken: string | null;
  notify: (msg: string, type?: 'success' | 'error') => void;
}

export function SchoolView({ user, sessionToken, notify }: SchoolViewProps) {
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<any>({ curricula: [], levels: [], subjects: [], languages: [] });
  const [workspace, setWorkspace] = useState<any>(null);
  const [subTab, setSubTab] = useState<'profile' | 'library' | 'tutor' | 'exercises' | 'history'>('profile');

  // Profile form state
  const [country, setCountry] = useState('BJ');
  const [curriculumId, setCurriculumId] = useState('cur_bj_bac');
  const [levelId, setLevelId] = useState('lvl_bj_tle_cd');
  const [subjectId, setSubjectId] = useState('sub_bj_svt');
  const [institutionName, setInstitutionName] = useState('');
  const [learningGoals, setLearningGoals] = useState('');

  // Document upload state
  const [docTitle, setDocTitle] = useState('');
  const [docFileName, setDocFileName] = useState('notes_cours_svt.txt');
  const [docContent, setDocContent] = useState('');
  const [isTeacherResource, setIsTeacherResource] = useState(false);

  // AI Tutor state
  const [selectedDocId, setSelectedDocId] = useState('');
  const [question, setQuestion] = useState('');
  const [latestExplanation, setLatestExplanation] = useState<any>(null);

  // Exercise generator & submission state
  const [genTitle, setGenTitle] = useState('');
  const [genDifficulty, setGenDifficulty] = useState<'FOUNDATION' | 'INTERMEDIATE' | 'EXAM_LEVEL'>('EXAM_LEVEL');
  const [genMaterialType, setGenMaterialType] = useState<'SUMMARY' | 'FLASHCARDS' | 'QUIZ' | 'EXAM_PREP' | 'FACT_CHECK'>('EXAM_PREP');
  const [activeExerciseId, setActiveExerciseId] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [latestCorrection, setLatestCorrection] = useState<any>(null);

  const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
  };

  const fetchSchoolData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/school', { headers: authHeaders });
      const data = await res.json();
      if (data.ok) {
        setCatalog(data.catalog);
        setWorkspace(data.workspace);
        if (data.workspace?.profile) {
          setCountry(data.workspace.profile.country || 'BJ');
          setCurriculumId(data.workspace.profile.curriculum_id || 'cur_bj_bac');
          setLevelId(data.workspace.profile.level_id || 'lvl_bj_tle_cd');
          setSubjectId(data.workspace.profile.primary_subject_id || 'sub_bj_svt');
          setInstitutionName(data.workspace.profile.institution_name || '');
          setLearningGoals(data.workspace.profile.learning_goals || '');
        }
        if (data.workspace?.documents?.length > 0 && !selectedDocId) {
          setSelectedDocId(data.workspace.documents[0].id);
        }
        if (data.workspace?.exercises?.length > 0 && !activeExerciseId) {
          setActiveExerciseId(data.workspace.exercises[0].id);
        }
      }
    } catch (err: any) {
      notify(err.message || 'Erreur lors du chargement de SOLOB School', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSchoolData();
  }, [sessionToken]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/school', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          action: 'upsert_profile',
          country,
          curriculumId,
          levelId,
          primarySubjectId: subjectId,
          institutionName,
          learningGoals,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Échec de sauvegarde');
      notify('Profil académique enregistré avec succès !');
      fetchSchoolData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleUploadDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/school', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          action: 'upload_document',
          title: docTitle,
          originalFileName: docFileName,
          mimeType: 'text/plain',
          content: docContent,
          curriculumId,
          subjectId,
          isTeacherResource,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Échec du téléversement');
      notify(`Document "${data.document.title}" validé et extrait (${data.document.word_count} mots).`);
      setDocTitle('');
      setDocContent('');
      setSelectedDocId(data.document.id);
      fetchSchoolData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleAskTutor = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/school', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          action: 'explain_grounded',
          documentId: selectedDocId || null,
          subjectId,
          question,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur lors de la requête IA');
      setLatestExplanation(data.aiResult);
      notify('Explication académique générée et ancrée dans les sources.');
      fetchSchoolData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleGenerateExercise = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/school', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          action: 'generate_revision_exercise',
          documentId: selectedDocId || null,
          subjectId,
          title: genTitle || 'Synthèse & Exercice de révision',
          difficulty: genDifficulty,
          materialType: genMaterialType,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur de génération');
      setActiveExerciseId(data.exercise.id);
      setGenTitle('');
      notify('Fiche de révision et exercice générés avec succès !');
      fetchSchoolData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleSubmitExercise = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/school', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          action: 'submit_exercise',
          exerciseId: activeExerciseId,
          answers,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur de soumission');
      setLatestCorrection(data.submission);
      notify(`Exercice corrigé : ${data.submission.score}/${data.submission.max_score} (${data.submission.percentage}%)`);
      fetchSchoolData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const activeExercise = workspace?.exercises?.find((ex: any) => ex.id === activeExerciseId);

  return (
    <div className="space-y-6">
      {/* Pillar Header Banner */}
      <div className="bg-emerald-950 text-white rounded-2xl p-6 shadow-md border border-emerald-800">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-800/80 text-emerald-200 text-xs font-semibold mb-2">
              <GraduationCap className="w-4 h-4" />
              SOLOB SCHOOL — APPRENTISSAGE ACADÉMIQUE UNIQUEMENT
            </div>
            <h2 className="text-2xl font-bold">Espace Académique Élève, Étudiant & Enseignant</h2>
            <p className="text-emerald-200 text-sm mt-1">
              Programmes configurables (Bénin BAC/BEPC, WAEC, UEMOA). IA explicable avec ancrage documentaire, indicateur d&apos;incertitude et zéro citation inventée.
            </p>
          </div>
          {workspace?.progressSummary && (
            <div className="grid grid-cols-3 gap-3 bg-emerald-900/60 p-3 rounded-xl border border-emerald-700/60 text-center">
              <div>
                <div className="text-xl font-bold text-emerald-300">{workspace.progressSummary.documentsUploaded}</div>
                <div className="text-[11px] text-emerald-200">Cours Extraits</div>
              </div>
              <div>
                <div className="text-xl font-bold text-emerald-300">{workspace.progressSummary.exercisesCompleted}</div>
                <div className="text-[11px] text-emerald-200">Copies Corrigées</div>
              </div>
              <div>
                <div className="text-xl font-bold text-emerald-300">{workspace.progressSummary.averageScorePercentage}%</div>
                <div className="text-[11px] text-emerald-200">Moyenne</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Role Access Warning if Business user tries to view School */}
      {(!user || !['student', 'teacher', 'admin'].includes(user.role)) && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 flex items-start gap-3 text-amber-900">
          <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold">Séparation stricte des permissions School / Business</p>
            <p className="mt-1">
              Vous êtes actuellement connecté avec le rôle <strong>{user?.role || 'Visiteur non connecté'}</strong>. Seuls les rôles <code>student</code>, <code>teacher</code> et <code>admin</code> sont autorisés par le serveur à enregistrer des activités académiques dans SOLOB School. Utilisez le sélecteur de compte en haut pour basculer sur un profil Élève ou Enseignant.
            </p>
          </div>
        </div>
      )}

      {/* Sub-navigation */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">
        {[
          { id: 'profile', label: '1. Profil & Programme', icon: GraduationCap },
          { id: 'library', label: '2. Bibliothèque & Upload Document', icon: Upload },
          { id: 'tutor', label: '3. Tuteur IA Ancré & Fact-Check', icon: Sparkles },
          { id: 'exercises', label: '4. Révisions, Exercices & Corrections', icon: CheckSquare },
          { id: 'history', label: '5. Historique & Progression', icon: History },
        ].map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id as any)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                subTab === t.id
                  ? 'bg-emerald-700 text-white shadow-sm'
                  : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="p-8 text-center text-slate-500 bg-white rounded-xl border border-slate-200">
          Chargement des données académiques SOLOB School...
        </div>
      ) : (
        <>
          {/* TAB 1: PROFILE & CURRICULUM */}
          {subTab === 'profile' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <form onSubmit={handleSaveProfile} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <GraduationCap className="w-5 h-5 text-emerald-600" />
                  Configurer mon Profil Académique
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Pays</label>
                    <select
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      <option value="BJ">Bénin (BJ)</option>
                      <option value="NG">Nigéria (NG)</option>
                      <option value="SN">Sénégal (SN)</option>
                      <option value="TG">Togo (TG)</option>
                      <option value="CI">Côte d&apos;Ivoire (CI)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Établissement Scolaire / Université</label>
                    <input
                      type="text"
                      value={institutionName}
                      onChange={(e) => setInstitutionName(e.target.value)}
                      placeholder="Ex: CEG Gbégamey / UAC"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Programme Officiel (Curriculum)</label>
                  <select
                    value={curriculumId}
                    onChange={(e) => setCurriculumId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {catalog.curricula.map((c: any) => (
                      <option key={c.id} value={c.id}>
                        {c.name} {c.verified ? '✓ [VÉRIFIÉ]' : '⚠ [NON VÉRIFIÉ]'}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Classe / Niveau</label>
                    <select
                      value={levelId}
                      onChange={(e) => setLevelId(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      {catalog.levels.map((l: any) => (
                        <option key={l.id} value={l.id}>
                          {l.name} {l.verified ? '(Vérifié)' : '(Non vérifié)'}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Matière Principale</label>
                    <select
                      value={subjectId}
                      onChange={(e) => setSubjectId(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      {catalog.subjects.map((s: any) => (
                        <option key={s.id} value={s.id}>
                          {s.name} {s.verified ? '✓' : '⚠ (Non vérifié)'}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Objectifs d&apos;étude et d&apos;examen</label>
                  <textarea
                    rows={3}
                    value={learningGoals}
                    onChange={(e) => setLearningGoals(e.target.value)}
                    placeholder="Ex: Maîtriser la synthèse des protéines et réussir l'épreuve de SVT du BAC D..."
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                >
                  Enregistrer le Profil Académique
                </button>
              </form>

              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900">État de Couverture des Programmes & Langues</h3>
                <p className="text-xs text-slate-600">
                  Conformément à la charte SOLOB+, nous ne prétendons jamais couvrir tous les programmes africains sans vérification. Tout programme non validé est clairement signalé.
                </p>
                <div className="space-y-3">
                  {catalog.curricula.map((c: any) => (
                    <div key={c.id} className="p-3 rounded-lg border border-slate-200 bg-slate-50 flex items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold text-sm text-slate-900">{c.name}</div>
                        <div className="text-xs text-slate-600 mt-0.5">{c.description}</div>
                      </div>
                      <span
                        className={`shrink-0 px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                          c.verified
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                            : 'bg-amber-100 text-amber-800 border border-amber-300'
                        }`}
                      >
                        {c.verified ? 'VÉRIFIÉ' : 'NON VÉRIFIÉ'}
                      </span>
                    </div>
                  ))}
                </div>

                {workspace?.profile && (
                  <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 mt-4">
                    <div className="text-xs font-bold uppercase text-emerald-800">Profil Actif Enregistré</div>
                    <div className="text-sm font-semibold text-slate-900 mt-1">
                      {workspace.profile.curriculum_name} — {workspace.profile.level_name}
                    </div>
                    <div className="text-xs text-slate-700 mt-1">
                      Matière : <strong>{workspace.profile.subject_name}</strong> | Établissement :{' '}
                      {workspace.profile.institution_name || 'Non spécifié'}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: LIBRARY & UPLOAD */}
          {subTab === 'library' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <form onSubmit={handleUploadDocument} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <Upload className="w-5 h-5 text-emerald-600" />
                  Téléverser & Extraire un Document de Cours Autorisé
                </h3>
                <p className="text-xs text-slate-600">
                  Stockage privé sécurisé avec contrôle MIME, taille maximale et somme de contrôle SHA-256.
                </p>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Titre du Document Académique</label>
                  <input
                    type="text"
                    required
                    value={docTitle}
                    onChange={(e) => setDocTitle(e.target.value)}
                    placeholder="Ex: Cours de Génétique — Transcription et Traduction (Terminale D)"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Nom de fichier (.txt, .md)</label>
                  <input
                    type="text"
                    required
                    value={docFileName}
                    onChange={(e) => setDocFileName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Contenu textuel du document (extrait pour l&apos;ancrage des réponses IA)
                  </label>
                  <textarea
                    rows={6}
                    required
                    value={docContent}
                    onChange={(e) => setDocContent(e.target.value)}
                    placeholder="Collez ici le texte de votre support de cours officiel ou fiche de révision..."
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                {(user?.role === 'teacher' || user?.role === 'admin') && (
                  <label className="flex items-center gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={isTeacherResource}
                      onChange={(e) => setIsTeacherResource(e.target.checked)}
                    />
                    Publier comme ressource pédagogique vérifiée par l&apos;enseignant pour la bibliothèque
                  </label>
                )}
                <button
                  type="submit"
                  className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                >
                  Valider, Stocker et Extraire le Document
                </button>
              </form>

              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <BookOpen className="w-5 h-5 text-emerald-600" />
                  Bibliothèque Éducative ({workspace?.documents?.length || 0} documents)
                </h3>
                <div className="space-y-3 max-h-[460px] overflow-y-auto">
                  {workspace?.documents?.map((doc: any) => (
                    <div key={doc.id} className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-semibold text-sm text-slate-900">{doc.title}</div>
                        <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[11px] font-semibold">
                          {doc.word_count} mots • {doc.processing_status}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 line-clamp-3">{doc.extracted_text}</p>
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-[11px] text-slate-500">ID: {doc.id}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDocId(doc.id);
                            setSubTab('tutor');
                          }}
                          className="text-xs font-semibold text-emerald-700 hover:underline"
                        >
                          Étudier avec le Tuteur IA →
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: GROUNDED AI TUTOR & FACT-CHECK INSPECTOR */}
          {subTab === 'tutor' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <form onSubmit={handleAskTutor} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-emerald-600" />
                  Tuteur Académique IA Ancré & Vérificateur de Sources
                </h3>
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                  <strong>Principe d&apos;infaillibilité zéro :</strong> Le tuteur SOLOB School indique toujours son mode (<code>LIVE</code> ou <code>MOCK_DEMO</code>), cite les passages exacts de votre document et affiche le niveau d&apos;incertitude épistémique.
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Document de référence pour l&apos;ancrage (Grounding)
                  </label>
                  <select
                    value={selectedDocId}
                    onChange={(e) => setSelectedDocId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">-- Sans document (Incertitude Élevée signalée) --</option>
                    {workspace?.documents?.map((d: any) => (
                      <option key={d.id} value={d.id}>
                        {d.title} ({d.word_count} mots)
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Votre question académique ou affirmation à vérifier
                  </label>
                  <textarea
                    rows={4}
                    required
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="Ex: Expliquez le rôle de l'ARN messager et des ribosomes lors de la synthèse des protéines..."
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                >
                  Obtenir une Explication Ancrée dans les Sources
                </button>
              </form>

              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900">Inspecteur de Réponse & Citations Sources</h3>
                {latestExplanation ? (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300">
                        Mode IA : {latestExplanation.aiMode}
                      </span>
                      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-800 border border-slate-300">
                        Incertitude : {latestExplanation.uncertaintyLevel}
                      </span>
                    </div>
                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-800 whitespace-pre-line">
                      {latestExplanation.data?.explanation}
                    </div>
                    <div>
                      <div className="text-xs font-bold uppercase text-slate-700 mb-2">
                        Passages Sources Vérifiés ({latestExplanation.groundingCitations?.length || 0})
                      </div>
                      {latestExplanation.groundingCitations?.map((cit: any, idx: number) => (
                        <div key={idx} className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs mb-2">
                          <div className="font-semibold text-emerald-900">
                            Source : {cit.sourceTitle} (Pertinence: {cit.relevanceScore})
                          </div>
                          <div className="text-slate-700 italic mt-1">&ldquo;{cit.excerpt}&rdquo;</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : workspace?.studyMaterials?.length > 0 ? (
                  <div className="space-y-3 max-h-[420px] overflow-y-auto">
                    {workspace.studyMaterials.map((mat: any) => (
                      <div key={mat.id} className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-sm text-slate-900">{mat.title}</span>
                          <span className="text-[11px] px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-bold">
                            {mat.ai_mode} • Incertitude {mat.uncertainty_level}
                          </span>
                        </div>
                        <p className="text-xs text-slate-700 whitespace-pre-line">
                          {mat.content_json?.explanation || mat.content_json?.summary}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">Posez une question au tuteur pour afficher l&apos;analyse et les sources.</p>
                )}
              </div>
            </div>
          )}

          {/* TAB 4: EXERCISES, QUIZZES & CORRECTIONS */}
          {subTab === 'exercises' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-6">
                <form onSubmit={handleGenerateExercise} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                  <h3 className="text-lg font-bold text-slate-900">Générer Fiche de Révision & Exercice d&apos;Application</h3>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Document Source</label>
                    <select
                      value={selectedDocId}
                      onChange={(e) => setSelectedDocId(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      {workspace?.documents?.map((d: any) => (
                        <option key={d.id} value={d.id}>
                          {d.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Type de support</label>
                      <select
                        value={genMaterialType}
                        onChange={(e) => setGenMaterialType(e.target.value as any)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      >
                        <option value="EXAM_PREP">Préparation Examen (BAC/BEPC/WAEC)</option>
                        <option value="SUMMARY">Résumé Structuré</option>
                        <option value="FLASHCARDS">Flashcards de Mémorisation</option>
                        <option value="QUIZ">Quiz d&apos;Auto-Évaluation</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Niveau d&apos;exigence</label>
                      <select
                        value={genDifficulty}
                        onChange={(e) => setGenDifficulty(e.target.value as any)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      >
                        <option value="FOUNDATION">Fondamental</option>
                        <option value="INTERMEDIATE">Intermédiaire</option>
                        <option value="EXAM_LEVEL">Niveau Examen Officiel</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Titre de la séquence</label>
                    <input
                      type="text"
                      required
                      value={genTitle}
                      onChange={(e) => setGenTitle(e.target.value)}
                      placeholder="Ex: Entraînement BAC Série D — Synthèse des Protéines"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                  >
                    Générer Fiche + Exercice Noté (/20)
                  </button>
                </form>

                {/* Active Exercise Submission Form */}
                {activeExercise && (
                  <form onSubmit={handleSubmitExercise} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-lg font-bold text-slate-900">{activeExercise.title}</h3>
                      <span className="px-2.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-xs font-bold">
                        Barème /{activeExercise.max_score} pts
                      </span>
                    </div>

                    <div className="space-y-4">
                      {(activeExercise.questions_json || []).map((q: any) => (
                        <div key={q.id} className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
                          <div className="text-xs font-bold text-slate-800">
                            {q.prompt} ({q.maxPoints} pts)
                          </div>
                          <div className="text-[11px] text-slate-500">Critère : {q.criterion}</div>
                          <textarea
                            rows={3}
                            required
                            value={answers[q.id] || ''}
                            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                            placeholder="Rédigez votre réponse argumentée ici..."
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
                          />
                        </div>
                      ))}
                    </div>

                    <button
                      type="submit"
                      className="w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                    >
                      Soumettre mes Réponses & Obtenir la Correction Détaillée
                    </button>
                  </form>
                )}
              </div>

              {/* Correction & Submissions History */}
              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900">Corrections Détaillées & Barème</h3>
                {latestCorrection && (
                  <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-300 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-emerald-950">
                        Note obtenue : {latestCorrection.score} / {latestCorrection.max_score} ({latestCorrection.percentage}%)
                      </span>
                      <span className="text-xs font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-900">
                        {latestCorrection.ai_mode}
                      </span>
                    </div>
                    <p className="text-xs text-emerald-900 font-medium">{latestCorrection.overall_feedback}</p>
                    <p className="text-[11px] text-slate-600">{latestCorrection.uncertainty_note}</p>
                    <div className="space-y-2 pt-2">
                      {(latestCorrection.corrections_json || []).map((c: any) => (
                        <div key={c.questionId} className="p-3 rounded bg-white border border-emerald-200 text-xs">
                          <div className="font-semibold text-slate-900">
                            Question {c.questionId} : {c.awardedPoints}/{c.maxPoints} pts
                          </div>
                          <div className="text-slate-700 mt-1">{c.explanation}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  <div className="text-xs font-bold uppercase text-slate-500">Copies Précédentes Enregistrées</div>
                  {workspace?.submissions?.map((sub: any) => (
                    <div key={sub.id} className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-sm text-slate-900">{sub.exercise_title}</span>
                        <span className="font-bold text-sm text-emerald-700">
                          {sub.score}/{sub.max_score} ({sub.percentage}%)
                        </span>
                      </div>
                      <p className="text-xs text-slate-600">{sub.overall_feedback}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: ACTIVITY HISTORY & PROGRESS */}
          {subTab === 'history' && (
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-slate-900">
                  Journal d&apos;Activité Académique Persistant ({workspace?.activities?.length || 0} événements)
                </h3>
                <span className="px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold">
                  Progression Cumulée : {workspace?.progressSummary?.cumulativeProgressScore || 0}%
                </span>
              </div>
              <div className="divide-y divide-slate-200">
                {workspace?.activities?.map((act: any) => (
                  <div key={act.id} className="py-3 flex items-center justify-between gap-4">
                    <div>
                      <span className="inline-block px-2 py-0.5 rounded bg-slate-100 text-slate-800 text-[11px] font-bold mr-2">
                        {act.activity_type}
                      </span>
                      <span className="text-sm text-slate-900 font-medium">{act.summary}</span>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-xs font-bold text-emerald-700">+{act.progress_delta}%</span>
                      <div className="text-[11px] text-slate-400">
                        {new Date(act.created_at).toLocaleString('fr-FR')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
