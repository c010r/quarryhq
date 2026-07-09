import { useEffect, useRef, useState } from 'react';
import { get } from '../api';
import type { SearchResults } from '../types';
import { navigate } from '../App';

export default function SearchPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) { setResults(null); return; }
    timer.current = setTimeout(async () => {
      setResults(await get<SearchResults>(`/api/search?q=${encodeURIComponent(query.trim())}`));
    }, 200);
  }, [query]);

  function go(path: string) {
    onClose();
    navigate(path);
  }

  const total = results
    ? results.cards.length + results.notes.length + results.messages.length + results.channels.length
    : 0;

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <input autoFocus placeholder="Buscar tarjetas, notas, mensajes y canales…"
          value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="palette-results">
          {results && total === 0 && <div className="palette-empty">Sin resultados para “{query}”.</div>}
          {!results && <div className="palette-empty">Escribe para buscar en todo el espacio de trabajo.</div>}

          {results && results.cards.length > 0 && (
            <>
              <div className="palette-group">Tarjetas</div>
              {results.cards.map((c) => (
                <button key={c.id} className="palette-item" onClick={() => go(`/board/${c.board_id}/card/${c.id}`)}>
                  <span className="icon">▦</span>{c.title}<span className="detail">abrir tarjeta</span>
                </button>
              ))}
            </>
          )}

          {results && results.notes.length > 0 && (
            <>
              <div className="palette-group">Notas</div>
              {results.notes.map((n) => (
                <button key={n.id} className="palette-item" onClick={() => go(`/notes/${n.id}`)}>
                  <span className="icon">◆</span>{n.title}
                </button>
              ))}
            </>
          )}

          {results && results.channels.length > 0 && (
            <>
              <div className="palette-group">Canales</div>
              {results.channels.map((c) => (
                <button key={c.id} className="palette-item" onClick={() => go(`/chat/${c.id}`)}>
                  <span className="icon">#</span>{c.name}
                </button>
              ))}
            </>
          )}

          {results && results.messages.length > 0 && (
            <>
              <div className="palette-group">Mensajes</div>
              {results.messages.map((m) => (
                <button key={m.id} className="palette-item" onClick={() => go(`/chat/${m.channel_id}`)}>
                  <span className="icon">💬</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.content}</span>
                  <span className="detail">#{m.channel_name}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
