'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Briefcase,
  ClipboardCheck,
  FileSpreadsheet,
  DollarSign,
  ShieldAlert,
  Award,
  Send,
} from 'lucide-react';
import { apiFetch } from '@/lib/core/client-http';

interface BusinessViewProps {
  user: any;
  notify: (msg: string, type?: 'success' | 'error') => void;
}

export function BusinessView({ user, notify }: BusinessViewProps) {
  const [loading, setLoading] = useState(true);
  const [workspace, setWorkspace] = useState<any>(null);
  const [subTab, setSubTab] = useState<
    'projects' | 'talent' | 'tasks' | 'qa' | 'delivery' | 'compensation'
  >('projects');

  // Client project request form
  const [orgName, setOrgName] = useState('Cotonou Voice AI Consortium');
  const [projTitle, setProjTitle] = useState('');
  const [serviceMode, setServiceMode] = useState<'MANAGED_PROJECT' | 'QUALIFIED_TALENT_PROVISION'>('MANAGED_PROJECT');
  const [serviceCategory, setServiceCategory] = useState('AFRICAN_LANG_TRANSCRIPTION_ANNOTATION');
  const [projDesc, setProjDesc] = useState('');
  const [deliverablesSpec, setDeliverablesSpec] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [targetLangs, setTargetLangs] = useState('fon,fra');
  const [targetDialects, setTargetDialects] = useState('Agbome,Cotonou');
  const [budgetUsd, setBudgetUsd] = useState('1800');

  // Operator matching & task assignment state
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [matchResult, setMatchResult] = useState<any>(null);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskInstructions, setTaskInstructions] = useState('');
  const [taskLang, setTaskLang] = useState('fon');
  const [taskDialect, setTaskDialect] = useState('Agbome');
  const [assignedContributorId, setAssignedContributorId] = useState('');
  const [taskCompUsd, setTaskCompUsd] = useState('350');

  // Assessment form state (Operator)
  const [assessUserId, setAssessUserId] = useState('');
  const [assessType] = useState<'LANGUAGE_PROFICIENCY' | 'DOMAIN_SKILL'>('LANGUAGE_PROFICIENCY');
  const [assessLang, setAssessLang] = useState('fon');
  const [assessSkill, setAssessSkill] = useState('Orthographe tonale et validation Fɔngbè');
  const [assessScore, setAssessScore] = useState('90');

  // Contributor submission state
  const [activeTaskId, setActiveTaskId] = useState('');
  const [submissionText, setSubmissionText] = useState('');
  const [submissionNotes, setSubmissionNotes] = useState('');

  // Reviewer QA state
  const [activeSubmissionId, setActiveSubmissionId] = useState('');
  const [reviewDecision, setReviewDecision] = useState<'APPROVE' | 'REQUEST_REVISION' | 'REJECT'>('APPROVE');
  const [reviewQualityScore, setReviewQualityScore] = useState('95');
  const [reviewFeedback, setReviewFeedback] = useState('');

  // Operator Finalize Delivery state
  const [deliveryTitle, setDeliveryTitle] = useState('');
  const [deliverySummary, setDeliverySummary] = useState('');

  const fetchBusinessData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/business');
      const data = await res.json();
      if (data.ok && data.workspace) {
        setWorkspace(data.workspace);
        if (data.workspace.projects?.length > 0 && !selectedProjectId) {
          setSelectedProjectId(data.workspace.projects[0].id);
        }
        if (data.workspace.tasks?.length > 0 && !activeTaskId) {
          setActiveTaskId(data.workspace.tasks[0].id);
        }
        if (data.workspace.submissions?.length > 0 && !activeSubmissionId) {
          setActiveSubmissionId(data.workspace.submissions[0].id);
        }
        if (data.workspace.talentDirectory?.length > 0 && !assignedContributorId) {
          const firstVerified = data.workspace.talentDirectory.find(
            (t: any) => t.verificationSummary?.hasVerifiedLanguageSkills
          );
          setAssignedContributorId(
            firstVerified?.user?.id || data.workspace.talentDirectory[0]?.user?.id || ''
          );
          setAssessUserId(data.workspace.talentDirectory[0]?.user?.id || '');
        }
      }
    } catch (err: any) {
      notify(err.message || 'Erreur lors du chargement de SOLOB Business', 'error');
    } finally {
      setLoading(false);
    }
  }, [activeSubmissionId, activeTaskId, assignedContributorId, notify, selectedProjectId]);

  useEffect(() => {
    fetchBusinessData();
  }, [user?.id, fetchBusinessData]);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_project',
          organizationName: orgName,
          title: projTitle,
          serviceMode,
          serviceCategory,
          description: projDesc,
          deliverablesSpec,
          acceptanceCriteria,
          targetLanguages: targetLangs.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
          targetDialects: targetDialects.split(',').map((s) => s.trim()).filter(Boolean),
          budgetAmountCents: Math.round(Number(budgetUsd || 0) * 100),
          currency: 'USD',
          deadlineDate: '2026-12-30',
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur lors de la création du projet');
      notify(`Demande de projet "${data.project.title}" créée (${data.project.service_mode}).`);
      setProjTitle('');
      setProjDesc('');
      setSelectedProjectId(data.project.id);
      fetchBusinessData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleComputeMatches = async (projectId: string) => {
    try {
      const res = await apiFetch(`/api/business?matchProjectId=${encodeURIComponent(projectId)}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur lors du calcul de matching');
      setMatchResult(data.matches);
      notify('Matching explicable calculé selon les évaluations linguistiques vérifiées.');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleRecordAssessment = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'record_assessment',
          talentUserId: assessUserId,
          assessmentType: assessType,
          languageCode: assessLang,
          skillName: assessSkill,
          score: Number(assessScore),
          passingScore: 80,
          notes: 'Évaluation enregistrée via la console opérateur SOLOB Business.',
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Échec de l’évaluation');
      notify(
        `Évaluation enregistrée : Score ${data.assessment.score}/100 — ${
          data.assessment.passed ? 'RÉUSSIE (Compétence Vérifiée)' : 'ÉCHOUÉE (Maintenue Non-Vérifiée)'
        }`
      );
      fetchBusinessData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleAssignTask = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_assign_task',
          projectId: selectedProjectId,
          title: taskTitle,
          instructions: taskInstructions,
          languageCode: taskLang,
          dialect: taskDialect,
          assignedContributorId,
          compensationCents: Math.round(Number(taskCompUsd || 0) * 100),
          currency: 'USD',
          requireVerifiedLanguage: true,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur d’assignation');
      notify(`Tâche "${data.task.title}" assignée avec succès et rémunération placée en statut PENDING.`);
      setTaskTitle('');
      setTaskInstructions('');
      fetchBusinessData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleSubmitWork = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'submit_work',
          taskId: activeTaskId,
          contentText: submissionText,
          contributorNotes: submissionNotes,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Échec de la soumission');
      notify(`Livrable soumis (Révision #${data.submission.revision_number}) !`);
      setSubmissionText('');
      setSubmissionNotes('');
      fetchBusinessData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleReviewSubmission = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'review_submission',
          submissionId: activeSubmissionId,
          decision: reviewDecision,
          qualityScore: Number(reviewQualityScore),
          feedback: reviewFeedback,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Échec de la revue QA');
      notify(`Décision QA enregistrée : ${data.review.decision} (${data.review.quality_score}/100)`);
      setReviewFeedback('');
      fetchBusinessData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleFinalizeDelivery = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'finalize_delivery',
          projectId: selectedProjectId,
          title: deliveryTitle,
          executiveSummary: deliverySummary,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Échec de la finalisation');
      notify(`Rapport de livraison "${data.report.title}" finalisé et autorisé pour le client !`);
      setDeliveryTitle('');
      setDeliverySummary('');
      fetchBusinessData();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="space-y-6">
      {/* Pillar Header Banner */}
      <div className="bg-amber-950 text-white rounded-2xl p-6 shadow-md border border-amber-800">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-800/80 text-amber-200 text-xs font-semibold mb-2">
              <Briefcase className="w-4 h-4" />
              SOLOB BUSINESS — OPÉRATIONS DE TALENTS IA & LIVRAISON GÉRÉE
            </div>
            <h2 className="text-2xl font-bold">Plateforme Gérée de Projets IA & Linguistiques Africains</h2>
            <p className="text-amber-200 text-sm mt-1">
              Pas une place de marché freelance ouverte : SOLOB sélectionne, évalue rigoureusement les compétences linguistiques (Fɔngbè, Yorùbá, Wolof, Hausa...), supervise la qualité QA et livre des résultats vérifiés.
            </p>
          </div>
          {workspace && (
            <div className="grid grid-cols-3 gap-3 bg-amber-900/60 p-3 rounded-xl border border-amber-700/60 text-center">
              <div>
                <div className="text-xl font-bold text-amber-300">{workspace.projects?.length || 0}</div>
                <div className="text-[11px] text-amber-200">Projets Visibles</div>
              </div>
              <div>
                <div className="text-xl font-bold text-amber-300">{workspace.tasks?.length || 0}</div>
                <div className="text-[11px] text-amber-200">Tâches Autorisées</div>
              </div>
              <div>
                <div className="text-xl font-bold text-amber-300">{workspace.deliveryReports?.length || 0}</div>
                <div className="text-[11px] text-amber-200">Rapports Livrés</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Role Warning if School user tries to access Business */}
      {(!user || !['org_client', 'contributor', 'reviewer', 'operator', 'admin'].includes(user.role)) && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 flex items-start gap-3 text-amber-900">
          <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold">Accès restreint aux rôles SOLOB Business</p>
            <p className="mt-1">
              Votre rôle actuel (<strong>{user?.role || 'Visiteur'}</strong>) appartient au pilier School ou n&apos;est pas connecté. Connectez-vous avec un compte <code>org_client</code>, <code>operator</code>, <code>contributor</code> ou <code>reviewer</code> pour exécuter les workflows Business.
            </p>
          </div>
        </div>
      )}

      {/* Sub-navigation */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">
        {[
          { id: 'projects', label: '1. Demandes Clients & Projets', icon: Briefcase },
          { id: 'talent', label: '2. Talents, Évaluations & Matching Explicable', icon: Award },
          { id: 'tasks', label: '3. Assignation & Exécution des Tâches', icon: Send },
          { id: 'qa', label: '4. Revue Qualité (QA) & Révisions', icon: ClipboardCheck },
          { id: 'delivery', label: '5. Rapports de Livraison Client', icon: FileSpreadsheet },
          { id: 'compensation', label: '6. Registre des Rémunérations', icon: DollarSign },
        ].map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id as any)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                subTab === t.id
                  ? 'bg-amber-700 text-white shadow-sm'
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
          Chargement des opérations SOLOB Business...
        </div>
      ) : (
        <>
          {/* TAB 1: PROJECTS */}
          {subTab === 'projects' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <form onSubmit={handleCreateProject} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900">Soumettre un Nouveau Projet (Client / Opérateur)</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Organisation Cliente</label>
                    <input
                      type="text"
                      required
                      value={orgName}
                      onChange={(e) => setOrgName(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Mode de Service SOLOB</label>
                    <select
                      value={serviceMode}
                      onChange={(e) => setServiceMode(e.target.value as any)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      <option value="MANAGED_PROJECT">1. Projet Géré (Managed Project Delivery)</option>
                      <option value="QUALIFIED_TALENT_PROVISION">2. Mise à disposition de Talents Qualifiés</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Catégorie de Service</label>
                  <select
                    value={serviceCategory}
                    onChange={(e) => setServiceCategory(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="AFRICAN_LANG_TRANSCRIPTION_ANNOTATION">Transcription & Annotation en Langues Africaines</option>
                    <option value="TRANSLATION_LINGUISTIC_VALIDATION">Traduction & Validation Linguistique</option>
                    <option value="MULTILINGUAL_DATA_PREP">Préparation de Données Multilingues</option>
                    <option value="AI_EVALUATION_MODEL_TESTING">Évaluation de Réponses IA & Tests de Modèles (RLHF)</option>
                    <option value="EXPERT_DATA_ANNOTATION_QA">Annotation Experte & Revue Qualité</option>
                    <option value="SPECIALIZED_AI_PROJECT_TEAM">Équipe Projet IA Spécialisée</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Titre du Projet</label>
                  <input
                    type="text"
                    required
                    value={projTitle}
                    onChange={(e) => setProjTitle(e.target.value)}
                    placeholder="Ex: Corpus Audio-Texte Fɔngbè & Yorùbá pour Assistant Santé"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Langues Cibles (codes ISO)</label>
                    <input
                      type="text"
                      value={targetLangs}
                      onChange={(e) => setTargetLangs(e.target.value)}
                      placeholder="fon,yor,fra"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Dialectes</label>
                    <input
                      type="text"
                      value={targetDialects}
                      onChange={(e) => setTargetDialects(e.target.value)}
                      placeholder="Agbome,Cotonou"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Budget (USD)</label>
                    <input
                      type="number"
                      value={budgetUsd}
                      onChange={(e) => setBudgetUsd(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Description & Contexte</label>
                  <textarea
                    rows={2}
                    required
                    value={projDesc}
                    onChange={(e) => setProjDesc(e.target.value)}
                    placeholder="Décrivez le besoin opérationnel..."
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Livrables Attendus</label>
                    <input
                      type="text"
                      required
                      value={deliverablesSpec}
                      onChange={(e) => setDeliverablesSpec(e.target.value)}
                      placeholder="Ex: 500 segments JSONL annotés"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Critères d&apos;Acceptation QA</label>
                    <input
                      type="text"
                      required
                      value={acceptanceCriteria}
                      onChange={(e) => setAcceptanceCriteria(e.target.value)}
                      placeholder="Ex: Score QA >= 90%, tons vérifiés"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full bg-amber-700 hover:bg-amber-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                >
                  Soumettre la Demande de Projet à SOLOB Business
                </button>
              </form>

              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900">
                  Projets Autorisés pour votre Rôle ({workspace?.projects?.length || 0})
                </h3>
                <div className="space-y-3 max-h-[540px] overflow-y-auto">
                  {workspace?.projects?.map((p: any) => (
                    <div key={p.id} className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <span className="text-[11px] font-bold uppercase text-amber-800">
                            {p.service_mode} • {p.organization_name}
                          </span>
                          <div className="font-bold text-sm text-slate-900">{p.title}</div>
                        </div>
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300">
                          {p.status}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600">{p.description}</p>
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200 text-xs">
                        <span>
                          Langues : <strong>{(p.target_languages_json || []).join(', ').toUpperCase()}</strong>
                        </span>
                        {p.budget_amount_cents !== undefined && (
                          <span>
                            Budget : <strong>${(Number(p.budget_amount_cents) / 100).toLocaleString()}</strong>
                          </span>
                        )}
                        {(user?.role === 'operator' || user?.role === 'admin') && (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedProjectId(p.id);
                              handleComputeMatches(p.id);
                              setSubTab('talent');
                            }}
                            className="text-amber-800 font-semibold hover:underline"
                          >
                            Calculer Matching Talents →
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: TALENT PROFILES, ASSESSMENTS & EXPLAINABLE MATCHING */}
          {subTab === 'talent' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-6">
                <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                  <h3 className="text-lg font-bold text-slate-900">
                    Répertoire des Talents & Statut de Vérification Linguistique
                  </h3>
                  <p className="text-xs text-slate-600">
                    Règle stricte SOLOB+ : Une langue déclarée par un contributeur reste marquée <strong>NON VÉRIFIÉE</strong> tant qu&apos;il n&apos;a pas réussi l&apos;évaluation de compétence correspondante (<code>passed = true</code>).
                  </p>
                  <div className="space-y-3">
                    {workspace?.talentDirectory?.map((item: any) => (
                      <div key={item.user?.id} className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="font-bold text-sm text-slate-900">{item.user?.full_name}</div>
                          <span className="text-xs px-2 py-0.5 rounded bg-slate-200 text-slate-800 font-semibold">
                            {item.profile?.availability_status || 'AVAILABLE'} ({item.profile?.availability_hours_per_week || 20}h/sem)
                          </span>
                        </div>
                        <div className="text-xs text-slate-600">{item.profile?.headline}</div>
                        <div className="flex flex-wrap gap-2 pt-1">
                          {item.verificationSummary?.verifiedLanguages?.map((lang: string) => (
                            <span
                              key={lang}
                              className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300"
                            >
                              ✓ {lang.toUpperCase()} VÉRIFIÉ (Évaluation réussie)
                            </span>
                          ))}
                          {item.verificationSummary?.unverifiedClaimedLanguages?.map((lang: string) => (
                            <span
                              key={lang}
                              className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-100 text-rose-800 border border-rose-300"
                            >
                              ⚠ {lang.toUpperCase()} NON VÉRIFIÉ (Bloqué pour assignation)
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {(user?.role === 'operator' || user?.role === 'admin') && (
                  <form onSubmit={handleRecordAssessment} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                    <h3 className="text-lg font-bold text-slate-900">Enregistrer un Résultat d&apos;Évaluation (Opérateur)</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Contributeur évalué</label>
                        <select
                          value={assessUserId}
                          onChange={(e) => setAssessUserId(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        >
                          {workspace?.talentDirectory?.map((t: any) => (
                            <option key={t.user?.id} value={t.user?.id}>
                              {t.user?.full_name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Code Langue (ISO)</label>
                        <select
                          value={assessLang}
                          onChange={(e) => setAssessLang(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        >
                          <option value="fon">fon (Fɔngbè)</option>
                          <option value="yor">yor (Yorùbá)</option>
                          <option value="wol">wol (Wolof)</option>
                          <option value="hau">hau (Hausa)</option>
                          <option value="fra">fra (Français)</option>
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Compétence testée</label>
                        <input
                          type="text"
                          value={assessSkill}
                          onChange={(e) => setAssessSkill(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Score (/100, seuil = 80)</label>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={assessScore}
                          onChange={(e) => setAssessScore(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      className="w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                    >
                      Valider le Résultat d&apos;Évaluation
                    </button>
                  </form>
                )}
              </div>

              {/* Explainable Matching Panel */}
              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-slate-900">Moteur de Matching Explicable</h3>
                  {(user?.role === 'operator' || user?.role === 'admin') && selectedProjectId && (
                    <button
                      type="button"
                      onClick={() => handleComputeMatches(selectedProjectId)}
                      className="px-3 py-1.5 rounded-lg bg-amber-700 text-white text-xs font-semibold"
                    >
                      Actualiser le Matching
                    </button>
                  )}
                </div>

                {matchResult ? (
                  <div className="space-y-3">
                    <div className="text-xs text-slate-600">
                      Projet cible : <strong>{matchResult.projectTitle}</strong> (Langues :{' '}
                      {matchResult.targetLanguages.join(', ').toUpperCase()})
                    </div>
                    {matchResult.candidates.map((cand: any) => (
                      <div key={cand.userId} className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-sm text-slate-900">{cand.fullName}</span>
                          <span
                            className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${
                              cand.eligibleForVerifiedAssignment
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            Score Match : {cand.matchScore}/100 •{' '}
                            {cand.eligibleForVerifiedAssignment ? 'ÉLIGIBLE' : 'NON VÉRIFIÉ'}
                          </span>
                        </div>
                        <ul className="list-disc list-inside text-xs text-slate-700 space-y-1">
                          {cand.explanationReasons.map((r: string, i: number) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">
                    Connectez-vous en tant qu&apos;Opérateur ou Admin et cliquez sur &ldquo;Actualiser le Matching&rdquo; pour inspecter les scores explicables par projet.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: TASK ASSIGNMENT & EXECUTION */}
          {subTab === 'tasks' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {(user?.role === 'operator' || user?.role === 'admin') && (
                <form onSubmit={handleAssignTask} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                  <h3 className="text-lg font-bold text-slate-900">
                    Créer & Assigner une Tâche à un Contributeur Qualifié (Opérateur)
                  </h3>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Projet</label>
                    <select
                      value={selectedProjectId}
                      onChange={(e) => setSelectedProjectId(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      {workspace?.projects?.map((p: any) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Contributeur Assigné</label>
                      <select
                        value={assignedContributorId}
                        onChange={(e) => setAssignedContributorId(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      >
                        {workspace?.talentDirectory?.map((t: any) => (
                          <option key={t.user?.id} value={t.user?.id}>
                            {t.user?.full_name} (Vérifié: {t.verificationSummary?.verifiedLanguages?.join(',') || 'Aucun'})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Langue Requise (Vérifiée)</label>
                      <select
                        value={taskLang}
                        onChange={(e) => setTaskLang(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      >
                        <option value="fon">fon (Fɔngbè)</option>
                        <option value="yor">yor (Yorùbá)</option>
                        <option value="wol">wol (Wolof)</option>
                        <option value="fra">fra (Français)</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Titre de la Tâche</label>
                    <input
                      type="text"
                      required
                      value={taskTitle}
                      onChange={(e) => setTaskTitle(e.target.value)}
                      placeholder="Ex: Transcription & Validation Lot #2 (Fɔngbè Agbome)"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Consignes d&apos;exécution</label>
                    <textarea
                      rows={3}
                      required
                      value={taskInstructions}
                      onChange={(e) => setTaskInstructions(e.target.value)}
                      placeholder="Consignes détaillées de transcription et notation tonale..."
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Dialecte</label>
                      <input
                        type="text"
                        value={taskDialect}
                        onChange={(e) => setTaskDialect(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Rémunération (USD)</label>
                      <input
                        type="number"
                        value={taskCompUsd}
                        onChange={(e) => setTaskCompUsd(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    className="w-full bg-amber-700 hover:bg-amber-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                  >
                    Assigner la Tâche (Vérification Linguistique Forcée)
                  </button>
                </form>
              )}

              {/* Contributor Task Execution & Authorized Task List */}
              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900">
                  Tâches Autorisées ({workspace?.tasks?.length || 0}) & Soumission de Livrable
                </h3>
                <p className="text-xs text-slate-600">
                  Isolation stricte : Un contributeur ne reçoit et ne voit que les tâches et fichiers qui lui sont explicitement assignés.
                </p>
                <div className="space-y-3 max-h-[260px] overflow-y-auto">
                  {workspace?.tasks?.map((t: any) => (
                    <div
                      key={t.id}
                      onClick={() => setActiveTaskId(t.id)}
                      className={`p-3.5 rounded-xl border cursor-pointer transition ${
                        activeTaskId === t.id
                          ? 'border-amber-600 bg-amber-50/70'
                          : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm text-slate-900">{t.title}</span>
                        <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-[11px] font-bold">
                          {t.status} • {t.language_code?.toUpperCase()}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 mt-1">{t.instructions}</p>
                    </div>
                  ))}
                </div>

                {activeTaskId && (
                  <form onSubmit={handleSubmitWork} className="pt-4 border-t border-slate-200 space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">Soumettre le Travail pour la Tâche Sélectionnée</h4>
                    <textarea
                      rows={3}
                      required
                      value={submissionText}
                      onChange={(e) => setSubmissionText(e.target.value)}
                      placeholder="Saisissez la transcription / traduction vérifiée avec diacritiques tonals..."
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    <input
                      type="text"
                      value={submissionNotes}
                      onChange={(e) => setSubmissionNotes(e.target.value)}
                      placeholder="Notes méthodologiques ou dialectales..."
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    <button
                      type="submit"
                      className="w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                    >
                      Envoyer la Soumission à la Revue Qualité (QA)
                    </button>
                  </form>
                )}
              </div>
            </div>
          )}

          {/* TAB 4: QA REVIEW & REVISION WORKFLOW */}
          {subTab === 'qa' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900">
                  Soumissions des Contributeurs ({workspace?.submissions?.length || 0})
                </h3>
                <div className="space-y-3 max-h-[420px] overflow-y-auto">
                  {workspace?.submissions?.map((sub: any) => (
                    <div
                      key={sub.id}
                      onClick={() => setActiveSubmissionId(sub.id)}
                      className={`p-4 rounded-xl border cursor-pointer ${
                        activeSubmissionId === sub.id
                          ? 'border-amber-600 bg-amber-50'
                          : 'border-slate-200 bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm text-slate-900">
                          {sub.task_title} (Révision #{sub.revision_number})
                        </span>
                        <span className="text-xs font-semibold text-amber-800">
                          Langue: {sub.language_code?.toUpperCase()} ({sub.dialect || 'Standard'})
                        </span>
                      </div>
                      <p className="text-xs text-slate-800 bg-white p-2.5 rounded border border-slate-200 mt-2">
                        {sub.content_text}
                      </p>
                      <div className="text-[11px] text-slate-500 mt-1">
                        Contributeur: {sub.contributor_name || sub.contributor_user_id}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <form onSubmit={handleReviewSubmission} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900">
                  Inspection Assurance Qualité (QA Reviewer / Opérateur)
                </h3>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Soumission Sélectionnée</label>
                  <select
                    value={activeSubmissionId}
                    onChange={(e) => setActiveSubmissionId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {workspace?.submissions?.map((s: any) => (
                      <option key={s.id} value={s.id}>
                        {s.task_title} — Rév #{s.revision_number}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Décision QA</label>
                    <select
                      value={reviewDecision}
                      onChange={(e) => setReviewDecision(e.target.value as any)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      <option value="APPROVE">APPROVE (Approuver le livrable)</option>
                      <option value="REQUEST_REVISION">REQUEST_REVISION (Demander révision)</option>
                      <option value="REJECT">REJECT (Rejeter)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Score Qualité (/100)</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={reviewQualityScore}
                      onChange={(e) => setReviewQualityScore(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Rapport d&apos;évaluation linguistique & Feedback
                  </label>
                  <textarea
                    rows={4}
                    required
                    value={reviewFeedback}
                    onChange={(e) => setReviewFeedback(e.target.value)}
                    placeholder="Détaillez la vérification orthographique, tonale et terminologique..."
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full bg-amber-700 hover:bg-amber-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                >
                  Enregistrer la Décision QA
                </button>
              </form>
            </div>
          )}

          {/* TAB 5: DELIVERY REPORTS */}
          {subTab === 'delivery' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {(user?.role === 'operator' || user?.role === 'admin') && (
                <form onSubmit={handleFinalizeDelivery} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                  <h3 className="text-lg font-bold text-slate-900">
                    Finaliser les Livrables & Émettre le Rapport Client (Opérateur)
                  </h3>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Projet à livrer</label>
                    <select
                      value={selectedProjectId}
                      onChange={(e) => setSelectedProjectId(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      {workspace?.projects?.map((p: any) => (
                        <option key={p.id} value={p.id}>
                          {p.title} ({p.status})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Titre du Rapport de Livraison</label>
                    <input
                      type="text"
                      required
                      value={deliveryTitle}
                      onChange={(e) => setDeliveryTitle(e.target.value)}
                      placeholder="Ex: Rapport de Livraison Final — Corpus Fɔngbè Lot #1"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Synthèse Exécutive & Métriques QA</label>
                    <textarea
                      rows={4}
                      required
                      value={deliverySummary}
                      onChange={(e) => setDeliverySummary(e.target.value)}
                      placeholder="Synthèse de la méthodologie, de la couverture dialectale et des contrôles qualité..."
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition"
                  >
                    Finaliser et Autoriser le Rapport de Livraison Client
                  </button>
                </form>
              )}

              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900">
                  Rapports de Livraison Autorisés ({workspace?.deliveryReports?.length || 0})
                </h3>
                <div className="space-y-4">
                  {workspace?.deliveryReports?.map((dr: any) => (
                    <div key={dr.id} className="p-4 rounded-xl border border-emerald-300 bg-emerald-50/70 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm text-emerald-950">{dr.title}</span>
                        <span className="px-2.5 py-0.5 rounded-full bg-emerald-700 text-white text-xs font-bold">
                          Qualité Moyenne : {dr.average_quality_score}/100
                        </span>
                      </div>
                      <p className="text-xs text-slate-700">{dr.executive_summary}</p>
                      <div className="text-xs text-emerald-900 font-semibold">
                        Tâches approuvées incluses : {dr.total_tasks_approved} | Projet : {dr.project_title}
                      </div>
                    </div>
                  ))}
                  {(!workspace?.deliveryReports || workspace.deliveryReports.length === 0) && (
                    <p className="text-sm text-slate-500">
                      Aucun rapport de livraison accessible pour votre compte actuel.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 6: COMPENSATION RECORDS */}
          {subTab === 'compensation' && (
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">
                    Registre Auditable des Rémunérations ({workspace?.compensations?.length || 0})
                  </h3>
                  <p className="text-xs text-slate-600">
                    Protection de sécurité active : Aucun transfert bancaire ou mobile-money réel n&apos;est déclenché automatiquement tant qu&apos;un prestataire de paiement n&apos;est pas configuré et testé (Mode <code>DISABLED_NO_LIVE_TRANSFER</code>).
                  </p>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-700">
                      <th className="p-3">ID</th>
                      <th className="p-3">Tâche / Projet</th>
                      <th className="p-3">Montant</th>
                      <th className="p-3">Statut de Paiement</th>
                      <th className="p-3">Mode Prestataire</th>
                      <th className="p-3">Note d&apos;Audit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {workspace?.compensations?.map((c: any) => (
                      <tr key={c.id}>
                        <td className="p-3 font-mono text-[11px]">{c.id}</td>
                        <td className="p-3">
                          <div className="font-semibold text-slate-900">{c.task_title}</div>
                          <div className="text-slate-500">{c.project_title}</div>
                        </td>
                        <td className="p-3 font-bold text-slate-900">
                          ${(Number(c.amount_cents) / 100).toFixed(2)} {c.currency}
                        </td>
                        <td className="p-3">
                          <span className="px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-900">
                            {c.payment_status}
                          </span>
                        </td>
                        <td className="p-3 font-mono text-[11px] text-slate-600">{c.provider_mode}</td>
                        <td className="p-3 text-slate-600">{c.audit_note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
