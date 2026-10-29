'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  GraduationCap,
  Briefcase,
  ShieldCheck,
  LogOut,
  UserCheck,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Lock,
} from 'lucide-react';
import { apiFetch } from '@/lib/core/client-http';
import { SchoolView } from './SchoolView';
import { BusinessView } from './BusinessView';
import { AdminCoreView } from './AdminCoreView';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: 'student' | 'teacher' | 'org_client' | 'contributor' | 'reviewer' | 'operator' | 'admin';
  countryCode: string;
  preferredLanguage: string;
}

const LOCAL_SYNTHETIC_ACCOUNTS = [
  {
    label: 'Apprenant School (Koffi - Terminale C)',
    email: 'student.koffi@synthetic.solob.local',
    role: 'student',
    pillar: 'school',
  },
  {
    label: 'Enseignant School (Mme Adjovi)',
    email: 'teacher.adjovi@synthetic.solob.local',
    role: 'teacher',
    pillar: 'school',
  },
  {
    label: 'Client Business (Cotonou Voice AI)',
    email: 'client.cotonou.ai@synthetic.solob.local',
    role: 'org_client',
    pillar: 'business',
  },
  {
    label: 'Contributeur Qualifié Fɔngbè (Sèna)',
    email: 'contributor.fon.verified@synthetic.solob.local',
    role: 'contributor',
    pillar: 'business',
  },
  {
    label: 'Contributeur Non-Vérifié (Moussa)',
    email: 'contributor.unverified@synthetic.solob.local',
    role: 'contributor',
    pillar: 'business',
  },
  {
    label: 'Reviewer QA Linguistique (Dr Aïcha)',
    email: 'reviewer.qa@synthetic.solob.local',
    role: 'reviewer',
    pillar: 'business',
  },
  {
    label: 'Opérateur SOLOB Business (Chukwudi)',
    email: 'operator.solob@synthetic.solob.local',
    role: 'operator',
    pillar: 'business',
  },
  {
    label: 'Admin SOLOB Core',
    email: 'admin@synthetic.solob.local',
    role: 'admin',
    pillar: 'core',
  },
];

export interface SolobAppShellProps {
  initialTab?: "overview" | "school" | "business" | "core" | "admin";
}

