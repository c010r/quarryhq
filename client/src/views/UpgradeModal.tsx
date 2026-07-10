import { useEffect, useState } from 'react';
import { get, post } from '../api';
import type { Plan, PlanLimits, PlanUsage, User } from '../types';
import { btnGhost, btnPrimary, modalBackdrop, modalBox, modalClose } from '../ui';

const FREE_FEATURES = [
  '2 tableros · 50 tarjetas cada uno',
  '20 notas con wiki-links y grafo',
  '3 canales de chat con hilos',
  'Últimas 3 versiones de cada nota',
  'Búsqueda global y vinculación',
];

const PREMIUM_FEATURES = [
  'Tableros, tarjetas, notas y canales ilimitados',
  'Automatizaciones estilo Butler',
  'Vistas Tabla y Calendario',
  'Historial completo de versiones + restaurar',
  'Plantillas personalizadas',
  'Mensajes programados',
];

function UsageBar({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-18 text-dim">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink">
        <div className={`h-full rounded-full ${pct >= 100 ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`w-10 text-right ${pct >= 100 ? 'text-danger' : 'text-dim'}`}>{used}/{max}</span>
    </div>
  );
}

export default function UpgradeModal({ plan, premiumUntil, message, onClose, onChanged }: {
  plan: Plan;
  premiumUntil?: string | null;
  message?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  const [limits, setLimits] = useState<PlanLimits | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<{ user: User; limits: PlanLimits | null; usage: PlanUsage }>('/api/me')
      .then((d) => { setLimits(d.limits); setUsage(d.usage); })
      .catch(() => {});
  }, []);

  async function upgrade() {
    setBusy(true);
    try {
      await post('/api/billing/upgrade');
      onChanged();
      onClose();
    } finally { setBusy(false); }
  }

  async function cancelPremium() {
    if (!confirm('¿Cancelar Premium? Volverás al plan Free al instante.')) return;
    setBusy(true);
    try {
      await post('/api/billing/cancel');
      onChanged();
      onClose();
    } finally { setBusy(false); }
  }

  const planCard = 'flex-1 rounded-xl border p-4.5 flex flex-col gap-2.5';

  return (
    <div className={modalBackdrop} onClick={onClose}>
      <div className={`${modalBox} w-[640px]`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h3 className="font-display text-[20px] font-extrabold tracking-tight">
            {plan === 'premium' ? '★ Tu plan Premium' : 'Pasa a Premium'}
          </h3>
          <button className={modalClose} onClick={onClose}>✕</button>
        </div>

        {message && (
          <div className="rounded-lg border border-board/60 bg-board/10 px-3.5 py-2.5 text-[13px]">
            🔒 {message}
          </div>
        )}

        {plan === 'premium' && premiumUntil && (
          <p className="text-[13px] text-dim">
            Activo hasta el {new Date(premiumUntil).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })}.
            Cada renovación añade 30 días.
          </p>
        )}

        <div className="flex flex-col gap-3.5 sm:flex-row">
          <div className={`${planCard} border-edge bg-ink`}>
            <div className="flex items-baseline justify-between">
              <strong className="text-[15px]">Free</strong>
              <span className="text-[13px] text-dim">0 US$</span>
            </div>
            <ul className="flex flex-col gap-1.5 text-[12.5px] text-dim">
              {FREE_FEATURES.map((f) => <li key={f}>· {f}</li>)}
            </ul>
            {plan === 'free' && limits && usage && (
              <div className="mt-auto flex flex-col gap-1.5 border-t border-edge pt-2.5">
                <UsageBar label="Tableros" used={usage.boards} max={limits.boards} />
                <UsageBar label="Notas" used={usage.notes} max={limits.notes} />
                <UsageBar label="Canales" used={usage.channels} max={limits.channels} />
              </div>
            )}
          </div>

          <div className={`${planCard} border-accent bg-accent/5`}>
            <div className="flex items-baseline justify-between">
              <strong className="text-[15px] text-accent">★ Premium</strong>
              <span className="text-[13px]"><strong>9 US$</strong><span className="text-dim"> /mes</span></span>
            </div>
            <ul className="flex flex-col gap-1.5 text-[12.5px]">
              {PREMIUM_FEATURES.map((f) => <li key={f}>✓ {f}</li>)}
            </ul>
            <div className="mt-auto pt-2">
              {plan === 'free' ? (
                <button className={`${btnPrimary} w-full`} disabled={busy} onClick={upgrade}>
                  Activar Premium
                </button>
              ) : (
                <button className={btnGhost} disabled={busy} onClick={cancelPremium}>
                  Cancelar suscripción
                </button>
              )}
            </div>
          </div>
        </div>

        <p className="text-[11.5px] text-dim">
          Demo: el pago es simulado y activa 30 días de Premium al instante.
        </p>
      </div>
    </div>
  );
}
