'use client';

import React, { useState } from 'react';
import {
  ShieldCheck,
  Database,
  Globe,
  ToggleLeft,
  ToggleRight,
  Lock,
  Download,
  Activity,
  Cpu,
} from 'lucide-react';

interface AdminCoreViewProps {
  user: any;
  overview: any;
  sessionToken: string | null;
  notify: (msg: string, type?: 'success' | 'error') => void;
  refreshOverview: () => void;
}

export function AdminCoreView({
  user,
  overview,
  sessionToken,
  notify,
  refreshOverview,
}: AdminCoreViewProps) {
  const [retentionDays, setRetentionDays] = useState(365);
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [corpusConsent, setCorpusConsent] = useState(false);
  const [exportedPkg, setExportedPkg] = useState<any>(null);

  const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
  };

  const handleToggleFlag = async (key: string, currentEnabled: boolean) => {
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          action: 'toggle_flag',
          key,
          enabled: !currentEnabled,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur lors de la modification du Feature Flag');
      notify(`Feature flag "${key}" mis à jour : ${data.flag.enabled ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`);
      refreshOverview();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleSavePrivacy = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          action: 'privacy_update',
          privacyRetentionDays: Number(retentionDays),
          voiceDataConsent: voiceConsent,
          linguisticDataConsent: corpusConsent,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur de sauvegarde');
      notify('Paramètres de confidentialité, rétention et consentement linguistique mis à jour.');
      refreshOverview();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  const handleExportData = async () => {
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ action: 'data_export' }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Erreur lors de l’export');
      setExportedPkg(data.exportPackage);
      notify('Archive d’export de données personnelles générée.');
      refreshOverview();
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-slate-900 text-white rounded-2xl p-6 shadow-md border border-slate-800">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800 text-emerald-300 text-xs font-semibold mb-2">
          <ShieldCheck className="w-4 h-4" />
          SOLOB CORE & SOLOB LABS — INFRASTRUCTURE PARTAGÉE, AUDIT & GOUVERNANCE
        </div>
        <h2 className="text-2xl font-bold">Sécurité, Registre Multilingue Africain, Consentement & Audit</h2>
        <p className="text-slate-300 text-sm mt-1">
          Contrôle d&apos;accès RBAC côté serveur, anonymisation automatique des journaux d&apos;audit, suivi des coûts IA et droits sur les données vocales/linguistiques.
        </p>
      </div>

      {/* Infrastructure & Runtime Status Cards */}
      {overview?.environmentStatus && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
            <div className="text-xs font-bold uppercase text-slate-500 flex items-center gap-1.5">
              <Database className="w-4 h-4 text-emerald-600" /> Moteur Relationnel
            </div>
            <div className="text-sm font-bold text-slate-900 mt-1">
              {overview.environmentStatus.databaseEngine}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">PostgreSQL 16 (30 tables actives)</div>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
            <div className="text-xs font-bold uppercase text-slate-500 flex items-center gap-1.5">
              <Cpu className="w-4 h-4 text-amber-600" /> Abstraction IA Serveur
            </div>
            <div className="text-sm font-bold text-slate-900 mt-1">
              Mode : {overview.environmentStatus.aiMode}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Modèle : {overview.environmentStatus.aiModel}
            </div>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
            <div className="text-xs font-bold uppercase text-slate-500 flex items-center gap-1.5">
              <Lock className="w-4 h-4 text-rose-600" /> Paiements & Transferts
            </div>
            <div className="text-sm font-bold text-slate-900 mt-1">
              {overview.environmentStatus.paymentProviderStatus}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">Aucun transfert réel non autorisé</div>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
            <div className="text-xs font-bold uppercase text-slate-500 flex items-center gap-1.5">
              <Activity className="w-4 h-4 text-blue-600" /> Stockage Objet Privé
            </div>
            <div className="text-sm font-bold text-slate-900 mt-1">
              {overview.environmentStatus.storageProvider}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">Validation MIME + SHA-256</div>
          </div>
        </div>
      )}

      {/* African Language Registry & Feature Flags */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
          <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Globe className="w-5 h-5 text-emerald-600" />
            Registre des Langues & Dialectes Africains (Transparence de Couverture)
          </h3>
          <p className="text-xs text-slate-600">
            SOLOB+ distingue honnêtement les langues disposant d&apos;évaluateurs vérifiés de celles en phase de préparation.
          </p>
          <div className="space-y-3">
            {overview?.languagesRegistry?.map((lang: any) => (
              <div key={lang.code} className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sm text-slate-900">
                    {lang.name} ({lang.native_name}) — <code className="text-xs">{lang.code}</code>
                  </span>
                  <div className="flex gap-1.5">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        lang.school_verified
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-slate-200 text-slate-700'
                      }`}
                    >
                      School: {lang.school_verified ? 'VÉRIFIÉ' : 'NON VÉRIFIÉ'}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        lang.business_verified
                          ? 'bg-amber-100 text-amber-900'
                          : 'bg-slate-200 text-slate-700'
                      }`}
                    >
                      Business: {lang.business_verified ? 'VÉRIFIÉ' : 'NON VÉRIFIÉ'}
                    </span>
                  </div>
                </div>
                <div className="text-xs text-slate-600">
                  Dialectes : {(lang.dialects_json || []).join(', ')}
                </div>
                <div className="text-[11px] text-slate-500">{lang.notes}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Feature Flags & Privacy/Consent Controls */}
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <h3 className="text-lg font-bold text-slate-900">Feature Flags & SOLOB Labs</h3>
            <div className="space-y-3">
              {overview?.featureFlags?.map((flag: any) => (
                <div key={flag.key} className="p-3 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
                  <div>
                    <div className="font-mono text-xs font-bold text-slate-900">{flag.key}</div>
                    <div className="text-xs text-slate-600 mt-0.5">{flag.description}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggleFlag(flag.key, flag.enabled)}
                    className={`px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 ${
                      flag.enabled
                        ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                        : 'bg-slate-200 text-slate-700 border border-slate-300'
                    }`}
                  >
                    {flag.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                    {flag.enabled ? 'ON' : 'OFF'}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <form onSubmit={handleSavePrivacy} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <h3 className="text-lg font-bold text-slate-900">
              Confidentialité, Rétention & Consentement Jeux de Données Linguistiques
            </h3>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Durée de rétention des données personnelles (jours)
              </label>
              <input
                type="number"
                min={30}
                max={3650}
                value={retentionDays}
                onChange={(e) => setRetentionDays(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={voiceConsent}
                onChange={(e) => setVoiceConsent(e.target.checked)}
              />
              Consentement explicite pour l&apos;utilisation d&apos;échantillons vocaux dans les projets supervisés SOLOB Business
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={corpusConsent}
                onChange={(e) => setCorpusConsent(e.target.checked)}
              />
              Consentement explicite pour l&apos;inclusion de mes annotations linguistiques dans les livrables clients autorisés
            </label>
            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                className="bg-slate-900 hover:bg-slate-800 text-white font-semibold py-2 px-4 rounded-lg text-xs transition"
              >
                Enregistrer mes Droits & Consentements
              </button>
              <button
                type="button"
                onClick={handleExportData}
                className="inline-flex items-center gap-1.5 bg-emerald-700 hover:bg-emerald-800 text-white font-semibold py-2 px-4 rounded-lg text-xs transition"
              >
                <Download className="w-4 h-4" /> Exporter mes Données (Portabilité)
              </button>
            </div>
            {exportedPkg && (
              <pre className="p-3 rounded-lg bg-slate-900 text-emerald-300 text-[11px] overflow-x-auto max-h-40">
                {JSON.stringify(exportedPkg, null, 2)}
              </pre>
            )}
          </form>
        </div>
      </div>

      {/* Audit Trail Table */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
        <h3 className="text-lg font-bold text-slate-900">
          Journal d&apos;Audit Sécurisé ({overview?.auditEvents?.length || 0} événements récents — Secrets & Mots de passe automatiquement expurgés)
        </h3>
        <div className="overflow-x-auto max-h-80">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-700">
                <th className="p-2.5">Horodatage</th>
                <th className="p-2.5">Pilier</th>
                <th className="p-2.5">Rôle</th>
                <th className="p-2.5">Action</th>
                <th className="p-2.5">Statut</th>
                <th className="p-2.5">Métadonnées Expurgées (Redacted)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {overview?.auditEvents?.map((ev: any) => (
                <tr key={ev.id}>
                  <td className="p-2.5 text-[11px] text-slate-500">
                    {new Date(ev.created_at).toLocaleString('fr-FR')}
                  </td>
                  <td className="p-2.5 uppercase font-bold text-[11px]">{ev.pillar}</td>
                  <td className="p-2.5 font-mono text-[11px]">{ev.actor_role || 'anonymous'}</td>
                  <td className="p-2.5 font-semibold text-slate-900">{ev.action}</td>
                  <td className="p-2.5">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        ev.status === 'SUCCESS'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-rose-100 text-rose-800'
                      }`}
                    >
                      {ev.status}
                    </span>
                  </td>
                  <td className="p-2.5 font-mono text-[11px] text-slate-600 max-w-md truncate">
                    {JSON.stringify(ev.redacted_metadata_json)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
