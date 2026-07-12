import { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '../api';
import type { Collaborator } from '../types';
import { btnDanger, btnSmall, inputBase, modalBackdrop, modalBox, modalClose, sectionTitle } from '../ui';
import { alertDialog, confirmDialog } from '../dialog';

type ShareType = 'board' | 'note' | 'channel';
const TYPE_LABELS: Record<ShareType, string> = { board: 'tablero', note: 'nota', channel: 'canal' };
const TYPE_PATH: Record<ShareType, string> = { board: 'boards', note: 'notes', channel: 'channels' };

export default function ShareModal({ type, resourceId, resourceName, currentUserId, onClose }: {
  type: ShareType;
  resourceId: number;
  resourceName: string;
  currentUserId: number;
  onClose: () => void;
}) {
  const [shares, setShares] = useState<Collaborator[]>([]);
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const path = TYPE_PATH[type];

  const load = useCallback(async () => {
    const data = await get<{ shares: Collaborator[]; ownerId: number }>(`/api/${path}/${resourceId}/shares`);
    setShares(data.shares);
    setOwnerId(data.ownerId);
  }, [path, resourceId]);

  useEffect(() => { load(); }, [load]);

  const isOwner = ownerId === currentUserId;

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    const name = username.trim();
    if (!name) return;
    setBusy(true);
    try {
      await post(`/api/${path}/${resourceId}/shares`, { username: name });
      setUsername('');
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
              <div key={s.id} className="flex items-center gap-2 rounded-lg border border-edge bg-panel px-3 py-2 text-[13px]">
                <span>@{s.username}</span>
                {(isOwner || s.id === currentUserId) && (
                  <button className={`${btnDanger} ml-auto`} disabled={busy} onClick={() => remove(s.id, s.id === currentUserId)}>
                    {s.id === currentUserId ? 'Salir' : 'Quitar'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {isOwner ? (
          <form className="flex gap-2" onSubmit={invite}>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Usuario a invitar…"
              className={`${inputBase} flex-1 py-1.5 text-[13px]`} />
            <button className={btnSmall} disabled={busy || !username.trim()}>Invitar</button>
          </form>
        ) : (
          <p className="text-[12px] text-dim">Solo el dueño puede invitar o quitar otros colaboradores.</p>
        )}
      </div>
    </div>
  );
}
