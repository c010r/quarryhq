import { useCallback, useEffect, useState } from 'react';
import { del, get, post } from '../api';
import type { AdminPayment, AdminUser, InviteCode } from '../types';
import { btnSmall, emptyState, mainHeader, viewTitle } from '../ui';
import { alertDialog, confirmDialog } from '../dialog';

interface AdminStats {
  users: number;
  premium_subs: number;
  team_subs: number;
  verified: number;
  invite_redemptions: number;
  revenue_cents: number;
}

type Tab = 'usuarios' | 'pagos' | 'invitaciones';

const money = (cents: number, currency = 'USD') =>
  `${(cents / 100).toFixed(2).replace('.', ',')} ${currency === 'USD' ? 'US$' : currency}`;

const fecha = (iso: string) => {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
};

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-edge bg-panel px-4 py-3">
      <span className="font-display text-[22px] font-extrabold">{value}</span>
      <span className="text-[12px] text-dim">{label}</span>
    </div>
  );
}

const badge = (text: string, tone: string) =>
  <span key={text} className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${tone}`}>{text}</span>;

// ---------- Pestaña Usuarios ----------
function UsersTab({ onChanged }: { onChanged: () => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() =>
    get<{ users: AdminUser[] }>('/api/admin/users').then((d) => setUsers(d.users)).catch(() => {}), []);
  useEffect(() => { reload(); }, [reload]);

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

  const grantPremium = (u: AdminUser) => {
    const days = prompt(`¿Cuántos días de Premium de cortesía para @${u.username}?`, '30');
    if (!days) return;
    act(() => post(`/api/admin/users/${u.id}/premium`, { days: Number(days) }));
  };
  const revokePremium = async (u: AdminUser) => {
    if (!await confirmDialog(`¿Quitar el plan de pago de @${u.username}? Vuelve a Free al instante.`, { danger: true, confirmText: 'Quitar plan' })) return;
    act(() => del(`/api/admin/users/${u.id}/premium`));
  };
  const toggleAdmin = async (u: AdminUser) => {
    if (!await confirmDialog(u.is_admin ? `¿Quitar permisos de administración a @${u.username}?` : `¿Hacer administrador a @${u.username}? Podrá entrar a este backend.`, { confirmText: u.is_admin ? 'Quitar permisos' : 'Hacer admin' })) return;
    act(() => post(`/api/admin/users/${u.id}/toggle-admin`));
  };
  const removeUser = async (u: AdminUser) => {
    if (!await confirmDialog(`¿ELIMINAR la cuenta @${u.username}? Se borran sus mensajes, sesiones y asientos de equipo. Esta acción no tiene vuelta atrás.`, { danger: true, confirmText: 'Eliminar cuenta' })) return;
    act(() => del(`/api/admin/users/${u.id}`));
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? users.filter((u) => u.username.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q) || (u.name ?? '').toLowerCase().includes(q))
    : users;

  const linkBtn = 'text-[11.5px] text-accent transition hover:brightness-110 disabled:opacity-40';

  return (
    <>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por usuario, email o nombre…"
        className="mb-3 w-full max-w-sm rounded-lg border border-edge bg-ink px-3 py-2 text-[13px] outline-none transition-colors focus:border-accent" />
      <div className="flex flex-col gap-1.5">
        {filtered.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-edge bg-panel px-3.5 py-2.5 text-[13px]">
            <div className="flex min-w-0 flex-1 basis-44 flex-col">
              <span className="font-semibold">@{u.username}{u.name ? ` · ${u.name}` : ''}</span>
              <span className="text-[11.5px] text-dim">{u.email ?? 'sin email'} · alta {fecha(u.created_at)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {u.plan === 'team' && badge('EQUIPOS', 'bg-note/15 text-note')}
              {u.plan === 'premium' && badge('PREMIUM', 'bg-accent/15 text-accent')}
              {u.plan === 'free' && !u.team_owner && badge('FREE', 'bg-raised text-dim')}
              {u.team_owner && badge(`EQUIPO DE @${u.team_owner.toUpperCase()}`, 'bg-note/15 text-note')}
              {!!u.is_admin && badge('ADMIN', 'bg-board/15 text-board')}
              {!!u.has_google && badge('GOOGLE', 'bg-raised text-dim')}
              {!!u.email_verified && badge('✓ VERIFICADO', 'bg-ok/15 text-ok')}
              {u.premium_until && <span className="text-[11.5px] text-dim">vence {fecha(u.premium_until)}</span>}
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2.5">
              <button className={linkBtn} disabled={busy} onClick={() => grantPremium(u)}>+ Premium</button>
              {u.plan !== 'free' && (
                <button className={linkBtn} disabled={busy} onClick={() => revokePremium(u)}>Quitar plan</button>
              )}
              <button className={linkBtn} disabled={busy} onClick={() => toggleAdmin(u)}>
                {u.is_admin ? 'Quitar admin' : 'Hacer admin'}
              </button>
              <button className="text-[11.5px] text-danger opacity-80 transition-opacity hover:opacity-100 disabled:opacity-40"
                disabled={busy} onClick={() => removeUser(u)}>Eliminar</button>
            </div>
          </div>
        ))}
        {filtered.length === 0 && <p className="text-[13px] text-dim">Sin resultados.</p>}
      </div>
    </>
  );
}

// ---------- Pestaña Pagos ----------
function PaymentsTab() {
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    get<{ payments: AdminPayment[]; total_cents: number }>('/api/admin/payments')
      .then((d) => { setPayments(d.payments); setTotal(d.total_cents); })
      .catch(() => {});
  }, []);

  return (
    <>
      <p className="mb-3 text-[13px] text-dim">
        Total recaudado: <strong className="text-fg">{money(total)}</strong> · {payments.length} pagos
      </p>
      <div className="flex flex-col gap-1.5">
        {payments.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-edge bg-panel px-3.5 py-2 text-[13px]">
            <span className="w-24 text-[12px] text-dim">{fecha(p.created_at)}</span>
            <span className="min-w-36 font-semibold">@{p.username}</span>
            <span className="text-dim">{p.plan === 'team' ? 'Equipos' : 'Individual'} · {p.days} días</span>
            {badge(p.method.toUpperCase(), p.method === 'simulado' ? 'bg-board/15 text-board' : 'bg-ok/15 text-ok')}
            <strong className="sm:ml-auto">{money(p.amount_cents, p.currency)}</strong>
          </div>
        ))}
        {payments.length === 0 && (
          <p className="text-[13px] text-dim">Todavía no hay pagos registrados. Cada upgrade (simulado o real) queda asentado aquí.</p>
        )}
      </div>
    </>
  );
}

// ---------- Pestaña Invitaciones ----------
function InvitesTab() {
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [days, setDays] = useState('14');
  const [uses, setUses] = useState('1');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);

  const reload = useCallback(() =>
    get<{ invites: InviteCode[] }>('/api/invites').then((d) => setInvites(d.invites)).catch(() => {}), []);
  useEffect(() => { reload(); }, [reload]);

  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await post('/api/invites', { trial_days: Number(days) || 14, max_uses: Number(uses) || 1 });
      await reload();
    } catch (err: any) {
      alertDialog(err.message);
    } finally { setBusy(false); }
  }

  async function deleteInvite(invite: InviteCode) {
    if (!await confirmDialog(`¿Eliminar el código ${invite.code}? Nadie más podrá canjearlo.`, { danger: true, confirmText: 'Eliminar' })) return;
    await del(`/api/invites/${invite.id}`);
    reload();
  }

  function copyInvite(invite: InviteCode) {
    navigator.clipboard.writeText(invite.code).then(() => {
      setCopied(invite.id);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <>
      <form className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-edge bg-panel px-4 py-3"
        onSubmit={createInvite}>
        <label className="flex items-center gap-1.5 text-[13px] text-dim">
          Días de Premium
          <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)}
            className="w-16 rounded-md border border-edge bg-ink px-2 py-1.5 text-center text-[13px] text-fg outline-none focus:border-accent" />
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-dim">
          Usos
          <input type="number" min={1} max={100} value={uses} onChange={(e) => setUses(e.target.value)}
            className="w-14 rounded-md border border-edge bg-ink px-2 py-1.5 text-center text-[13px] text-fg outline-none focus:border-accent" />
        </label>
        <button className={btnSmall} disabled={busy}>+ Generar código</button>
      </form>

      <div className="flex flex-col gap-1.5">
        {invites.map((inv) => {
          const exhausted = inv.used_count >= inv.max_uses;
          return (
            <div key={inv.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-edge bg-panel px-3.5 py-2 text-[13px] ${exhausted ? 'opacity-60' : ''}`}>
              <code className="font-mono text-accent">{inv.code}</code>
              <button className="text-[11.5px] text-dim transition-colors hover:text-fg" type="button"
                onClick={() => copyInvite(inv)}>{copied === inv.id ? '✓ copiado' : '⧉ copiar'}</button>
              <span className="text-dim">{inv.trial_days} días · {inv.used_count}/{inv.max_uses} usos{exhausted ? ' · agotado' : ''}</span>
              {inv.redeemed_by && (
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-dim">→ {inv.redeemed_by}</span>
              )}
              <button className="sm:ml-auto text-xs text-danger opacity-80 transition-opacity hover:opacity-100"
                onClick={() => deleteInvite(inv)}>Eliminar</button>
            </div>
          );
        })}
        {invites.length === 0 && (
          <p className="text-[13px] text-dim">
            No hay códigos. Genera uno y compártelo: quien lo canjee al registrarse recibe esos días de Premium.
          </p>
        )}
      </div>
    </>
  );
}

