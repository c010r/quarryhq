import { avatarColor } from '../ui';

export interface PresenceViewer { userId: number; username: string }

export default function PresenceAvatars({ viewers, currentUserId }: { viewers: PresenceViewer[]; currentUserId: number }) {
  const others = viewers.filter((v) => v.userId !== currentUserId);
  if (others.length === 0) return null;
  return (
    <span className="flex items-center" title={others.map((v) => `@${v.username}`).join(', ')}>
      {others.slice(0, 4).map((v, i) => (
        <span key={v.userId}
          className={`flex h-6 w-6 items-center justify-center rounded-full border-2 border-panel text-[11px] font-bold text-ink ${i > 0 ? '-ml-2' : ''}`}
          style={{ background: avatarColor(v.username) }}>
          {v.username.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {others.length > 4 && (
        <span className="-ml-2 flex h-6 w-6 items-center justify-center rounded-full border-2 border-panel bg-raised text-[10px] font-bold text-dim">
          +{others.length - 4}
        </span>
      )}
    </span>
  );
}
