import { post } from '../api';
import type { NotificationEntry } from '../types';
import { modalBackdrop, modalBox, modalClose } from '../ui';
import { navigate } from '../App';

const TYPE_PATH: Record<NotificationEntry['resource_type'], string> = { board: 'board', note: 'notes', channel: 'chat' };

function formatWhen(iso: string): string {
  const date = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return date.toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function NotificationsModal({ notifications, onChanged, onClose }: {
  notifications: NotificationEntry[];
  onChanged: () => void;
  onClose: () => void;
}) {
  async function open(n: NotificationEntry) {
    if (!n.read) await post(`/api/notifications/${n.id}/read`).catch(() => {});
    onChanged();
    onClose();
    navigate(`/${TYPE_PATH[n.resource_type]}/${n.resource_id}`);
  }

  async function markAllRead() {
    await post('/api/notifications/read-all');
    onChanged();
  }

  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className={modalBackdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${modalBox} max-w-[440px]`}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold">🔔 Notificaciones</h3>
          <button className={modalClose} onClick={onClose}>✕</button>
        </div>

        {notifications.length === 0 ? (
          <p className="text-[13px] text-dim">No tenés notificaciones todavía.</p>
        ) : (
          <>
            {unread > 0 && (
              <button className="self-start text-[12px] text-accent hover:brightness-110" onClick={markAllRead}>
                Marcar todas como leídas
              </button>
            )}
            <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
              {notifications.map((n) => (
                <button key={n.id} onClick={() => open(n)}
                  className={`flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left text-[13px] transition-colors ${
                    n.read ? 'border-edge bg-panel' : 'border-accent/40 bg-accent/10'
                  }`}>
                  <span>
                    <strong>@{n.actor_username}</strong> te mencionó
                    {n.resource_name && <> en <strong className="text-fg">{n.resource_name}</strong></>}
                  </span>
                  {n.excerpt && <span className="truncate text-[12px] text-dim">"{n.excerpt}"</span>}
                  <span className="text-[11px] text-dim">{formatWhen(n.created_at)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