// Backend de administración (solo en admin.quarryhq.pro / admin.localhost).
// Cada endpoint vuelve a validar is_admin y el host en el servidor.
export default function AdminView() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [tab, setTab] = useState<Tab>('usuarios');

  const reloadStats = useCallback(() =>
    get<AdminStats>('/api/admin/stats').then(setStats).catch(() => setForbidden(true)), []);
  useEffect(() => { reloadStats(); }, [reloadStats]);

  if (forbidden) {
    return <div className={emptyState}>Esta sección es solo para administradores.</div>;
  }

  const tabBtn = (t: Tab, label: string) => (
    <button
      className={`px-3.5 py-1.5 text-[13px] transition-colors ${tab === t ? 'bg-accent/10 font-semibold text-accent' : 'text-dim hover:text-fg'}`}
      onClick={() => setTab(t)}>
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className={mainHeader}>
        <h2 className={viewTitle}><span className="text-accent">⚙</span> Administración</h2>
        <div className="flex max-w-full overflow-x-auto rounded-lg border border-edge bg-panel sm:ml-auto">
          {tabBtn('usuarios', '👤 Usuarios')}
          {tabBtn('pagos', '💳 Pagos')}
          {tabBtn('invitaciones', '🎟 Invitaciones')}
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-5">
        {stats && (
          <div className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
            <StatCard label="Usuarios" value={stats.users} />
            <StatCard label="Emails verificados" value={stats.verified} />
            <StatCard label="Susc. Individual" value={stats.premium_subs} />
            <StatCard label="Susc. Equipos" value={stats.team_subs} />
            <StatCard label="Invitaciones canjeadas" value={stats.invite_redemptions} />
            <StatCard label="Recaudado" value={money(stats.revenue_cents)} />
          </div>
        )}

        {tab === 'usuarios' && <UsersTab onChanged={reloadStats} />}
        {tab === 'pagos' && <PaymentsTab />}
        {tab === 'invitaciones' && <InvitesTab />}
      </div>
    </div>
  );
}
