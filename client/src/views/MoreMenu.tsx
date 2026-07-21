import { useState } from 'react';
import { iconBtn } from '../ui';

export interface MenuAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

// Menú desplegable "⋯" para agrupar acciones secundarias del header cuando el
// ancho no alcanza (móvil). Backdrop invisible para cerrar tocando afuera.
export default function MoreMenu({ actions, className = '' }: { actions: MenuAction[]; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`relative ${className}`}>
      <button className={iconBtn} aria-label="Más acciones" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>⋯</button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1.5 flex w-52 animate-pop-in flex-col gap-0.5 rounded-lg border border-edge bg-panel p-1.5 shadow-xl shadow-black/40">
            {actions.map((a) => (
              <button key={a.label}
                className={`rounded-md px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-hover ${
                  a.danger ? 'text-danger' : 'text-dim hover:text-fg'
                }`}
                onClick={() => { setOpen(false); a.onClick(); }}>
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
