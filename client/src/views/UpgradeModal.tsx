import { useCallback, useEffect, useState } from 'react';
import { del, get, post } from '../api';
import type { Plan, PlanLimits, PlanUsage, TeamInfo, User } from '../types';
import { btnDanger, btnGhost, btnSmall, infoBanner, inputBase, modalBackdrop, modalBox, modalClose } from '../ui';
import { alertDialog, confirmDialog } from '../dialog';
import { useModalA11y } from '../useModalA11y';

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

interface Invoice {
  id: number; plan: string; amount_cents: number; currency: string; days: number;
  method: string; status: string; period_start: string | null; period_end: string | null;
  invoice_url: string | null; hosted_invoice_url: string | null; created_at: string;
}

interface Me { user: User; team: TeamInfo; limits: PlanLimits | null; usage: PlanUsage }

function UsageBar({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  const full = pct >= 100;
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-16 text-dim">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink"
        role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={max}
        aria-label={`${label}: ${used} de ${max}`}>
        <div className={`h-full rounded-full ${full ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`w-10 text-right ${full ? 'text-danger' : 'text-dim'}`}>{used}/{max}</span>
    </div>
  );
}

function formatMoney(cents: number, currency: string): string {
  try { return new Intl.NumberFormat('es', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100); }
  catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return iso; }
}

export default function UpgradeModal({ plan, message, onClose, onChanged }: {
  plan: Plan;
  message?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [memberName, setMemberName] = useState('');
  const [redeemCode, setRedeemCode] = useState('');
  const [tab, setTab] = useState<'planes' | 'facturas'>('planes');

  const reload = useCallback(() => get<Me>('/api/me').then(setMe).catch(() => {}), []);
  const reloadInvoices = useCallback(
    () => get<{ invoices: Invoice[] }>('/api/billing/invoices').then((d) => setInvoices(d.invoices)).catch(() => {}),
    []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { if (tab === 'facturas') reloadInvoices(); }, [tab, reloadInvoices]);

  const subscription = me?.user.subscription ?? 'none';
  const effectivePlan = me?.user.plan ?? plan;
  // Stripe está activo en el servidor solo si STRIPE_SECRET_KEY está seteado; lo
  // deducimos del proceso (no hay endpoint público que lo revele por seguridad):
  // a través del modo de respuesta de /api/billing/upgrade — si no hay Stripe,
  // responde el objeto simulado sin "url". Antes de saberlo, asumimos true para
  // que el botón cargue Checkout y recién ahí descubramos el modo.
  const hasStripeCustomer = !!me?.user.stripe_customer_id;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reload();
      onChanged();
    } catch (err: any) {
      alertDialog(err.message);
    } finally { setBusy(false); }
  }

  const upgrade = (tier: 'premium' | 'team') => act(async () => {
    const data = await post<{ mode?: string; url?: string; plan?: string; premium_until?: string }>('/api/billing/upgrade', { plan: tier });
    // Si el servidor usa Stripe, responde {mode:'stripe', url}. Redirigimos al
    // Checkout hosted; el webhook nos activará el plan al confirmarse el pago.
    if (data.mode === 'stripe' && data.url) {
      window.location.href = data.url;
      return;
    }
    // Sin Stripe (modo simulado): la respuesta ya trae plan+premium_until, el
    // reload() del wrapper actualiza la UI. Nada más que hacer acá.
  });

  const openPortal = () => act(async () => {
    try {
      const { url } = await post<{ url: string }>('/api/billing/portal');
      window.location.href = url;
    } catch (err: any) {
      alertDialog(err.message);
    }
  });

  const cancelSub = async () => {
    // Con Stripe activo, el servidor responde 409 `use_portal` y NO cancela
    // inmediatamente: el usuario debe ir al Portal para conservar lo ya pagado.
    // Sin Stripe, sigue siendo cancelación local instantánea.
    if (!await confirmDialog(
      hasStripeCustomer
        ? 'Vas a abrir el Portal de Stripe para cancelar la suscripción. Conservarás Premium hasta el fin del período ya pagado.'
        : '¿Cancelar la suscripción? Volverás al plan Free al instante.',
      { danger: true, confirmText: 'Continuar', cancelText: 'Volver' }
    )) return;
    try {
      setBusy(true);
      await post('/api/billing/cancel');
      await reload();
      onChanged();
    } catch (err: any) {
      if (err.code === 'use_portal') {
        await openPortal();
      } else {
        alertDialog(err.message);
      }
    } finally { setBusy(false); }
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
      alertDialog(`¡Código canjeado! Tienes ${days} días de Premium.`);
    });
  };

  const card = 'flex flex-1 flex-col gap-2.5 rounded-xl border p-4';
  const price = (n: string) => <span className="text-[13px]"><strong>{n} US$</strong><span className="text-dim"> /mes</span></span>;
  const activeBadge = <span className="rounded-full bg-ok/15 px-2 py-0.5 text-[11px] font-semibold text-ok" role="status">Tu plan</span>;

  const containerRef = useModalA11y(onClose);

  return (
    <div ref={containerRef} className={modalBackdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${modalBox} max-w-[760px]`}>
        <div className="flex items-start justify-between">
          <h3 className="font-display text-[20px] font-extrabold tracking-tight">
            {effectivePlan === 'premium' ? '★ Tu plan' : 'Pasa a Premium'}
          </h3>
          <button className={modalClose} aria-label="Cerrar" onClick={onClose}>✕</button>
        </div>

        {message && (
          <div className={infoBanner('board')} role="status">
            🔒 {message}
          </div>
        )}

        {me?.team?.role === 'member' && (
          <div className={infoBanner('accent')} role="status">
            ★ Tienes Premium por el equipo de <strong>@{me.team.owner}</strong>.
          </div>
        )}

        {subscription !== 'none' && me?.user.premium_until && (
          <p className="text-[13px] text-dim">
            Suscripción {subscription === 'team' ? 'Equipos' : 'Individual'} activa hasta el{' '}
            {new Date(me.user.premium_until).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })}.
            {hasStripeCustomer ? ' Se renueva automáticamente; cancela desde el Portal de Stripe.' : ' Cada renovación añade 30 días.'}
          </p>
        )}

        {hasStripeCustomer && (
          <div className="flex flex-wrap gap-2">
            <button className={btnGhost} disabled={busy} onClick={openPortal}>
              Portal de facturación
            </button>
            <div className="flex rounded-lg border border-edge bg-ink p-0.5 text-[12.5px]" role="tablist">
              <button role="tab" aria-selected={tab === 'planes'} aria-pressed={tab === 'planes'}
                className={`rounded-md px-3 py-1 ${tab === 'planes' ? 'bg-accent text-ink' : 'text-dim'}`}
                onClick={() => setTab('planes')}>Planes</button>
              <button role="tab" aria-selected={tab === 'facturas'} aria-pressed={tab === 'facturas'}
                className={`rounded-md px-3 py-1 ${tab === 'facturas' ? 'bg-accent text-ink' : 'text-dim'}`}
                onClick={() => setTab('facturas')}>Facturas</button>
            </div>
          </div>
        )}

        {tab === 'planes' && (
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
                  <button className="w-full rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-ink transition hover:brightness-110 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100"
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
                  <button className="w-full rounded-lg bg-note px-3 py-2 text-[13px] font-semibold text-ink transition hover:brightness-110 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100"
                    disabled={busy} onClick={() => upgrade('team')}>
                    {subscription === 'premium' ? 'Cambiar a Equipos' : 'Activar Equipos'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === 'facturas' && (
          <div className="rounded-xl border border-edge bg-ink p-3">
            {invoices.length === 0 ? (
              <p className="py-6 text-center text-[12.5px] text-dim">Aún no hay facturas registradas.</p>
            ) : (
              <table className="w-full text-[12.5px]">
                <thead className="text-dim">
                  <tr className="text-left">
                    <th className="pb-2 font-medium">Fecha</th>
                    <th className="pb-2 font-medium">Plan</th>
                    <th className="pb-2 font-medium">Monto</th>
                    <th className="pb-2 font-medium">Período</th>
                    <th className="pb-2 font-medium">Estado</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="border-t border-edge">
                      <td className="py-1.5">{formatDate(inv.created_at)}</td>
                      <td className="py-1.5">{inv.plan === 'team' ? 'Equipos' : inv.plan === 'premium' ? 'Individual' : inv.plan}</td>
                      <td className="py-1.5">{formatMoney(inv.amount_cents, inv.currency)}</td>
                      <td className="py-1.5 text-dim">{formatDate(inv.period_start)}–{formatDate(inv.period_end)}</td>
                      <td className="py-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          inv.status === 'paid' ? 'bg-ok/15 text-ok'
                          : inv.status === 'past_due' ? 'bg-danger/15 text-danger'
                          : 'bg-edge text-dim'
                        }`}>{inv.status}</span>
                      </td>
                      <td className="py-1.5 text-right">
                        {inv.hosted_invoice_url && (
                          <a href={inv.hosted_invoice_url} target="_blank" rel="noopener noreferrer"
                            className="text-accent hover:underline">Ver</a>
                        )}
                        {inv.invoice_url && (
                          <a href={inv.invoice_url} target="_blank" rel="noopener noreferrer"
                            className="ml-2 text-dim hover:underline">PDF</a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-[11.5px] text-dim">
              Las facturas las emite Stripe. Para actualizar tu método de pago o cancelar abre el Portal.
            </p>
          </div>
        )}

        {me?.team?.role === 'owner' && (
          <div className="rounded-xl border border-edge bg-ink p-4">
            <div className="mb-2 text-[13px] font-semibold">
              👥 Miembros del equipo <span className="font-normal text-dim">({me.team.members.length}/{me.team.max_members} además de ti)</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {me.team.members.map((m) => (
                <div key={m.id} className="flex items-center justify-between rounded-lg bg-raised px-3 py-1.5 text-[13px]">
                  <span>@{m.username} <span className="text-[11px] text-accent">★ Premium</span></span>
                  <button className={btnDanger} disabled={busy}
                    onClick={() => removeMember(m.id)}>Quitar</button>
                </div>
              ))}
              {me.team.members.length === 0 && (
                <p className="flex flex-col items-center gap-1 rounded-lg bg-raised px-3 py-3 text-center text-[12.5px] text-dim">
                  <span className="text-xl opacity-60" aria-hidden>👥</span>
                  Aún no invitaste a nadie. Los miembros reciben Premium al instante.
                </p>
              )}
            </div>
            {me.team.members.length < me.team.max_members && (
              <form className="mt-2.5 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); addMember(); }}>
                <input className={`${inputBase} min-w-0 flex-1 py-1.5 text-[13px]`} placeholder="Username del miembro…"
                  value={memberName} onChange={(e) => setMemberName(e.target.value)} />
                <button className={btnSmall} disabled={busy || !memberName.trim()}>Invitar</button>
              </form>
            )}
          </div>
        )}

        {subscription === 'none' && (
          <form className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-edge px-4 py-3"
            onSubmit={(e) => { e.preventDefault(); redeem(); }}>
            <span className="text-[13px] text-dim">🎟 ¿Tienes un código de invitación?</span>
            <input className={`${inputBase} min-w-0 flex-1 py-1.5 font-mono text-[13px] uppercase`} placeholder="QHQ-XXXX-XXXX"
              value={redeemCode} onChange={(e) => setRedeemCode(e.target.value.toUpperCase())} />
            <button className={btnSmall} disabled={busy || !redeemCode.trim()}>Canjear</button>
          </form>
        )}

        <p className="text-[11.5px] text-dim">
          {hasStripeCustomer
            ? 'Pago gestionado por Stripe. Las suscripciones se renuevan automáticamente.'
            : 'Demo: el pago es simulado y activa 30 días al instante.'}
        </p>
      </div>
    </div>
  );
}