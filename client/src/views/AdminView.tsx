import { useCallback, useEffect, useState } from 'react';
import { del, get, post } from '../api';
import type { InviteCode } from '../types';
import { btnSmall, emptyState, mainHeader, sectionTitle, viewTitle } from '../ui';

interface AdminStats {
  users: number;
  premium_subs: number;
  team_subs: number;
  verified: number;
  invite_redemptions: number;
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-w-32 flex-col gap-1 rounded-xl border border-edge bg-panel px-4 py-3">
      <span className="font-display text-[22px] font-extrabold">{value}</span>
      <span className="text-[12px] text-dim">{label}</span>
    </div>
  );
}

// Backend de administración: solo llega aquí un usuario con is_admin (el
// servidor rechaza cada endpoint con 403 si no lo es).
export default function AdminView() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [days, setDays] = useState('14');
  const [uses, setUses] = useState('1');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([
        get<AdminStats>('/api/admin/stats'),
        get<{ invites: InviteCode[] }>('/api/invites'),
      ]);
      setStats(s);
      setInvites(i.invites);
    } catch {
      setForbidden(true);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await post('/api/invites', { trial_days: Number(days) || 14, max_uses: Number(uses) || 1 });
      await reload();
    } catch (err: any) {
      alert(err.message);
    } finally { setBusy(false); }
  }

  async function deleteInvite(invite: InviteCode) {
    if (!confirm(`¿Eliminar el código ${invite.code}? Nadie más podrá canjearlo.`)) return;
    await del(`/api/invites/${invite.id}`);
    reload();
  }

  function copyInvite(invite: InviteCode) {
    navigator.clipboard.writeText(invite.code).then(() => {
      setCopied(invite.id);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  if (forbidden) {
    return <div className={emptyState}>Esta sección es solo para administradores.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className={mainHeader}>
        <h2 className={viewTitle}><span className="text-accent">⚙</span> Administración</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {stats && (
          <div className="mb-6 flex flex-wrap gap-3">
            <StatCard label="Usuarios" value={stats.users} />
            <StatCard label="Emails verificados" value={stats.verified} />
            <StatCard label="Suscripciones Individual" value={stats.premium_subs} />
            <StatCard label="Suscripciones Equipos" value={stats.team_subs} />
            <StatCard label="Invitaciones canjeadas" value={stats.invite_redemptions} />
          </div>
        )}

        <h3 className={sectionTitle}>🎟 Códigos de invitación</h3>
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

        <div className="flex max-w-3xl flex-col gap-1.5">
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
                <button className="ml-auto text-xs text-danger opacity-80 transition-opacity hover:opacity-100"
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
      </div>
    </div>
  );
}
