import { useCallback, useEffect, useState } from 'react';
import { get, post, patch, del, isPlanError } from '../api';
import type { Collaborator, Connection, ShareRole } from '../types';
import { btnDanger, btnSmall, chip, inputBase, modalBackdrop, modalBox, modalClose, sectionTitle, selectBase } from '../ui';
import { alertDialog, confirmDialog } from '../dialog';

type ShareType = 'board' | 'note' | 'channel';
const TYPE_LABELS: Record<ShareType, string> = { board: 'tablero', note: 'nota', channel: 'canal' };
const TYPE_PATH: Record<ShareType, string> = { board: 'boards', note: 'notes', channel: 'channels' };
const ROLE_LABELS: Record<ShareRole, string> = { editor: 'Editor', viewer: 'Solo lectura' };
const FREE_CHANNEL_COLLABORATOR_LIMIT = 3;

export default function ShareModal({ type, resourceId, resourceName, currentUserId, isPremium, onClose }: {
  type: ShareType;
  resourceId: number;
  resourceName: string;
  currentUserId: number;
  isPremium: boolean;
  onClose: () => void;
}) {
  const [shares, setShares] = useState<Collaborator[]>([]);
  const [pending, setPending] = useState<Collaborator[]>([]);
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<ShareRole>('editor');
  const [busy, setBusy] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const path = TYPE_PATH[type];

  const load = useCallback(async () => {
    const data = await get<{ shares: Collaborator[]; pending: Collaborator[]; ownerId: number }>(`/api/${path}/${resourceId}/shares`);
    setShares(data.shares);
    setPending(data.pending);
    setOwnerId(data.ownerId);
  }, [path, resourceId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (currentUserId === ownerId) get<{ connections: Connection[] }>('/api/connections').then((d) => setConnections(d.connections)).catch(() => {});
  }, [ownerId, currentUserId]);

  const isOwner = ownerId === currentUserId;
  const alreadyIds = new Set([...shares.map((s) => s.id), ...pending.map((p) => p.id)]);
  const quickPick = connections.filter((c) => !alreadyIds.has(c.id));

  async function inviteUsername(target: string) {
    if (!target.trim()) return;
    setBusy(true);
    try {
      await post(`/api/${path}/${resourceId}/shares`, { username: target.trim(), role });
      setUsername('');
      await load();
    } catch (err: any) {
      if (!isPlanError(err)) alertDialog(err.message); // los errores de plan abren el modal solos
    } finally { setBusy(false); }
  }

  async function changeRole(userId: number, newRole: ShareRole) {
    setBusy(true);
    try {
      await patch(`/api/${path}/${resourceId}/shares/${userId}`, { role: newRole });
      await load();
    } catch (err: any) {
      alertDialog(err.message);
    } finally { setBusy(false); }
  }

  async function remove(userId: number, isSelf: boolean) {
    const msg = isSelf
      ? `¿Dejar de colaborar en "${resourceName}"?`
      : `¿Quitar a este colaborador de "${resourceName}"?`;
    if (!await confirmDialog(msg, { danger: true, confirmText: isSelf ? 'Salir' : 'Quitar' })) return;
    setBusy(true);
    try {
      await del(`/api/${path}/${resourceId}/shares/${userId}`);
      if (isSelf) { onClose(); return; }
      await load();
    } catch (err: any) {
      alertDialog(err.message);
    } finally { setBusy(false); }
  }

  async function cancelInvite(userId: number) {
    if (!await confirmDialog('¿Cancelar esta invitación pendiente?', { danger: true, confirmText: 'Cancelar invitación' })) return;
    setBusy(true);
    try {
      await del(`/api/${path}/${resourceId}/shares/${userId}`);
      await load();
    } catch (err: any) {
      alertDialog(err.message);
    } finally { setBusy(false); }
  }

  return (
    <div className={modalBackdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${modalBox} max-w-[440px]`}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold">🤝 Compartir "{resourceName}"</h3>
          <button className={modalClose} onClick={onClose}>✕</button>
        </div>

        <div>
          <h4 className={sectionTitle}>Colaboradores</h4>
          <div className="flex flex-col gap-1.5">
            {shares.length === 0 && (
              <p className="text-[13px] text-dim">Todavía no compartiste este {TYPE_LABELS[type]} con nadie.</p>
            )}
            {shares.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-panel px-3 py-2 text-[13px]">
                <span>@{s.username}</span>
                {isOwner ? (
                  <select className={selectBase} value={s.role} disabled={busy}
                    onChange={(e) => changeRole(s.id, e.target.value as ShareRole)}>
                    <option value="editor">Editor</option>
                    <option value="viewer">Solo lectura</option>
                  </select>
                ) : (
                  <span className="text-[11px] text-dim">{ROLE_LABELS[s.role]}</span>
                )}
                {(isOwner || s.id === currentUserId) && (
                  <button className={`${btnDanger} ml-auto`} disabled={busy} onClick={() => remove(s.id, s.id === currentUserId)}>
                    {s.id === currentUserId ? 'Salir' : 'Quitar'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {pending.length > 0 && (
          <div>
            <h4 className={sectionTitle}>Invitaciones pendientes</h4>
            <div className="flex flex-col gap-1.5">
              {pending.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-edge bg-panel/70 px-3 py-2 text-[13px] text-dim">
                  <span>@{p.username}</span>
                  <span className="text-[11px]">({ROLE_LABELS[p.role]}) esperando que acepte…</span>
                  {isOwner && (
                    <button className={`${btnDanger} ml-auto`} disabled={busy} onClick={() => cancelInvite(p.id)}>Cancelar</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {isOwner ? (
          <>
            {quickPick.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {quickPick.map((c) => (
                  <button key={c.id} type="button" className={chip} disabled={busy} onClick={() => inviteUsername(c.username)}>
                    🔗 @{c.username}
                  </button>
                ))}
              </div>
            )}
            <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); inviteUsername(username); }}>
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Usuario a invitar…"
                className={`${inputBase} min-w-0 flex-1 py-1.5 text-[13px]`} />
              <select className={selectBase} value={role} onChange={(e) => setRole(e.target.value as ShareRole)}>
                <option value="editor">Editor</option>
                <option value="viewer">Solo lectura</option>
              </select>
              <button className={btnSmall} disabled={busy || !username.trim()}>Invitar</button>
            </form>
            <p className="text-[12px] text-dim">
              Le mandamos un correo con la invitación; pasa a colaborar recién cuando la acepta.
              {type === 'channel' && !isPremium && (
                <> Plan Free: hasta {FREE_CHANNEL_COLLABORATOR_LIMIT} colaboradores por canal ({shares.length + pending.length}/{FREE_CHANNEL_COLLABORATOR_LIMIT}). Premium es ilimitado.</>
              )}
            </p>
          </>
        ) : (
          <p className="text-[12px] text-dim">Solo el dueño puede invitar o quitar otros colaboradores.</p>
        )}
      </div>
    </div>
  );
}
