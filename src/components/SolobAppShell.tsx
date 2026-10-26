'use client';

import React, { useState, useEffect } from 'react';
import {
  GraduationCap,
  Briefcase,
  ShieldCheck,
  Layers,
  LogOut,
  UserCheck,
  Sparkles,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { SchoolView } from './SchoolView';
import { BusinessView } from './BusinessView';
import { AdminCoreView } from './AdminCoreView';

interface SolobAppShellProps {
  initialTab?: 'overview' | 'school' | 'business' | 'core';
}

const SYNTHETIC_QUICK_ACCOUNTS = [
  { label: 'Élève (School)', email: 'student@synthetic.solob.local', role: 'student' },
  { label: 'Enseignant (School)', email: 'teacher@synthetic.solob.local', role: 'teacher' },
  { label: 'Client Org (Business)', email: 'client@synthetic.solob.local', role: 'org_client' },
  { label: 'Contributeur Fɔngbè Vérifié', email: 'contributor.fon@synthetic.solob.local', role: 'contributor' },
  { label: 'Contributeur Non-Vérifié', email: 'contributor.unverified@synthetic.solob.local', role: 'contributor' },
  { label: 'Reviewer QA (Business)', email: 'reviewer@synthetic.solob.local', role: 'reviewer' },
  { label: 'Opérateur SOLOB (Business)', email: 'operator@synthetic.solob.local', role: 'operator' },
  { label: 'Admin (SOLOB Core)', email: 'admin@synthetic.solob.local', role: 'admin' },
];

export function SolobAppShell({ initialTab = 'overview' }: SolobAppShellProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'school' | 'business' | 'core'>(initialTab);
  const [user, setUser] = useState<any>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [overview, setOverview] = useState<any>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  // Auth modal / form state
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('student');

  const notify = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 5000);
  };

  const fetchAuthAndOverview = async (tokenOverride?: string | null) => {
    const tok = tokenOverride !== undefined ? tokenOverride : sessionToken;
    const headers: Record<string, string> = {};
    if (tok) headers.Authorization = `Bearer ${tok}`;
    try {
      const res = await fetch('/api/auth', { headers });
      const data = await res.json();
      if (data.ok) {
        setUser(data.user);
        setOverview(data.overview);
      }
    } catch {
      // ignore initial fetch error
    }
  };

  useEffect(() => {
    const savedToken = typeof window !== 'undefined' ? localStorage.getItem('solob_session_token') : null;
    if (savedToken) {
      setSessionToken(savedToken);
      fetchAuthAndOverview(savedToken);
    } else {
      fetchAuthAndOverview(null);
    }
  }, []);

  const handleQuickSwitch = async (syntheticEmail: string) => {
    try {
      // Ensure synthetic seed is loaded first
      await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'seed_synthetic' }),
      });

      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'login',
          email: syntheticEmail,
          password: 'SolobSynthetic#2026',
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Échec de connexion');
      setSessionToken(data.sessionToken);
      setUser(data.user);
      if (typeof window !== 'undefined') {
        localStorage.setItem('solob_session_token', data.sessionToken);
      }
      await fetchAuthAndOverview(data.sessionToken);
      notify(`Connecté en tant que ${data.user.fullName} (${data.user.role})`);
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload =
        authMode === 'login'
          ? { action: 'login', email, password }
          : { action: 'register', email, password, fullName, role };

      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur d’authentification');
      setSessionToken(data.sessionToken);
      setUser(data.user);
      if (typeof window !== 'undefined') {
        localStorage.setItem('solob_session_token', data.sessionToken);
      }
      setEmail('');
      setPassword('');
      setFullName('');
      await fetchAuthAndOverview(data.sessionToken);
      notify(`Authentification réussie : ${data.user.fullName} (${data.user.role})`);
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        },
        body: JSON.stringify({ action: 'logout', sessionToken }),
      });
      setSessionToken(null);
      setUser(null);
      if (typeof window !== 'undefined') {
        localStorage.removeItem('solob_session_token');
      }
      await fetchAuthAndOverview(null);
      notify('Session fermée avec succès.');
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 bg-slate-950 text-white border-b border-slate-800 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-amber-500 flex items-center justify-center font-black text-slate-950 text-lg">
              S+
            </div>
            <div>
              <div className="font-extrabold text-lg tracking-tight flex items-center gap-2">
                SOLOB+
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-emerald-300 border border-slate-700">
                  One Leg on School, One Leg on Business
                </span>
              </div>
              <div className="text-xs text-slate-400">
                Écosystème IA Africain : Apprentissage Académique & Livraison Gérée de Projets IA
              </div>
            </div>
          </div>

          {/* Pillar Switcher */}
          <nav className="flex items-center gap-1.5 bg-slate-900 p-1 rounded-xl border border-slate-800">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                activeTab === 'overview'
                  ? 'bg-white text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Layers className="w-3.5 h-3.5" /> Vue d&apos;Ensemble
            </button>
            <button
              onClick={() => setActiveTab('school')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                activeTab === 'school'
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <GraduationCap className="w-3.5 h-3.5" /> SOLOB School
            </button>
            <button
              onClick={() => setActiveTab('business')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                activeTab === 'business'
                  ? 'bg-amber-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Briefcase className="w-3.5 h-3.5" /> SOLOB Business
            </button>
            <button
              onClick={() => setActiveTab('core')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                activeTab === 'core'
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" /> SOLOB Core & Gouvernance
            </button>
          </nav>
        </div>

        {/* Role & Synthetic Account Switcher Sub-bar */}
        <div className="bg-slate-900/90 border-t border-slate-800 px-4 sm:px-6 py-2">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-slate-400 font-medium mr-1">Basculer profil synthétique de test :</span>
              {SYNTHETIC_QUICK_ACCOUNTS.map((acc) => (
                <button
                  key={acc.email}
                  onClick={() => handleQuickSwitch(acc.email)}
                  className={`px-2.5 py-1 rounded-md font-medium border transition ${
                    user?.email === acc.email
                      ? 'bg-emerald-600 text-white border-emerald-500'
                      : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                  }`}
                >
                  {acc.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              {user ? (
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-emerald-300 font-semibold">
                    <UserCheck className="w-3.5 h-3.5" />
                    {user.fullName} (<code>{user.role}</code>)
                  </span>
                  <button
                    onClick={handleLogout}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded bg-rose-900/70 hover:bg-rose-800 text-rose-200 text-[11px]"
                  >
                    <LogOut className="w-3 h-3" /> Déconnexion
                  </button>
                </div>
              ) : (
                <span className="text-amber-300">Non connecté — Sélectionnez un profil ou connectez-vous ci-dessous</span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 max-w-md">
          <div
            className={`p-4 rounded-xl shadow-lg border flex items-start gap-2.5 text-sm font-medium ${
              toast.type === 'error'
                ? 'bg-rose-950 text-rose-100 border-rose-700'
                : 'bg-emerald-950 text-emerald-100 border-emerald-700'
            }`}
          >
            {toast.type === 'error' ? (
              <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
            ) : (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            )}
            <span>{toast.msg}</span>
          </div>
        </div>
      )}

      {/* Main Content Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Hero Banner */}
            <div className="bg-gradient-to-r from-slate-900 via-emerald-950 to-slate-900 text-white rounded-2xl p-8 shadow-md border border-slate-800">
              <div className="max-w-3xl space-y-3">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 text-emerald-300 text-xs font-semibold">
                  <Sparkles className="w-3.5 h-3.5" /> Architecture Monolithe Modulaire • PostgreSQL 16 • RBAC Strict
                </div>
                <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
                  SOLOB+ : One Leg on School, One Leg on Business
                </h1>
                <p className="text-slate-300 text-sm sm:text-base leading-relaxed">
                  Deux piliers complémentaires partageant une fondation technique sécurisée (SOLOB Core). SOLOB School est strictement dédié à l&apos;excellence académique des élèves, étudiants et enseignants. SOLOB Business est une plateforme gérée d&apos;opérations de talents IA et de livraison de projets multilingues africains.
                </p>
              </div>

              {overview?.metrics && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-6 pt-6 border-t border-white/10">
                  <div className="bg-white/5 p-3 rounded-xl">
                    <div className="text-2xl font-bold text-white">{overview.metrics.usersCount}</div>
                    <div className="text-xs text-slate-300">Comptes Actifs</div>
                  </div>
                  <div className="bg-white/5 p-3 rounded-xl">
                    <div className="text-2xl font-bold text-emerald-400">{overview.metrics.schoolDocumentsCount}</div>
                    <div className="text-xs text-slate-300">Documents School</div>
                  </div>
                  <div className="bg-white/5 p-3 rounded-xl">
                    <div className="text-2xl font-bold text-emerald-400">{overview.metrics.schoolSubmissionsCount}</div>
                    <div className="text-xs text-slate-300">Copies Corrigées</div>
                  </div>
                  <div className="bg-white/5 p-3 rounded-xl">
                    <div className="text-2xl font-bold text-amber-400">{overview.metrics.businessProjectsCount}</div>
                    <div className="text-xs text-slate-300">Projets Business</div>
                  </div>
                  <div className="bg-white/5 p-3 rounded-xl">
                    <div className="text-2xl font-bold text-amber-400">{overview.metrics.businessTasksCount}</div>
                    <div className="text-xs text-slate-300">Tâches Assignées</div>
                  </div>
                  <div className="bg-white/5 p-3 rounded-xl">
                    <div className="text-2xl font-bold text-amber-400">{overview.metrics.deliveryReportsCount}</div>
                    <div className="text-xs text-slate-300">Rapports Livrés</div>
                  </div>
                </div>
              )}
            </div>

            {/* Two Pillars + Auth Card */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Pillar A: SOLOB School */}
              <div className="bg-white p-6 rounded-2xl border border-emerald-200 shadow-sm flex flex-col justify-between space-y-4">
                <div className="space-y-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center">
                    <GraduationCap className="w-6 h-6" />
                  </div>
                  <h2 className="text-xl font-bold text-slate-900">A. SOLOB School — Académique Uniquement</h2>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Conçu pour les collégiens, lycéens, étudiants universitaires et enseignants. Aucun mélange avec une place de marché d&apos;emploi.
                  </p>
                  <ul className="text-xs text-slate-700 space-y-1.5 list-disc list-inside">
                    <li>Profils par pays, programme (BAC/BEPC/WAEC) et matière avec statut vérifié/non-vérifié</li>
                    <li>Upload privé et extraction de documents pédagogiques autorisés</li>
                    <li>Tuteur IA ancré dans les sources avec niveau d&apos;incertitude explicite</li>
                    <li>Génération de résumés, flashcards, exercices et corrections détaillées sur barème</li>
                  </ul>
                </div>
                <button
                  onClick={() => setActiveTab('school')}
                  className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-semibold py-2.5 px-4 rounded-xl text-sm transition"
                >
                  Ouvrir l&apos;Espace SOLOB School →
                </button>
              </div>

              {/* Pillar B: SOLOB Business */}
              <div className="bg-white p-6 rounded-2xl border border-amber-200 shadow-sm flex flex-col justify-between space-y-4">
                <div className="space-y-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-800 flex items-center justify-center">
                    <Briefcase className="w-6 h-6" />
                  </div>
                  <h2 className="text-xl font-bold text-slate-900">B. SOLOB Business — Projets & Talents IA Gérés</h2>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Opérations gérées de bout en bout (Managed Projects & Qualified Talent Provision) — pas une plateforme freelance ouverte.
                  </p>
                  <ul className="text-xs text-slate-700 space-y-1.5 list-disc list-inside">
                    <li>Transcription, traduction & validation en langues africaines (Fɔngbè, Yorùbá, Wolof, Hausa)</li>
                    <li>Interdiction stricte d&apos;assigner un talent sans évaluation linguistique réussie</li>
                    <li>Isolation des tâches et fichiers par contributeur assigné</li>
                    <li>Revue QA, rapports de livraison clients et registre de rémunération auditable</li>
                  </ul>
                </div>
                <button
                  onClick={() => setActiveTab('business')}
                  className="w-full bg-amber-700 hover:bg-amber-800 text-white font-semibold py-2.5 px-4 rounded-xl text-sm transition"
                >
                  Ouvrir l&apos;Espace SOLOB Business →
                </button>
              </div>

              {/* Auth Registration / Login Card */}
              <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-bold text-slate-900">Authentification SOLOB Core</h2>
                  <div className="flex gap-1 bg-slate-100 p-1 rounded-lg text-xs">
                    <button
                      type="button"
                      onClick={() => setAuthMode('login')}
                      className={`px-2.5 py-1 rounded font-semibold ${
                        authMode === 'login' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-600'
                      }`}
                    >
                      Connexion
                    </button>
                    <button
                      type="button"
                      onClick={() => setAuthMode('register')}
                      className={`px-2.5 py-1 rounded font-semibold ${
                        authMode === 'register' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-600'
                      }`}
                    >
                      Inscription
                    </button>
                  </div>
                </div>

                <form onSubmit={handleAuthSubmit} className="space-y-3">
                  {authMode === 'register' && (
                    <>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Nom Complet</label>
                        <input
                          type="text"
                          required
                          value={fullName}
                          onChange={(e) => setFullName(e.target.value)}
                          placeholder="Ex: Sèdjro Hounsou"
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Rôle RBAC</label>
                        <select
                          value={role}
                          onChange={(e) => setRole(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        >
                          <option value="student">Élève / Étudiant (SOLOB School)</option>
                          <option value="teacher">Enseignant (SOLOB School)</option>
                          <option value="org_client">Organisation Cliente (SOLOB Business)</option>
                          <option value="contributor">Contributeur / Linguiste (SOLOB Business)</option>
                          <option value="reviewer">Réviseur QA (SOLOB Business)</option>
                          <option value="operator">Opérateur SOLOB (SOLOB Business)</option>
                        </select>
                      </div>
                    </>
                  )}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Adresse Email</label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="nom@domaine.org"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Mot de passe (min 8 caractères)</label>
                    <input
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-2.5 px-4 rounded-xl text-sm transition"
                  >
                    {authMode === 'login' ? 'Se Connecter' : 'Créer un Compte Sécurisé'}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'school' && (
          <SchoolView user={user} sessionToken={sessionToken} notify={notify} />
        )}

        {activeTab === 'business' && (
          <BusinessView user={user} sessionToken={sessionToken} notify={notify} />
        )}

        {activeTab === 'core' && (
          <AdminCoreView
            user={user}
            overview={overview}
            sessionToken={sessionToken}
            notify={notify}
            refreshOverview={() => fetchAuthAndOverview()}
          />
        )}
      </main>
    </div>
  );
}
