// Clases Tailwind compartidas. El "tono" codifica el módulo:
// board = ámbar, note = violeta, chat = teal, accent = interacción global.
export type Tone = 'board' | 'note' | 'chat' | 'accent';

export const toneText: Record<Tone, string> = {
  board: 'text-board',
  note: 'text-note',
  chat: 'text-chat',
  accent: 'text-accent',
};

const toneActive: Record<Tone, string> = {
  board: 'bg-board/10 text-board font-semibold',
  note: 'bg-note/10 text-note font-semibold',
  chat: 'bg-chat/10 text-chat font-semibold',
  accent: 'bg-accent/10 text-accent font-semibold',
};

// El borde izquierdo de color en el ítem activo es la firma de navegación:
// mismo código de color (tablero=ámbar, nota=violeta, chat=teal) que ya
// usa el resto de la app, ahora también como marca de "estás acá".
export function sideItem(active: boolean, tone: Tone = 'accent'): string {
  return `group relative flex w-full items-center gap-2 overflow-hidden rounded-lg py-1.5 pl-3 pr-2 text-left text-[13.5px] transition-all duration-150 before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:transition-all ${
    active
      ? `${toneActive[tone]} before:bg-current`
      : 'text-dim before:bg-transparent hover:bg-hover hover:text-fg hover:before:bg-edge'
  }`;
}

export const sideIcon = 'w-4 shrink-0 text-center';
export const sideLabel = 'overflow-hidden text-ellipsis whitespace-nowrap';
export const sideHeading =
  'flex items-center justify-between px-1.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-dim';

export const btnPrimary =
  'rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-ink transition hover:brightness-110 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100';
export const btnSmall =
  'rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-ink transition hover:brightness-110 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100';
export const btnGhost = 'text-xs text-dim transition-colors hover:text-fg';
export const btnDanger = 'text-xs text-danger opacity-80 transition-opacity hover:opacity-100';
export const btnDangerSolid =
  'rounded-lg bg-danger px-3.5 py-2 text-sm font-semibold text-ink transition hover:brightness-110 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100';
export const headerBtn =
  'rounded-lg border border-edge bg-panel px-3 py-1.5 text-xs text-dim transition-colors hover:border-accent hover:text-fg active:scale-[0.97]';
// Botón de header de un solo ícono/emoji (🗑, 🔒, 🤝…): mismo trato que
// headerBtn pero cuadrado, para que un emoji suelto no quede flotando sin
// bordes ni feedback de que es clickeable.
export const iconBtn =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-edge bg-panel text-[13px] text-dim transition-colors hover:border-accent hover:text-fg active:scale-[0.97]';

export const inputBase =
  'rounded-lg border border-edge bg-ink px-3 py-2 outline-none transition-colors focus:border-accent';
export const selectBase =
  'rounded-lg border border-edge bg-ink px-2.5 py-1.5 text-xs outline-none focus:border-accent';

export const chip =
  'inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-edge bg-raised px-3 py-1 text-xs transition-colors hover:border-accent';
export const chipAdd =
  'inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-edge bg-transparent px-3 py-1 text-xs text-dim transition-colors hover:border-accent hover:text-fg';
export const chipRemove = 'ml-0.5 text-dim transition-colors hover:text-danger';

export const sectionTitle = 'mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-dim';
export const modalBackdrop =
  'fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-3 py-5 backdrop-blur-[2px] animate-fade-in sm:px-5 sm:py-14';
export const modalBox =
  'flex w-full max-w-[680px] flex-col gap-4.5 rounded-2xl border border-edge bg-panel p-4 shadow-2xl shadow-black/40 animate-modal-in sm:p-6';
export const modalClose =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-lg text-dim transition-colors hover:bg-hover hover:text-fg active:scale-[0.97]';

export const emptyState = 'flex h-full min-w-0 flex-col items-center justify-center gap-2 px-4 text-center text-dim';

export const viewTitle = 'min-w-0 font-display text-[17px] font-bold';
export const mainHeader = 'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge px-3.5 py-3 sm:px-5 sm:py-3.5';

// Paleta compartida para avatares de usuario (chat y miembros de tarjeta).
export const AVATAR_COLORS = ['#8b93f8', '#3ecfb2', '#e9a23b', '#f27d98', '#6bb2f2', '#b18cfa'];
export function avatarColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