export function SolobAppShell({ initialTab = "overview" }: SolobAppShellProps = {}) {
  const normalizedInitial = initialTab === "admin" ? "core" : initialTab;
  const [activeTab, setActiveTab] = useState<'overview' | 'school' | 'business' | 'core'>(normalizedInitial);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loadingAuth, setLoadingAuth] = useState<boolean>(true);
  const [authModalMode, setAuthModalMode] = useState<'login' | 'register' | null>(null);
  const [overview, setOverview] = useState<any>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Auth form state
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [fullNameInput, setFullNameInput] = useState('');
  const [regRole, setRegRole] = useState<'student' | 'org_client' | 'contributor'>('student');
  const [countryInput, setCountryInput] = useState('BJ');

  const notify = (text: string, type: 'success' | 'error' = 'success') => {
    setStatusMessage({ type, text });
    setTimeout(() => {
      setStatusMessage((prev) => (prev?.text === text ? null : prev));
    }, 6000);
  };

  const fetchCurrentUserAndOverview = useCallback(async () => {
    setLoadingAuth(true);
    try {
      const [authRes, adminRes] = await Promise.all([
        apiFetch('/api/auth'),
        apiFetch('/api/admin'),
      ]);
      const authData = await authRes.json();
      const adminData = await adminRes.json();
      if (authData.ok) {
        setUser(authData.user || null);
      }
      if (adminData.ok) {
        setOverview(adminData.overview);
      }
    } catch {
      // ignore transient network errors on initial load
    } finally {
      setLoadingAuth(false);
    }
  }, []);

  useEffect(() => {
    fetchCurrentUserAndOverview();
  }, [fetchCurrentUserAndOverview]);

  const handleQuickSwitch = async (syntheticEmail: string, targetPillar: string) => {
    try {
      setLoadingAuth(true);
      const res = await apiFetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'login',
          email: syntheticEmail,
          password: process.env.NEXT_PUBLIC_SYNTHETIC_DEV_PASSWORD || 'SolobSynthetic#2026',
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(
          data.error?.message ||
            'Compte synthétique introuvable. Exécutez `npm run db:seed` localement hors production.'
        );
      }
      setUser(data.user);
      if (targetPillar === 'school') setActiveTab('school');
      else if (targetPillar === 'business') setActiveTab('business');
      else setActiveTab('core');
      notify(`Connecté en tant que ${data.user.fullName} (${data.user.role})`, 'success');
      await fetchCurrentUserAndOverview();
    } catch (err: any) {
      notify(err.message || 'Erreur de connexion', 'error');
    } finally {
      setLoadingAuth(false);
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoadingAuth(true);
      const payload =
        authModalMode === 'register'
          ? {
              action: 'register',
              email: emailInput,
              password: passwordInput,
              fullName: fullNameInput,
              role: regRole,
              countryCode: countryInput,
              preferredLanguage: 'fra',
              voiceDataConsent: true,
              linguisticDataConsent: true,
            }
          : {
              action: 'login',
              email: emailInput,
              password: passwordInput,
            };

      const res = await apiFetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error?.message || 'Authentification refusée');
      }
      setUser(data.user);
      setAuthModalMode(null);
      setPasswordInput('');
      notify(`Bienvenue sur SOLOB+, ${data.user.fullName} (${data.user.role}) !`, 'success');
      if (data.user.role === 'student' || data.user.role === 'teacher') {
        setActiveTab('school');
      } else if (data.user.role === 'admin') {
        setActiveTab('core');
      } else {
        setActiveTab('business');
      }
      await fetchCurrentUserAndOverview();
    } catch (err: any) {
      notify(err.message || 'Erreur lors de la requête', 'error');
    } finally {
      setLoadingAuth(false);
    }
  };

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logout' }),
      });
    } finally {
      setUser(null);
      notify('Session déconnectée et cookie HttpOnly révoqué.', 'success');
      fetchCurrentUserAndOverview();
    }
  };

  const allowSyntheticQuickSwitch =
    overview?.environmentStatus?.allowSyntheticQuickSwitch === true;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top African Institutional Identity Bar */}
      <div className="bg-slate-950 text-slate-200 text-xs py-2 px-4 border-b border-slate-800">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
            <span className="font-semibold tracking-wide text-white">SOLOB+</span>
            <span className="text-slate-400">|</span>
            <span>One Leg on School, One Leg on Business — Afrique Francophone & Multilingue</span>
          </div>
          <div className="flex items-center gap-3">
            {overview?.environmentStatus && (
              <>
                <span className="px-2 py-0.5 rounded bg-slate-800 text-emerald-300 font-mono">
                  IA: {overview.environmentStatus.aiMode}
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-800 text-amber-300 font-mono">
                  Paiements: {overview.environmentStatus.paymentProviderStatus}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Main Navigation Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <button
              onClick={() => setActiveTab('overview')}
              className="flex items-center gap-2.5 text-left group"
            >
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-600 via-teal-700 to-amber-600 flex items-center justify-center text-white font-bold text-lg shadow">
                S+
              </div>
              <div>
                <div className="font-bold text-lg leading-tight text-slate-900">SOLOB+</div>
                <div className="text-[11px] font-medium text-slate-500">
                  School • Business • Core
                </div>
              </div>
            </button>

            <nav className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
              <button
                onClick={() => setActiveTab('overview')}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition ${
                  activeTab === 'overview'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Vue d&apos;ensemble
              </button>
              <button
                onClick={() => setActiveTab('school')}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-medium flex items-center gap-1.5 transition ${
                  activeTab === 'school'
                    ? 'bg-emerald-700 text-white shadow-sm'
                    : 'text-slate-700 hover:text-emerald-800'
                }`}
              >
                <GraduationCap className="w-4 h-4" />
                SOLOB School
              </button>
              <button
                onClick={() => setActiveTab('business')}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-medium flex items-center gap-1.5 transition ${
                  activeTab === 'business'
                    ? 'bg-amber-700 text-white shadow-sm'
                    : 'text-slate-700 hover:text-amber-800'
                }`}
              >
                <Briefcase className="w-4 h-4" />
                SOLOB Business
              </button>
              <button
                onClick={() => setActiveTab('core')}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-medium flex items-center gap-1.5 transition ${
                  activeTab === 'core'
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'text-slate-700 hover:text-slate-900'
                }`}
              >
                <ShieldCheck className="w-4 h-4" />
                SOLOB Core & Labs
              </button>
            </nav>
          </div>

          {/* User session controls */}
          <div className="flex items-center gap-3">
            {user ? (
              <div className="flex items-center gap-3 bg-slate-100 px-3 py-1.5 rounded-xl border border-slate-200">
                <div className="text-right">
                  <div className="text-xs font-bold text-slate-900">{user.fullName}</div>
                  <div className="text-[11px] text-slate-600 flex items-center justify-end gap-1">
                    <span className="uppercase font-mono px-1.5 py-0.2 bg-emerald-100 text-emerald-800 rounded">
                      {user.role}
                    </span>
                    <span>• {user.countryCode}</span>
                  </div>
                </div>
                <button
                  onClick={handleLogout}
                  title="Se déconnecter"
                  className="p-1.5 rounded-lg bg-white text-slate-700 hover:bg-rose-50 hover:text-rose-700 border border-slate-200 transition"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setAuthModalMode('login')}
                  className="px-3.5 py-1.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100 border border-slate-300"
                >
                  Connexion
                </button>
                <button
                  onClick={() => setAuthModalMode('register')}
                  className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-emerald-700 text-white hover:bg-emerald-800 shadow-sm"
                >
                  Créer un compte
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Non-Production Local Test Account Switcher Bar (Strictly disabled in production) */}
        {allowSyntheticQuickSwitch && (
          <div className="bg-slate-100/90 border-t border-slate-200 px-4 py-2">
            <div className="max-w-7xl mx-auto flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold text-slate-700 flex items-center gap-1">
                <UserCheck className="w-3.5 h-3.5 text-emerald-700" />
                Comptes de test synthétiques (Développement local uniquement) :
              </span>
              {LOCAL_SYNTHETIC_ACCOUNTS.map((acc) => {
                const isActive = user?.email === acc.email;
                return (
                  <button
                    key={acc.email}
                    disabled={loadingAuth}
                    onClick={() => handleQuickSwitch(acc.email, acc.pillar)}
                    className={`px-2.5 py-1 rounded-md font-medium border transition ${
                      isActive
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-300 hover:border-slate-500'
                    }`}
                  >
                    {acc.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </header>

      {/* Status Notification Toast */}
      {statusMessage && (
        <div className="max-w-7xl mx-auto w-full px-4 pt-4">
          <div
            className={`p-3.5 rounded-xl border flex items-center justify-between text-sm font-medium shadow-sm ${
              statusMessage.type === 'error'
                ? 'bg-rose-50 border-rose-300 text-rose-900'
                : 'bg-emerald-50 border-emerald-300 text-emerald-900'
            }`}
          >
            <div className="flex items-center gap-2">
              {statusMessage.type === 'error' ? (
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              )}
              <span>{statusMessage.text}</span>
            </div>
            <button
              onClick={() => setStatusMessage(null)}
              className="text-xs underline ml-4 opacity-75 hover:opacity-100"
            >
              Fermer
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
        {activeTab === 'overview' && (
          <div className="space-y-8">
            {/* Hero Banner */}
            <div className="rounded-2xl bg-gradient-to-r from-slate-900 via-emerald-950 to-slate-900 text-white p-8 shadow-lg border border-slate-800">
              <div className="max-w-3xl space-y-4">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/20 border border-emerald-400/30 text-emerald-300 text-xs font-semibold">
                  <Sparkles className="w-3.5 h-3.5" />
                  Architecture Unifiée SOLOB+ — School • Business • Core
                </div>
                <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
                  One Leg on School, One Leg on Business.
                </h1>
                <p className="text-slate-300 text-base leading-relaxed">
                  SOLOB+ combine l&apos;excellence académique ancrée dans les programmes officiels
                  africains (<strong>SOLOB School</strong>) et une plateforme gérée d&apos;opérations
                  de données et de talents IA qualifiés en langues africaines (
                  <strong>SOLOB Business</strong>), propulsés par un socle commun de gouvernance,
                  d&apos;audit et d&apos;évaluation (<strong>SOLOB Core</strong>).
                </p>
                <div className="flex flex-wrap gap-3 pt-2">
                  <button
                    onClick={() => setActiveTab('school')}
                    className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm flex items-center gap-2 shadow"
                  >
                    <GraduationCap className="w-4 h-4" />
                    Ouvrir SOLOB School (Éducation & IA Ancrée)
                  </button>
                  <button
                    onClick={() => setActiveTab('business')}
                    className="px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold text-sm flex items-center gap-2 shadow"
                  >
                    <Briefcase className="w-4 h-4" />
                    Ouvrir SOLOB Business (Projets IA & Talents Qualifiés)
                  </button>
                </div>
              </div>
            </div>

            {/* Dual Pillar Architecture Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm flex flex-col justify-between space-y-4">
                <div className="space-y-3">
                  <div className="w-11 h-11 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center">
                    <GraduationCap className="w-6 h-6" />
                  </div>
                  <h2 className="text-xl font-bold text-slate-900">
                    Pilier 1 : SOLOB School (Académique)
                  </h2>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    Espace d&apos;apprentissage rigoureux pour élèves, étudiants et enseignants :
                    sélection du programme officiel (BAC Bénin, WAEC/WASSCE, UEMOA), téléversement
                    sécurisé de cours (PDF, TXT, MD, CSV, JSON), explications IA sourées avec citations
                    exactes, inspecteur d&apos;incertitude épistémique, fiches de révision, exercices
                    notés et suivi de progression.
                  </p>
                  <ul className="text-xs text-slate-700 space-y-1.5 pt-1">
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Ancrage documentaire strict avec citations vérifiables
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Génération de résumés, flashcards, exercices et barèmes
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Séparation stricte : aucune exposition des données scolaires aux clients Business
                    </li>
                  </ul>
                </div>
                <button
                  onClick={() => setActiveTab('school')}
                  className="w-full py-2.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-900 font-semibold text-sm border border-emerald-200 transition"
                >
                  Explorer l&apos;Espace SOLOB School →
                </button>
              </div>

              <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm flex flex-col justify-between space-y-4">
                <div className="space-y-3">
                  <div className="w-11 h-11 rounded-xl bg-amber-100 text-amber-800 flex items-center justify-center">
                    <Briefcase className="w-6 h-6" />
                  </div>
                  <h2 className="text-xl font-bold text-slate-900">
                    Pilier 2 : SOLOB Business (Opérations & Talents IA)
                  </h2>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    Plateforme gérée d&apos;opérations IA et linguistiques (Fɔngbè, Yorùbá, Wolof,
                    Hausa, Français, Anglais). Deux modes d&apos;engagement :{' '}
                    <strong>1. Projet Géré (Managed Project Delivery)</strong> et{' '}
                    <strong>2. Mise à disposition de Talents Qualifiés</strong>.
                  </p>
                  <ul className="text-xs text-slate-700 space-y-1.5 pt-1">
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-amber-600" />
                      Vérification linguistique obligatoire par test avant toute assignation
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-amber-600" />
                      Matching explicable (scores détaillés) & workflow QA multi-étapes
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-amber-600" />
                      Rapports de livraison autorisés et registre auditable des rémunérations
                    </li>
                  </ul>
                </div>
                <button
                  onClick={() => setActiveTab('business')}
                  className="w-full py-2.5 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 font-semibold text-sm border border-amber-200 transition"
                >
                  Explorer l&apos;Espace SOLOB Business →
                </button>
              </div>
            </div>

            {/* Live Database Counters */}
            {overview?.counts && (
              <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm">
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-4">
                  État Temps-Réel de la Base Relationnelle PostgreSQL (SOLOB Core)
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                    <div className="text-2xl font-extrabold text-slate-900">{overview.counts.users}</div>
                    <div className="text-xs text-slate-600">Comptes & Rôles RBAC</div>
                  </div>
                  <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200">
                    <div className="text-2xl font-extrabold text-emerald-900">{overview.counts.curricula}</div>
                    <div className="text-xs text-emerald-800">Programmes Officiels</div>
                  </div>
                  <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200">
                    <div className="text-2xl font-extrabold text-emerald-900">{overview.counts.schoolDocuments}</div>
                    <div className="text-xs text-emerald-800">Documents Pédagogiques</div>
                  </div>
                  <div className="p-4 rounded-xl bg-amber-50 border border-amber-200">
                    <div className="text-2xl font-extrabold text-amber-900">{overview.counts.businessProjects}</div>
                    <div className="text-xs text-amber-800">Projets Clients Business</div>
                  </div>
                  <div className="p-4 rounded-xl bg-amber-50 border border-amber-200">
                    <div className="text-2xl font-extrabold text-amber-900">{overview.counts.businessTasks}</div>
                    <div className="text-xs text-amber-800">Tâches Supervisées</div>
                  </div>
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                    <div className="text-2xl font-extrabold text-slate-900">{overview.counts.compensationRecords}</div>
                    <div className="text-xs text-slate-600">Lignes de Rémunération</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'school' && <SchoolView user={user} notify={notify} />}

        {activeTab === 'business' && <BusinessView user={user} notify={notify} />}

        {activeTab === 'core' && (
          <AdminCoreView
            user={user}
            overview={overview}
            notify={notify}
            refreshOverview={fetchCurrentUserAndOverview}
          />
        )}
      </main>

      {/* Auth Modal */}
      {authModalMode && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Lock className="w-4 h-4 text-emerald-700" />
                {authModalMode === 'login'
                  ? 'Connexion à SOLOB+'
                  : 'Créer un compte SOLOB+'}
              </h3>
              <button
                onClick={() => setAuthModalMode(null)}
                className="text-xs text-slate-500 hover:text-slate-900"
              >
                Fermer ✕
              </button>
            </div>

            <form onSubmit={handleAuthSubmit} className="space-y-3">
              {authModalMode === 'register' && (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Nom complet
                    </label>
                    <input
                      type="text"
                      required
                      value={fullNameInput}
                      onChange={(e) => setFullNameInput(e.target.value)}
                      placeholder="Ex: Nadia Houngbédji"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Rôle d&apos;inscription publique
                      </label>
                      <select
                        value={regRole}
                        onChange={(e) =>
                          setRegRole(
                            e.target.value as 'student' | 'org_client' | 'contributor'
                          )
                        }
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      >
                        <option value="student">Apprenant (School)</option>
                        <option value="org_client">Client Organisation (Business)</option>
                        <option value="contributor">Contributeur Talent (Business)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Pays (ISO)
                      </label>
                      <input
                        type="text"
                        maxLength={2}
                        value={countryInput}
                        onChange={(e) => setCountryInput(e.target.value.toUpperCase())}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 bg-slate-50 p-2 rounded border border-slate-200">
                    Note de sécurité RBAC : Les rôles institutionnels ou privilégiés (
                    <code>teacher</code>, <code>reviewer</code>, <code>operator</code>,{' '}
                    <code>admin</code>) ne peuvent pas être auto-attribués lors de
                    l&apos;inscription publique et nécessitent un provisionnement vérifié.
                  </p>
                </>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Adresse email
                </label>
                <input
                  type="email"
                  required
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="nom@organisation.bj"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Mot de passe (min. 8 caractères)
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <button
                type="submit"
                disabled={loadingAuth}
                className="w-full py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-semibold text-sm shadow"
              >
                {authModalMode === 'login' ? 'Se connecter' : "S'inscrire"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
