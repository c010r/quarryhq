import { useState } from 'react';
import { post } from '../api';
import type { PendingInvite } from '../types';
import { btnGhost, btnSmall, modalBackdrop, modalBox, modalClose } from '../ui';
import { alertDialog } from '../dialog';
import { navigate } from '../App';

const TYPE_LABELS: Record<PendingInvite['resource_type'], { icon: string; label: string; path: string }> = {
  board: { icon: '▦', label: 'tablero', path: 'board' },
  note: { icon: '◆', label: 'nota', path: 'notes' },
  channel: { icon: '#', label: 'canal', path: 'chat' },
};

export default function InvitesModal({ invites, onChanged, onClose }: {
  invites: PendingInvite[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);

  async function accept(inv: PendingInvite) {
    setBusy(inv.id);
    try {
      await post(`/api/invites/${inv.id}/accept`);
      onChanged();
      onClose();
      navigate(`/${TYPE_LABELS[inv.resource_type].path}/${inv.resource_id}`);
    } catch (err: any) {
      alertDialog(err.message);
    } finally { setBusy(null); }
  }

  async function decline(inv: PendingInvite) {
    setBusy(inv.id);
    try {
      await post(`/api/invites/${inv.id}/decline`);
      onChanged();
    } catch (err: any) {
      alertDialog(err.message);
    } finally { setBusy(null); }
  }

  return (
    <div className={modalBackdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${modalBox} max-w-[440px]`}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold">📬 Invitaciones</h3>
          <button className={modalClose} onClick={onClose}>✕</button>
        </div>

        {invites.length === 0 ? (
          <p className="text-[13px] text-dim">No tenés invitaciones pendientes.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {invites.map((inv) => {
              const t = TYPE_LABELS[inv.resource_type];
              return (
                <div key={inv.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg border border-edge bg-panel px-3.5 py-2.5 text-[13px]">
                  <span className="min-w-0 flex-1">
                    <strong>@{inv.owner_username}</strong> te invitó a {t.label} <strong className="text-fg">{t.icon} {inv.resource_name}</strong>
                  </span>
                  <div className="flex gap-2">
                    <button className={btnGhost} disabled={busy === inv.id} onClick={() => decline(inv)}>Rechazar</button>
                    <button className={btnSmall} disabled={busy === inv.id} onClick={() => accept(inv)}>Aceptar</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
