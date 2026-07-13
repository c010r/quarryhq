import { useEffect, useState } from 'react';
import { get } from '../api';
import type { ActivityEntry } from '../types';
import { emptyState, modalBackdrop, modalBox, modalClose } from '../ui';

function formatWhen(iso: string): string {
  const date = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return date.toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function describe(a: ActivityEntry): string {
  const who = a.actor_username ? `@${a.actor_username}` : 'alguien';
  switch (a.action) {
    case 'list_created': return `${who} creó la lista "${a.list_name}"`;
    case 'list_deleted': return `${who} eliminó la lista "${a.list_name}"`;
    case 'card_created': return `${who} creó "${a.card_title}"${a.list_name ? ` en ${a.list_name}` : ''}`;
    case 'card_moved': return `${who} movió "${a.card_title}" a "${a.list_name}"`;
    case 'card_completed': return `${who} completó "${a.card_title}"`;
    case 'card_uncompleted': return `${who} reabrió "${a.card_title}"`;
    case 'card_deleted': return `${who} eliminó "${a.card_title}"`;
    default: return `${who} hizo un cambio`;
  }
}

const ICONS: Record<string, string> = {
  list_created: '📋', list_deleted: '🗑', card_created: '➕', card_moved: '↔️',
  card_completed: '✅', card_uncompleted: '↩️', card_deleted: '🗑',
};

export default function ActivityModal({ boardId, onClose }: { boardId: number; onClose: () => void }) {
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);

  useEffect(() => {
    get<{ activity: ActivityEntry[] }>(`/api/boards/${boardId}/activity`).then((d) => setActivity(d.activity));
  }, [boardId]);

  return (
    <div className={modalBackdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${modalBox} max-w-[480px]`}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold">📋 Actividad</h3>
          <button className={modalClose} onClick={onClose}>✕</button>
        </div>

        {!activity ? (
          <p className="text-[13px] text-dim">Cargando…</p>
        ) : activity.length === 0 ? (
          <div className={`${emptyState} h-32`}>Sin actividad todavía.</div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
            {activity.map((a) => (
              <div key={a.id} className="flex items-start gap-2 rounded-lg border border-edge bg-panel px-3 py-2 text-[13px]">
                <span className="shrink-0">{ICONS[a.action] ?? '•'}</span>
                <span className="min-w-0 flex-1">{describe(a)}</span>
                <span className="shrink-0 text-[11px] text-dim">{formatWhen(a.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
