import { useCallback, useEffect, useState } from 'react';
import { del, get, post } from '../api';
import type { Plan, PlanLimits, PlanUsage, TeamInfo, User } from '../types';
import { btnGhost, btnSmall, inputBase, modalBackdrop, modalBox, modalClose } from '../ui';

const FREE_FEATURES = [
  '2 tableros · 50 tarjetas c/u',
  '20 notas · 3 canales',
  'Grafo, búsqueda y vinculación',
  'Últimas 3 versiones por nota',
];

const PREMIUM_FEATURES = [
  'Todo ilimitado',
  'Automatizaciones (Butler)',
  'Vistas Tabla y Calendario',
  'Historial completo + restaurar',
  'Plantillas personalizadas',
  'Mensajes programados',
];

const TEAM_FEATURES = [
  'Todo lo de Premium',
  '5 cuentas: tú + 4 miembros',
  'Gestión de miembros del equipo',
];

interface Me { user: User; team: TeamInfo; limits: PlanLimits | null; usage: PlanUsage }

function UsageBar({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-16 text-dim">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink">
        <div className={`h-full rounded-full ${pct >= 100 ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`w-10 text-right ${pct >= 100 ? 'text-danger' : 'text-dim'}`}>{used}/{max}</span>
    </div>
  );
}

export default function UpgradeModal({ plan, message, onClose, onChanged }: {
  plan: Plan;
  message?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [memberName, setMemberName] = useState('');
  const [redeemCode, setRedeemCode] = useState('');

  const reload = useCallback(() => get<Me>('/api/me').then(setMe).catch(() => {}), []);
  useEffect(() => { reload(); }, [reload]);

  const subscription = me?.user.subscription ?? 'none';
  const effectivePlan = me?.user.plan ?? plan;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reload();
      onChanged();
    } catch (err: any) {
      alert(err.message);
    } finally { setBusy(false); }
  }

  const upgrade = (tier: 'premium' | 'team') => act(() => post('/api/billing/upgrade', { plan: tier }));
  const cancelSub = () => {
    if (!confirm('¿Cancelar la suscripción? Volverás al plan Free al instante.')) return;
    act(() => post('/api/billing/cancel'));
  };
  const addMember = () => {
    const username = memberName.trim();
    if (!username) return;
    act(async () => { await post('/api/team/members', { username }); setMemberName(''); });
  };
  const removeMember = (userId: number) => act(() => del(`/api/team/members/${userId}`));

  const redeem = () => {
    const code = redeemCode.trim();
    if (!code) return;
    act(async () => {
      const { days } = await post<{ days: number }>('/api/invites/redeem', { code });
      setRedeemCode('');
      alert(`¡Código canjeado! Tienes ${days} días de Premium.`);
    });
  };

  const card = 'flex flex-1 flex-col gap-2.5 rounded-xl border p-4';
  const price = (n: string) => <span className="text-[13px]"><strong>{n} US$</strong><span className="text-dim"> /mes</span></span>;
  const activeBadge = <span className="rounded-full bg-ok/15 px-2 py-0.5 text-[11px] font-semibold text-ok">Tu plan</span>;

  return (
    <div className={modalBackdrop} onClick={onClose}>
      <div className={`${modalBox} w-[760px]`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h3 className="font-display text-[20px] font-extrabold tracking-tight">
            {effectivePlan === 'premium' ? '★ Tu plan' : 'Pasa a Premium'}
          </h3>
          <button className={modalClose} onClick={onClose}>✕</button>
        </div>

        {message && (
          <div className="rounded-lg border border-board/60 bg-board/10 px-3.5 py-2.5 text-[13px]">
            🔒 {message}
          </div>
        )}

        {me?.team?.role === 'member' && (
          <div className="rounded-lg border border-accent/50 bg-accent/10 px-3.5 py-2.5 text-[13px]">
            ★ Tienes Premium por el equipo de <strong>@{me.team.owner}</strong>.
          </div>
        )}

        {subscription !== 'none' && me?.user.premium_until && (
          <p className="text-[13px] text-dim">
            Suscripción {subscription === 'team' ? 'Equipos' : 'Individual'} activa hasta el{' '}
            {new Date(me.user.premium_until).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })}.
            Cada renovación añade 30 días.
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row">
          <div className={`${card} border-edge bg-ink`}>
            <div className="flex items-baseline justify-between">
              <strong className="text-[15px]">Free</strong>
              <span className="text-[13px] text-dim">0 US$</span>
            </div>
            <ul className="flex flex-col gap-1.5 text-[12.5px] text-dim">
              {FREE_FEATURES.map((f) => <li key={f}>· {f}</li>)}
            </ul>
            {effectivePlan === 'free' && me?.limits && me.usage && (
              <div className="mt-auto flex flex-col gap-1.5 border-t border-edge pt-2.5">
                <UsageBar label="Tableros" used={me.usage.boards} max={me.limits.boards} />
                <UsageBar label="Notas" used={me.usage.notes} max={me.limits.notes} />
                <UsageBar label="Canales" used={me.usage.channels} max={me.limits.channels} />
              </div>
            )}
          </div>

          <div className={`${card} border-accent bg-accent/5`}>
            <div className="flex items-baseline justify-between gap-2">
              <strong className="text-[15px] text-accent">★ Individual</strong>
              {subscription === 'premium' ? activeBadge : price('9,99')}
            </div>
            <ul className="flex flex-col gap-1.5 text-[12.5px]">
              {PREMIUM_FEATURES.map((f) => <li key={f}>✓ {f}</li>)}
            </ul>
            <div className="mt-auto pt-2">
              {subscription === 'premium' ? (
                <button className={btnGhost} disabled={busy} onClick={cancelSub}>Cancelar suscripción</button>
              ) : (
                <button className="w-full rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-ink transition hover:brightness-110 disabled:opacity-50"
                  disabled={busy} onClick={() => upgrade('premium')}>
                  {subscription === 'team' ? 'Cambiar a Individual' : 'Activar Individual'}
                </button>
              )}
            </div>
          </div>

          <div className={`${card} border-note bg-note/5`}>
            <div className="flex items-baseline justify-between gap-2">
              <strong className="text-[15px] text-note">👥 Equipos</strong>
              {subscription === 'team' ? activeBadge : price('19,99')}
            </div>
            <ul className="flex flex-col gap-1.5 text-[12.5px]">
              {TEAM_FEATURES.map((f) => <li key={f}>✓ {f}</li>)}
            </ul>
            <div className="mt-auto pt-2">
              {subscription === 'team' ? (
                <button className={btnGhost} disabled={busy} onClick={cancelSub}>Cancelar suscripción</button>
              ) : (
                <button className="w-full rounded-lg bg-note px-3 py-2 text-[13px] font-semibold text-ink transition hover:brightness-110 disabled:opacity-50"
                  disabled={busy} onClick={() => upgrade('team')}>
                  {subscription === 'premium' ? 'Cambiar a Equipos' : 'Activar Equipos'}
                </button>
              )}
            </div>
          </div>
        </div>

        {me?.team?.role === 'owner' && (
          <div className="rounded-xl border border-edge bg-ink p-4">
            <div className="mb-2 text-[13px] font-semibold">
              👥 Miembros del equipo <span className="font-normal text-dim">({me.team.members.length}/{me.team.max_members} además de ti)</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {me.team.members.map((m) => (
                <div key={m.id} className="flex items-center justify-between rounded-lg bg-raised px-3 py-1.5 text-[13px]">
                  <span>@{m.username} <span className="text-[11px] text-accent">★ Premium</span></span>
                  <button className="text-xs text-danger opacity-80 hover:opacity-100" disabled={busy}
                    onClick={() => removeMember(m.id)}>Quitar</button>
                </div>
              ))}
              {me.team.members.length === 0 && (
                <p className="text-[12.5px] text-dim">Aún no invitaste a nadie. Los miembros reciben Premium al instante.</p>
              )}
            </div>
            {me.team.members.length < me.team.max_members && (
              <form className="mt-2.5 flex gap-2" onSubmit={(e) => { e.preventDefault(); addMember(); }}>
                <input className={`${inputBase} flex-1 py-1.5 text-[13px]`} placeholder="Username del miembro…"
                  value={memberName} onChange={(e) => setMemberName(e.target.value)} />
                <button className={btnSmall} disabled={busy || !memberName.trim()}>Invitar</button>
              </form>
            )}
          </div>
        )}

        {subscription === 'none' && (
          <form className="flex items-center gap-2 rounded-xl border border-dashed border-edge px-4 py-3"
            onSubmit={(e) => { e.preventDefault(); redeem(); }}>
            <span className="text-[13px] text-dim">🎟 ¿Tienes un código de invitación?</span>
            <input className={`${inputBase} flex-1 py-1.5 font-mono text-[13px] uppercase`} placeholder="QHQ-XXXX-XXXX"
              value={redeemCode} onChange={(e) => setRedeemCode(e.target.value.toUpperCase())} />
            <button className={btnSmall} disabled={busy || !redeemCode.trim()}>Canjear</button>
          </form>
        )}

        <p className="text-[11.5px] text-dim">
          Demo: el pago es simulado y activa 30 días al instante.
        </p>
      </div>
    </div>
  );
}
