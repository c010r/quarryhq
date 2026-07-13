import { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '../api';
import type { Connection } from '../types';
import { btnDanger, btnSmall, headerBtn, inputBase, modalBackdrop, modalBox, modalClose, sectionTitle } from '../ui';
import { alertDialog, confirmDialog } from '../dialog';

export default function ConnectionsModal({ onClose }: { onClose: () => void }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState<number | 'add' | null>(null);

  const load = useCallback(async () => {
    const data = await get<{ connections: Connection[] }>('/api/connections');
    setConnections(data.connections);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const name = username.trim();
    if (!name) return;
    setBusy('add');
    try {
      await post('/api/connections', { username: name });
      setUsername('');
      await load();
    } catch (err: any) {
      alertDialog(err.message);
    } finally { setBusy(null); }
  }

  async function remove(c: Connection) {
    if (!await confirmDialog(`¿Quitar a @${c.username} de tus conexiones? No afecta lo que ya compartiste con esa cuenta.`, { danger: true, confirmText: 'Quitar' })) return;
    setBusy(c.id);
    try {
      await del(`/api/connections/${c.id}`);
      await load();
    } catch (err: any) {
      alertDialog(err.message);
    } finally { setBusy(null); }
  }

  async function shareAll(c: Connection) {
    if (!await confirmDialog(`¿Compartir TODOS tus tableros, notas y canales con @${c.username}? Le llega una invitación por cada uno y quedan pendientes hasta que las acepte.`,
      { confirmText: 'Compartir todo' })) return;
    setBusy(c.id);
    try {
      const result = await post<{ invited: number; total: number; skipped: string[] }>(`/api/connections/${c.id}/share-all`);
      await alertDialog(
        result.total === 0 ? 'Todavía no tenés tableros, notas ni canales para compartir.'
          : `Se mandaron ${result.invited} de ${result.total} invitaciones a @${c.username}.` +
            (result.skipped.length ? `\n\nNo se pudieron mandar ${result.skipped.length}:\n${result.skipped.slice(0, 5).join('\n')}` : '')
      );
    } catch (err: any) {
      alertDialog(err.message);
    } finally { setBusy(null); }
  }

  return (
    <div className={modalBackdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${modalBox} max-w-[480px]`}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold">🔗 Conexiones</h3>
          <button className={modalClose} onClick={onClose}>✕</button>
        </div>
        <p className="text-[12px] text-dim">
          Agregá gente con la que colaborás seguido para compartir tableros, notas y canales más rápido.
        </p>

        <div>
          <h4 className={sectionTitle}>Tus conexiones</h4>
          <div className="flex flex-col gap-1.5">
            {connections.length === 0 && <p className="text-[13px] text-dim">Todavía no agregaste ninguna conexión.</p>}
            {connections.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-panel px-3 py-2 text-[13px]">
                <span>@{c.username}</span>
                <button className={headerBtn} disabled={busy === c.id} onClick={() => shareAll(c)}>🤝 Compartir todo</button>
                <button className={`${btnDanger} ml-auto`} disabled={busy === c.id} onClick={() => remove(c)}>Quitar</button>
              </div>
            ))}
          </div>
        </div>

        <form className="flex gap-2" onSubmit={add}>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Usuario a conectar…"
            className={`${inputBase} flex-1 py-1.5 text-[13px]`} />
          <button className={btnSmall} disabled={busy === 'add' || !username.trim()}>Conectar</button>
        </form>
      </div>
    </div>
  );
}
