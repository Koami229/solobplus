'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  BookOpen,
  Upload,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  FileText,
  GraduationCap,
  Award,
  ShieldAlert,
} from 'lucide-react';
import { apiFetch } from '@/lib/core/client-http';

interface SchoolViewProps {
  user: any;
  notify: (msg: string, type?: 'success' | 'error') => void;
}

export function SchoolView({ user, notify }: SchoolViewProps) {
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<any>({ curricula: [], subjects: [], gradeLevels: [] });
  const [workspace, setWorkspace] = useState<any>(null);
  const [subTab, setSubTab] = useState<'profile' | 'documents' | 'tutor' | 'exercises' | 'progress'>('documents');

  // Academic profile form state
  const [countryCode, setCountryCode] = useState('BJ');
  const [curriculumId, setCurriculumId] = useState('curr_bj_bac');
  const [gradeLevelId, setGradeLevelId] = useState('gl_bj_tle_cd');
  const [schoolName, setSchoolName] = useState('');
  const [examTargetYear, setExamTargetYear] = useState(2027);
  const [learningGoals, setLearningGoals] = useState('');

  // Document upload form state (supports real file selection + optional text entry)
  const [docTitle, setDocTitle] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [docFileName, setDocFileName] = useState('cours_physique_induction.txt');
  const [docContent, setDocContent] = useState('');
  const [docSubjectId, setDocSubjectId] = useState('subj_bj_phys');

  // Grounded AI Tutor state
  const [selectedDocId, setSelectedDocId] = useState('');
  const [tutorQuestion, setTutorQuestion] = useState('');
  const [tutorLoading, setTutorLoading] = useState(false);
  const [latestTutorTurn, setLatestTutorTurn] = useState<any>(null);

  // Exercise generation & submission state
  const [genTitle, setGenTitle] = useState('Fiche de Révision & Exercice : Induction Électromagnétique');
  const [genDifficulty, setGenDifficulty] = useState<'EASY' | 'MEDIUM' | 'EXAM_LEVEL'>('EXAM_LEVEL');
  const [activeExercise, setActiveExercise] = useState<any>(null);
  const [answersMap, setAnswersMap] = useState<Record<string, string>>({});
  const [latestSubmissionResult, setLatestSubmissionResult] = useState<any>(null);

  const fetchSchoolData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/school');
      const data = await res.json();
      if (data.ok) {
        setCatalog(data.catalog);
        setWorkspace(data.workspace);
        if (data.workspace?.profile) {
          setCountryCode(data.workspace.profile.country_code || 'BJ');
          setCurriculumId(data.workspace.profile.curriculum_id || 'curr_bj_bac');
          setGradeLevelId(data.workspace.profile.grade_level_id || 'gl_bj_tle_cd');
          setSchoolName(data.workspace.profile.school_name || '');
          setExamTargetYear(data.workspace.profile.exam_target_year || 2027);
          setLearningGoals(data.workspace.profile.learning_goals || '');
        }
        if (data.workspace?.documents?.length > 0 && !selectedDocId) {
          setSelectedDocId(data.workspace.documents[0].id);
        }
        if (data.workspace?.exercises?.length > 0 && !activeExercise) {
          setActiveExercise(data.workspace.exercises[0]);
        }
      }
    } catch (err: any) {
      notify(err.message || 'Erreur lors du chargement de SOLOB School', 'error');
    } finally {
      setLoading(false);
    }
  }, [activeExercise, notify, selectedDocId]);

  useEffect(() => {
    fetchSchoolData();
  }, [user?.id, fetchSchoolData]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/school', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert_profile',
          countryCode,
          curriculumId,
          gradeLevelId,
          schoolName,
          examTargetYear: Number(examTargetYear),
          learningGoals,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur de sauvegarde');
      notify('Profil académique mis à jour et persisté en base !');
      fetchSchoolData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setSelectedFile(file);
    if (file) {
      setDocFileName(file.name);
      if (!docTitle.trim()) {
        setDocTitle(file.name.replace(/\.[^.]+$/, ''));
      }
    }
  };

  const handleUploadDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      let res: Response;
      if (selectedFile) {
        const formData = new FormData();
        formData.set('action', 'upload_document');
        formData.set('title', docTitle);
        formData.set('file', selectedFile);
        formData.set('originalFileName', selectedFile.name);
        formData.set('mimeType', selectedFile.type || '');
        formData.set('curriculumId', curriculumId);
        formData.set('subjectId', docSubjectId);
        formData.set('isTeacherResource', String(user?.role === 'teacher'));

        res = await apiFetch('/api/school', {
          method: 'POST',
          body: formData,
        });
      } else {
        res = await apiFetch('/api/school', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'upload_document',
            title: docTitle,
            originalFileName: docFileName,
            mimeType: 'text/plain',
            content: docContent,
            curriculumId,
            subjectId: docSubjectId,
            isTeacherResource: user?.role === 'teacher',
          }),
        });
      }

      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Échec du téléversement');
      notify(`Document "${data.document.title}" téléversé et indexé avec succès !`);
      setDocTitle('');
      setDocContent('');
      setSelectedFile(null);
      setSelectedDocId(data.document.id);
      fetchSchoolData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleAskGroundedTutor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDocId) {
      notify('Veuillez sélectionner un document source pour ancrer la réponse.', 'error');
      return;
    }
    try {
      setTutorLoading(true);
      const res = await apiFetch('/api/school', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'explain_grounded',
          documentId: selectedDocId,
          subjectId: docSubjectId,
          question: tutorQuestion,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur du tuteur IA');
      setLatestTutorTurn(data);
      notify('Explication sourcée générée avec vérification des citations !');
      fetchSchoolData();
    } catch (err: any) {
      notify(err.message, 'error');
    } finally {
      setTutorLoading(false);
    }
  };

  const handleGenerateExercise = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDocId) {
      notify('Sélectionnez un document de cours pour générer la fiche et les exercices.', 'error');
      return;
    }
    try {
      setTutorLoading(true);
      const res = await apiFetch('/api/school', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate_revision_exercise',
          documentId: selectedDocId,
          subjectId: docSubjectId,
          title: genTitle,
          difficulty: genDifficulty,
          materialType: 'SUMMARY_SHEET',
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur de génération');
      setActiveExercise(data.exercise);
      setAnswersMap({});
      setLatestSubmissionResult(null);
      notify('Fiche de révision et exercice générés avec barème officiel !');
      fetchSchoolData();
    } catch (err: any) {
      notify(err.message, 'error');
    } finally {
      setTutorLoading(false);
    }
  };

  const handleSubmitExercise = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeExercise) return;
    try {
      const res = await apiFetch('/api/school', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'submit_exercise',
          exerciseId: activeExercise.id,
          answers: answersMap,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur de soumission');
      setLatestSubmissionResult(data.submission);
      notify(
        `Exercice corrigé : ${data.submission.score}/${data.submission.max_score} (${data.submission.percentage}%) !`
      );
      fetchSchoolData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="space-y-6">
      {/* Pillar Header Banner */}
      <div className="bg-emerald-950 text-white rounded-2xl p-6 shadow-md border border-emerald-800">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-800/80 text-emerald-200 text-xs font-semibold mb-2">
              <GraduationCap className="w-4 h-4" />
              SOLOB SCHOOL — APPRENTISSAGE ACADÉMIQUE & TUTEUR IA ANCRÉ
            </div>
            <h2 className="text-2xl font-bold">Espace Apprenant & Enseignant</h2>
            <p className="text-emerald-200 text-sm mt-1">
              Ancrage documentaire strict, citations vérifiables, niveau d&apos;incertitude épistémique et alignement sur les programmes officiels (BAC Bénin, WAEC/WASSCE, UEMOA).
            </p>
          </div>
          {workspace?.progressSummary && (
            <div className="grid grid-cols-3 gap-3 bg-emerald-900/70 p-3 rounded-xl border border-emerald-700/60 text-center">
              <div>
                <div className="text-xl font-bold text-emerald-300">
                  {workspace.progressSummary.totalDocuments}
                </div>
                <div className="text-[11px] text-emerald-200">Documents</div>
              </div>
              <div>
                <div className="text-xl font-bold text-emerald-300">
                  {workspace.progressSummary.totalExercisesCompleted}
                </div>
                <div className="text-[11px] text-emerald-200">Exercices Corrigés</div>
              </div>
              <div>
                <div className="text-xl font-bold text-emerald-300">
                  {workspace.progressSummary.averageScorePercentage}%
                </div>
                <div className="text-[11px] text-emerald-200">Score Moyen</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Role Warning if Business user tries to access School */}
      {(!user || !['student', 'teacher', 'admin'].includes(user.role)) && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 flex items-start gap-3 text-amber-900">
          <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold">Accès en lecture au catalogue School uniquement</p>
            <p className="mt-1">
              Vous êtes actuellement connecté avec le rôle{' '}
              <code className="font-mono font-bold">{user?.role || 'visiteur non connecté'}</code>.
              La séparation stricte RBAC de SOLOB+ réserve l&apos;espace de travail School aux rôles{' '}
              <code>student</code>, <code>teacher</code> et <code>admin</code>.
            </p>
          </div>
        </div>
      )}

      {/* Sub-navigation */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">
        {[
          { id: 'documents', label: '1. Bibliothèque & Téléversement de Cours', icon: Upload },
          { id: 'tutor', label: '2. Tuteur IA Ancré & Vérificateur de Citations', icon: Sparkles },
          { id: 'exercises', label: '3. Fiches de Révision & Exercices Notés', icon: BookOpen },
          { id: 'progress', label: '4. Suivi de Progression & Historique', icon: Award },
          { id: 'profile', label: '5. Programme Officiel & Profil Académique', icon: GraduationCap },
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
          {/* TAB 1: DOCUMENTS */}
          {subTab === 'documents' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <form
                onSubmit={handleUploadDocument}
                className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4"
              >
                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <Upload className="w-5 h-5 text-emerald-700" />
                  Téléverser un Document de Cours ou Polycopié
                </h3>
                <p className="text-xs text-slate-600">
                  Sélectionnez un fichier réel depuis votre disque (<code>.pdf</code>,{' '}
                  <code>.txt</code>, <code>.md</code>, <code>.csv</code>, <code>.json</code>) ou
                  collez directement le texte du cours. Chaque fichier est vérifié (signature binaire,
                  MIME, taille, anti-exécutable) et stocké hors du répertoire public.
                </p>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Titre du document
                  </label>
                  <input
                    type="text"
                    required
                    value={docTitle}
                    onChange={(e) => setDocTitle(e.target.value)}
                    placeholder="Ex: Chapitre 4 — Loi de Faraday et Induction (Terminale C)"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Sélectionner un fichier depuis votre appareil (.pdf, .txt, .md, .csv, .json)
                  </label>
                  <input
                    type="file"
                    accept=".txt,.md,.csv,.json,.pdf,text/plain,text/markdown,text/csv,application/json,application/pdf"
                    onChange={handleFileChange}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs bg-slate-50 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-emerald-700 file:text-white hover:file:bg-emerald-800"
                  />
                  {selectedFile && (
                    <div className="mt-1.5 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5 flex items-center justify-between">
                      <span>
                        Fichier sélectionné : <strong>{selectedFile.name}</strong> (
                        {(selectedFile.size / 1024).toFixed(1)} Ko)
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedFile(null)}
                        className="text-rose-700 underline ml-2"
                      >
                        Retirer
                      </button>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Matière officielle
                    </label>
                    <select
                      value={docSubjectId}
                      onChange={(e) => setDocSubjectId(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      {catalog.subjects.map((s: any) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.code})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Nom du fichier (si saisie texte)
                    </label>
                    <input
                      type="text"
                      required
                      disabled={Boolean(selectedFile)}
                      value={docFileName}
                      onChange={(e) => setDocFileName(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                    />
                  </div>
                </div>

                {!selectedFile && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Contenu textuel du cours (ou sélectionnez un fichier ci-dessus)
                    </label>
                    <textarea
                      rows={5}
                      required={!selectedFile}
                      value={docContent}
                      onChange={(e) => setDocContent(e.target.value)}
                      placeholder="Collez ici les définitions, théorèmes, formules et exemples du cours..."
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                >
                  Téléverser et Indexer dans SOLOB School
                </button>
              </form>

              {/* Document Library List */}
              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-emerald-700" />
                  Bibliothèque Documentaire Accessible ({workspace?.documents?.length || 0})
                </h3>
                {workspace?.documents?.length ? (
                  <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1">
                    {workspace.documents.map((doc: any) => (
                      <div
                        key={doc.id}
                        onClick={() => setSelectedDocId(doc.id)}
                        className={`p-4 rounded-xl border cursor-pointer transition ${
                          selectedDocId === doc.id
                            ? 'border-emerald-600 bg-emerald-50/70'
                            : 'border-slate-200 hover:border-slate-300 bg-slate-50'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-bold text-sm text-slate-900">{doc.title}</div>
                            <div className="text-xs text-slate-500 mt-0.5">
                              {doc.subject_name || 'Matière générale'} •{' '}
                              {doc.curriculum_name || 'Programme'} • {doc.word_count} mots
                            </div>
                          </div>
                          {doc.is_teacher_resource && (
                            <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[11px] font-semibold">
                              Ressource Enseignant
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-600 mt-2 line-clamp-3 font-mono bg-white p-2 rounded border border-slate-200">
                          {doc.extracted_text}
                        </p>
                        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                          <span>ID: {doc.id}</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedDocId(doc.id);
                              setSubTab('tutor');
                            }}
                            className="text-emerald-700 font-semibold hover:underline"
                          >
                            Interroger le Tuteur IA sur ce document →
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">
                    Aucun document trouvé. Connectez-vous avec un compte étudiant ou enseignant pour consulter ou téléverser des cours.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: GROUNDED AI TUTOR & FACT-CHECK INSPECTOR */}
          {subTab === 'tutor' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <form
                onSubmit={handleAskGroundedTutor}
                className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4"
              >
                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-emerald-700" />
                  Interroger le Tuteur IA Ancré dans les Sources
                </h3>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Document source de référence (Ancrage obligatoire)
                  </label>
                  <select
                    value={selectedDocId}
                    onChange={(e) => setSelectedDocId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">-- Sélectionner un document --</option>
                    {workspace?.documents?.map((d: any) => (
                      <option key={d.id} value={d.id}>
                        {d.title} ({d.word_count} mots)
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Votre question académique
                  </label>
                  <textarea
                    rows={4}
                    required
                    value={tutorQuestion}
                    onChange={(e) => setTutorQuestion(e.target.value)}
                    placeholder="Ex: Quelle est l'expression de la force électromotrice induite selon la loi de Faraday et quel est le rôle du signe moins ?"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <button
                  type="submit"
                  disabled={tutorLoading}
                  className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                >
                  {tutorLoading
                    ? 'Vérification des sources en cours...'
                    : 'Obtenir une Explication Ancrée avec Citations'}
                </button>
              </form>

              {/* Fact-Check & Citation Inspector */}
              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900">
                  Inspecteur d&apos;Ancrage Documentaire & Incertitude Épistémique
                </h3>
                {latestTutorTurn ? (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                          latestTutorTurn.aiResult.uncertaintyLevel === 'LOW'
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                            : 'bg-amber-100 text-amber-800 border border-amber-300'
                        }`}
                      >
                        Incertitude : {latestTutorTurn.aiResult.uncertaintyLevel}
                      </span>
                      <span className="px-2.5 py-1 rounded-full text-xs font-mono bg-slate-100 text-slate-700 border border-slate-300">
                        Mode IA : {latestTutorTurn.aiResult.providerMode}
                      </span>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-sm text-slate-800 whitespace-pre-line">
                      {latestTutorTurn.aiResult.answer}
                    </div>

                    <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                      <strong>Justification du niveau de confiance :</strong>{' '}
                      {latestTutorTurn.aiResult.uncertaintyReason}
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs font-bold uppercase text-slate-500">
                        Citations Exactes Extraites du Document ({latestTutorTurn.aiResult.citations?.length || 0})
                      </div>
                      {latestTutorTurn.aiResult.citations?.map((cit: any, idx: number) => (
                        <div
                          key={idx}
                          className="p-3 rounded-lg bg-emerald-50/70 border border-emerald-200 text-xs space-y-1"
                        >
                          <div className="font-bold text-emerald-900">
                            Source : {cit.sourceTitle} ({cit.confidenceNote})
                          </div>
                          <blockquote className="italic text-slate-700 border-l-2 border-emerald-600 pl-2">
                            &ldquo;{cit.excerpt}&rdquo;
                          </blockquote>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">
                    Posez une question à gauche pour inspecter la réponse, les citations exactes du document et l&apos;évaluation d&apos;incertitude.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: REVISION SHEETS & GRADED EXERCISES */}
          {subTab === 'exercises' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-6">
                <form
                  onSubmit={handleGenerateExercise}
                  className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4"
                >
                  <h3 className="text-lg font-bold text-slate-900">
                    Générer une Fiche de Révision & un Exercice Noté
                  </h3>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Document source
                    </label>
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
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Titre de la fiche / exercice
                      </label>
                      <input
                        type="text"
                        required
                        value={genTitle}
                        onChange={(e) => setGenTitle(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Niveau d&apos;exigence
                      </label>
                      <select
                        value={genDifficulty}
                        onChange={(e) => setGenDifficulty(e.target.value as any)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      >
                        <option value="EASY">Fondamental (EASY)</option>
                        <option value="MEDIUM">Consolidation (MEDIUM)</option>
                        <option value="EXAM_LEVEL">Niveau Examen BAC / WAEC (EXAM_LEVEL)</option>
                      </select>
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={tutorLoading}
                    className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                  >
                    Générer Fiche de Révision + Exercice avec Barème
                  </button>
                </form>

                {/* Revision Materials List */}
                <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-3">
                  <h4 className="font-bold text-sm text-slate-900">
                    Fiches de Révision & Flashcards Générées ({workspace?.revisionMaterials?.length || 0})
                  </h4>
                  {workspace?.revisionMaterials?.map((rm: any) => (
                    <div key={rm.id} className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                      <div className="font-bold text-sm text-emerald-900">{rm.title}</div>
                      <p className="text-xs text-slate-700">
                        {rm.content_json?.summaryText}
                      </p>
                      {rm.content_json?.flashcards?.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                          {rm.content_json.flashcards.map((fc: any, i: number) => (
                            <div key={i} className="p-2 rounded bg-white border border-slate-200 text-xs">
                              <div className="font-semibold text-slate-800">Q: {fc.front}</div>
                              <div className="text-emerald-700 mt-1">R: {fc.back}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Active Exercise Taking & Grading Feedback */}
              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-slate-900">
                    Passer l&apos;Exercice & Correction par Barème
                  </h3>
                  {workspace?.exercises?.length > 1 && (
                    <select
                      value={activeExercise?.id || ''}
                      onChange={(e) => {
                        const found = workspace.exercises.find((x: any) => x.id === e.target.value);
                        setActiveExercise(found || null);
                        setLatestSubmissionResult(null);
                      }}
                      className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                    >
                      {workspace.exercises.map((ex: any) => (
                        <option key={ex.id} value={ex.id}>
                          {ex.title}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {activeExercise ? (
                  <form onSubmit={handleSubmitExercise} className="space-y-4">
                    <div className="text-xs text-slate-500">
                      Difficulté : <strong>{activeExercise.difficulty}</strong> • Barème total :{' '}
                      <strong>{activeExercise.max_score} pts</strong>
                    </div>

                    {activeExercise.questions_json?.map((q: any, idx: number) => (
                      <div key={q.id} className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                        <div className="text-sm font-bold text-slate-900">
                          Question {idx + 1} ({q.points} pts) : {q.prompt}
                        </div>
                        {q.options?.length > 0 ? (
                          <div className="space-y-1.5">
                            {q.options.map((opt: string) => (
                              <label key={opt} className="flex items-center gap-2 text-xs text-slate-800 cursor-pointer">
                                <input
                                  type="radio"
                                  name={`question_${q.id}`}
                                  value={opt}
                                  checked={answersMap[q.id] === opt}
                                  onChange={() =>
                                    setAnswersMap((prev) => ({ ...prev, [q.id]: opt }))
                                  }
                                />
                                <span>{opt}</span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <textarea
                            rows={3}
                            value={answersMap[q.id] || ''}
                            onChange={(e) =>
                              setAnswersMap((prev) => ({ ...prev, [q.id]: e.target.value }))
                            }
                            placeholder="Rédigez votre démonstration ou réponse complète..."
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs bg-white"
                          />
                        )}
                      </div>
                    ))}

                    <button
                      type="submit"
                      className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                    >
                      Soumettre mes Réponses pour Correction Détaillée
                    </button>
                  </form>
                ) : (
                  <p className="text-sm text-slate-500">
                    Aucun exercice sélectionné. Générez un exercice à partir d&apos;un cours à gauche.
                  </p>
                )}

                {latestSubmissionResult && (
                  <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-300 space-y-2">
                    <div className="font-bold text-emerald-950 text-sm">
                      Résultat : {latestSubmissionResult.score} / {latestSubmissionResult.max_score} (
                      {latestSubmissionResult.percentage}%)
                    </div>
                    <div className="space-y-1.5">
                      {latestSubmissionResult.feedback_json?.map((fb: any, i: number) => (
                        <div key={i} className="text-xs bg-white p-2.5 rounded border border-emerald-200">
                          <div className="font-semibold text-slate-900">
                            Question {fb.questionId} : {fb.awardedPoints}/{fb.maxPoints} pts
                          </div>
                          <div className="text-slate-700 mt-0.5">{fb.explanation}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 4: PROGRESS & ACTIVITY HISTORY */}
          {subTab === 'progress' && (
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
              <h3 className="text-lg font-bold text-slate-900">
                Journal de Progression Académique Persisté ({workspace?.activities?.length || 0} activités)
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-600 bg-slate-50">
                      <th className="p-3">Date</th>
                      <th className="p-3">Type d&apos;Activité</th>
                      <th className="p-3">Matière</th>
                      <th className="p-3">Score (%)</th>
                      <th className="p-3">Détails</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {workspace?.activities?.map((act: any) => (
                      <tr key={act.id}>
                        <td className="p-3 text-slate-500">
                          {new Date(act.created_at).toLocaleString('fr-FR')}
                        </td>
                        <td className="p-3 font-mono font-semibold text-emerald-800">
                          {act.activity_type}
                        </td>
                        <td className="p-3">{act.subject_id || 'Général'}</td>
                        <td className="p-3 font-bold">
                          {act.score_percentage !== null && act.score_percentage !== undefined
                            ? `${act.score_percentage}%`
                            : '—'}
                        </td>
                        <td className="p-3 font-mono text-[11px] text-slate-600">
                          {JSON.stringify(act.metadata_json)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 5: CURRICULUM & PROFILE */}
          {subTab === 'profile' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <form
                onSubmit={handleSaveProfile}
                className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4"
              >
                <h3 className="text-lg font-bold text-slate-900">
                  Configurer mon Programme Officiel & Objectif d&apos;Examen
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Pays (Code ISO)
                    </label>
                    <input
                      type="text"
                      value={countryCode}
                      onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Année cible d&apos;examen
                    </label>
                    <input
                      type="number"
                      value={examTargetYear}
                      onChange={(e) => setExamTargetYear(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Programme Officiel (Vérifié vs En Préparation)
                  </label>
                  <select
                    value={curriculumId}
                    onChange={(e) => setCurriculumId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {catalog.curricula.map((c: any) => (
                      <option key={c.id} value={c.id}>
                        {c.name} [{c.country_code}] — {c.verified ? 'VÉRIFIÉ' : 'NON VÉRIFIÉ'}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Niveau / Classe
                  </label>
                  <select
                    value={gradeLevelId}
                    onChange={(e) => setGradeLevelId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {catalog.gradeLevels.map((g: any) => (
                      <option key={g.id} value={g.id}>
                        {g.name} ({g.code})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Établissement scolaire / Université
                  </label>
                  <input
                    type="text"
                    value={schoolName}
                    onChange={(e) => setSchoolName(e.target.value)}
                    placeholder="Ex: Collège Père Aupiais — Cotonou"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Objectifs d&apos;apprentissage
                  </label>
                  <textarea
                    rows={3}
                    value={learningGoals}
                    onChange={(e) => setLearningGoals(e.target.value)}
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

              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-3">
                <h3 className="text-lg font-bold text-slate-900">
                  Transparence des Programmes & Couverture Régionale
                </h3>
                <p className="text-xs text-slate-600">
                  Conformément aux exigences d&apos;intégrité SOLOB+, les programmes officiels non encore intégralement audités sont explicitement marqués comme non vérifiés.
                </p>
                {catalog.curricula.map((c: any) => (
                  <div key={c.id} className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-slate-900">{c.name}</span>
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                          c.verified
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {c.verified ? 'PROGRAMME VÉRIFIÉ' : 'COUVERTURE PARTIELLE (NON VÉRIFIÉ)'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">{c.description}</p>
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
