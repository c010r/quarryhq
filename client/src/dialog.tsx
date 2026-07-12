import { useEffect, useState } from 'react';
import { btnDangerSolid, btnGhost, btnPrimary } from './ui';

type DialogRequest =
  | { kind: 'alert'; message: string; title?: string; okText?: string; resolve: () => void }
  | { kind: 'confirm'; message: string; title?: string; danger?: boolean; confirmText?: string; cancelText?: string; resolve: (ok: boolean) => void };

let openDialog: ((req: DialogRequest) => void) | null = null;

// Reemplazo de window.alert() con un modal propio; se resuelve al aceptar.
export function alertDialog(message: string, opts?: { title?: string; okText?: string }): Promise<void> {
  return new Promise((resolve) => {
    if (!openDialog) return resolve();
    openDialog({ kind: 'alert', message, resolve, ...opts });
  });
}

// Reemplazo de window.confirm(): true si el usuario acepta, false si cancela o cierra el modal.
export function confirmDialog(message: string, opts?: { title?: string; danger?: boolean; confirmText?: string; cancelText?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    if (!openDialog) return resolve(false);
    openDialog({ kind: 'confirm', message, resolve, ...opts });
  });
}

// Se monta una sola vez en main.tsx; registra la función que abre el modal.
export default function DialogHost() {
  const [req, setReq] = useState<DialogRequest | null>(null);

  useEffect(() => {
    openDialog = setReq;
    return () => { openDialog = null; };
  }, []);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req]);

  if (!req) return null;

  function close(result: boolean) {
    if (req!.kind === 'alert') req!.resolve();
    else req!.resolve(result);
    setReq(null);
  }

  return (
    <div className="fixed inset-0 z-70 flex items-start justify-center overflow-y-auto bg-black/70 px-3 py-14 backdrop-blur-[2px] sm:px-5"
      onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className="flex w-full max-w-[380px] flex-col gap-4 rounded-2xl border border-edge bg-panel p-5 shadow-2xl shadow-black/50">
        {req.title && <h3 className="font-display text-[16px] font-bold">{req.title}</h3>}
        <p className="whitespace-pre-line text-[13.5px] leading-relaxed text-fg">{req.message}</p>
        <div className="flex justify-end gap-2.5">
          {req.kind === 'confirm' && (
            <button className={btnGhost} onClick={() => close(false)} autoFocus>{req.cancelText ?? 'Cancelar'}</button>
          )}
          <button
            className={req.kind === 'confirm' && req.danger ? btnDangerSolid : btnPrimary}
            onClick={() => close(true)}
            autoFocus={req.kind === 'alert'}>
            {req.kind === 'confirm' ? (req.confirmText ?? 'Confirmar') : (req.okText ?? 'Aceptar')}
          </button>
        </div>
      </div>
    </div>
  );
}
