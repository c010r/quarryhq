import { useEffect, useRef } from 'react';

/*
 * A11y compartida para modales y paneles flotantes. Asume el patrón del repo:
 * el padre monta el modal condicionalmente (`{show && <Modal/>}`), así que
 * "estar montado" equivale a "estar abierto". Esto:
 *  - marca role="dialog" + aria-modal="true" en el contenedor del backdrop
 *  - cierra con Escape (algunos modales ya lo hacían, otros no; se unifica)
 *  - focus trap: Tab/Shift-Tab queda dentro del diálogo
 *  - autofocus del primer elemento focuseable si ninguno tiene autoFocus
 *  - al desmontar, restaura el foco al elemento que disparó la apertura
 *
 * No toca la lógica de cierre por backdrop (cada modal la maneja onMouseDown).
 */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useModalA11y(onClose: () => void, labelledBy?: string) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const previousFocus = document.activeElement as HTMLElement | null;

    if (container) {
      container.setAttribute('role', 'dialog');
      container.setAttribute('aria-modal', 'true');
      if (labelledBy) container.setAttribute('aria-labelledby', labelledBy);
      // Autofocus del primer elemento focuseable, salvo que ya haya uno con
      // foco explícito (autoFocus en el JSX gana por orden de montaje).
      const first = container.querySelector<HTMLElement>(FOCUSABLE);
      if (first && (document.activeElement === document.body || document.activeElement === null)) {
        first.focus();
      }
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !container) return;
      const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // Restaurar foco del elemento que disparó la apertura.
      if (previousFocus && previousFocus !== document.activeElement) {
        previousFocus.focus?.();
      }
    };
  }, [onClose, labelledBy]);

  return containerRef;
}