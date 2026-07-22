import { useEffect, useRef, useState } from 'react';
import { get } from '../api';
import type { SearchResults } from '../types';
import { navigate } from '../App';
import { useModalA11y } from '../useModalA11y';

export default function SearchPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useModalA11y(onClose);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) { setResults(null); setError(false); return; }
    setLoading(true);
    setError(false);
    timer.current = setTimeout(async () => {
      try {
        setResults(await get<SearchResults>(`/api/search?q=${encodeURIComponent(query.trim())}`));
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    }, 200);
  }, [query]);

  function go(path: string) {
    onClose();
    navigate(path);
  }

  const total = results
    ? results.cards.length + results.notes.length + results.messages.length + results.channels.length
    : 0;

  const group = 'px-2.5 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-dim';
  const item = 'flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors hover:bg-accent/10';
  const icon = 'w-4.5 shrink-0 text-center';
  const detail = 'ml-auto hidden shrink-0 sm:inline text-xs text-dim';
  const empty = 'p-6 text-center text-[13px] text-dim';

  return (
    <div ref={containerRef} className="fixed inset-0 z-100 flex justify-center bg-black/70 px-3 pt-12 backdrop-blur-[2px] animate-fade-in sm:pt-24"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex h-fit max-h-[60vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl shadow-black/50 animate-modal-in">
        <label className="sr-only" htmlFor="quarry-search-input">Buscar</label>
        <input id="quarry-search-input" autoFocus placeholder="Buscar tarjetas, notas, mensajes y canales…"
          value={query} onChange={(e) => setQuery(e.target.value)}
          aria-label="Buscar en todo el espacio de trabajo"
          className="border-b border-edge bg-transparent px-4.5 py-4 text-[15px] outline-none" />
        <div className="overflow-y-auto p-2" aria-live="polite">
          {error && <div className={empty}>No se pudo buscar. Reintentá en un momento.</div>}
          {!error && results && total === 0 && <div className={empty}>Sin resultados para “{query}”.</div>}
          {!error && !results && !loading && <div className={empty}>Escribe para buscar en todo el espacio de trabajo.</div>}
          {!error && loading && !results && <div className={empty}>Buscando…</div>}

          {results && results.cards.length > 0 && (
            <>
              <div className={group}>Tarjetas</div>
              {results.cards.map((c) => (
                <button key={c.id} className={item} onClick={() => go(`/board/${c.board_id}/card/${c.id}`)}>
                  <span className={`${icon} text-board`}>▦</span>{c.title}<span className={detail}>abrir tarjeta</span>
                </button>
              ))}
            </>
          )}

          {results && results.notes.length > 0 && (
            <>
              <div className={group}>Notas</div>
              {results.notes.map((n) => (
                <button key={n.id} className={item} onClick={() => go(`/notes/${n.id}`)}>
                  <span className={`${icon} text-note`}>◆</span>{n.title}
                </button>
              ))}
            </>
          )}

          {results && results.channels.length > 0 && (
            <>
              <div className={group}>Canales</div>
              {results.channels.map((c) => (
                <button key={c.id} className={item} onClick={() => go(`/chat/${c.id}`)}>
                  <span className={`${icon} text-chat`}>#</span>{c.name}
                </button>
              ))}
            </>
          )}

          {results && results.messages.length > 0 && (
            <>
              <div className={group}>Mensajes</div>
              {results.messages.map((m) => (
                <button key={m.id} className={item} onClick={() => go(`/chat/${m.channel_id}`)}>
                  <span className={`${icon} text-chat`}>💬</span>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">{m.content}</span>
                  <span className={detail}>#{m.channel_name}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
