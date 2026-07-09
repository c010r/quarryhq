import { useCallback, useEffect, useState } from 'react';
import { get, post, setToken, getToken, connectWs, disconnectWs, onWsEvent } from './api';
import type { Board, Channel, NoteMeta, User } from './types';
import BoardView from './views/BoardView';
import NotesView from './views/NotesView';
import ChatView from './views/ChatView';
import GraphView from './views/GraphView';
import SearchPalette from './views/SearchPalette';

function useHashRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

export function navigate(path: string) {
  location.hash = path;
}

// ---------- Login ----------
function Login({ onAuth }: { onAuth: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await post<{ token: string; user: User }>(`/api/${mode}`, { username, password });
      setToken(data.token);
      onAuth(data.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1>⚡ Obstresla</h1>
        <p className="tagline">Tableros, notas y chat — todo conectado en un solo espacio de trabajo.</p>
        <input placeholder="Usuario" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <input placeholder="Contraseña" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="login-error">{error}</div>}
        <button className="btn-primary" disabled={busy}>
          {mode === 'login' ? 'Entrar' : 'Crear cuenta'}
        </button>
        <button type="button" className="btn-ghost" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
          {mode === 'login' ? '¿No tienes cuenta? Regístrate' : '¿Ya tienes cuenta? Inicia sesión'}
        </button>
      </form>
    </div>
  );
}

// ---------- Shell autenticado ----------
function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const route = useHashRoute();
  const [boards, setBoards] = useState<Board[]>([]);
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const refreshSidebar = useCallback(async () => {
    const [b, n, c] = await Promise.all([
      get<{ boards: Board[] }>('/api/boards'),
      get<{ notes: NoteMeta[] }>('/api/notes'),
      get<{ channels: Channel[] }>('/api/channels'),
    ]);
    setBoards(b.boards);
    setNotes(n.notes);
    setChannels(c.channels);
  }, []);

  useEffect(() => {
    refreshSidebar();
    connectWs();
    const off = onWsEvent((event) => {
      if (['boards:changed', 'notes:changed', 'channels:changed', 'links:changed'].includes(event.type)) {
        refreshSidebar();
      }
    });
    return off;
  }, [refreshSidebar]);

  // Atajo Ctrl+K para la búsqueda global
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // #/wiki/Título → resuelve (creándola si hace falta) y redirige a la nota
  useEffect(() => {
    if (route[0] === 'wiki' && route[1]) {
      post<{ note: { id: number } }>('/api/notes/resolve', { title: route[1] })
        .then(({ note }) => navigate(`/notes/${note.id}`))
        .catch(() => navigate('/notes'));
    }
  }, [route.join('/')]);

  // Ruta por defecto
  useEffect(() => {
    if (route.length === 0 && boards.length > 0) navigate(`/board/${boards[0].id}`);
  }, [route.length, boards]);

  async function createBoard() {
    const name = prompt('Nombre del tablero:');
    if (!name?.trim()) return;
    const { board } = await post<{ board: Board }>('/api/boards', { name });
    await refreshSidebar();
    navigate(`/board/${board.id}`);
  }

  async function createNote() {
    const title = prompt('Título de la nota:');
    if (!title?.trim()) return;
    const { note } = await post<{ note: { id: number } }>('/api/notes', { title });
    await refreshSidebar();
    navigate(`/notes/${note.id}`);
  }

  async function createChannel() {
    const name = prompt('Nombre del canal:');
    if (!name?.trim()) return;
    try {
      const { channel } = await post<{ channel: Channel }>('/api/channels', { name });
      await refreshSidebar();
      navigate(`/chat/${channel.id}`);
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function logout() {
    try { await post('/api/logout'); } catch { /* la sesión ya no existe */ }
    disconnectWs();
    setToken(null);
    onLogout();
  }

  const [section, param] = route;

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="sidebar-brand"><span className="logo">⚡</span> Obstresla</div>
        <button className="sidebar-search" onClick={() => setPaletteOpen(true)}>
          Buscar en todo… <kbd>Ctrl K</kbd>
        </button>

        <div className="sidebar-section">
          <div className="sidebar-heading">Tableros <button onClick={createBoard} title="Nuevo tablero">+</button></div>
          {boards.map((b) => (
            <button key={b.id} className={`sidebar-item ${section === 'board' && Number(param) === b.id ? 'active' : ''}`}
              onClick={() => navigate(`/board/${b.id}`)}>
              <span className="icon">▦</span><span>{b.name}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-heading">Notas <button onClick={createNote} title="Nueva nota">+</button></div>
          {notes.slice(0, 8).map((n) => (
            <button key={n.id} className={`sidebar-item ${section === 'notes' && Number(param) === n.id ? 'active' : ''}`}
              onClick={() => navigate(`/notes/${n.id}`)}>
              <span className="icon">◆</span><span>{n.title}</span>
            </button>
          ))}
          {notes.length > 8 && (
            <button className="sidebar-item" onClick={() => setPaletteOpen(true)}>
              <span className="icon">…</span><span>{notes.length - 8} notas más</span>
            </button>
          )}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-heading">Canales <button onClick={createChannel} title="Nuevo canal">+</button></div>
          {channels.map((c) => (
            <button key={c.id} className={`sidebar-item ${section === 'chat' && Number(param) === c.id ? 'active' : ''}`}
              onClick={() => navigate(`/chat/${c.id}`)}>
              <span className="icon">#</span><span>{c.name}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-section">
          <button className={`sidebar-item ${section === 'graph' ? 'active' : ''}`} onClick={() => navigate('/graph')}>
            <span className="icon">◉</span><span>Grafo de conocimiento</span>
          </button>
        </div>

        <div className="sidebar-footer">
          <span>@{user.username}</span>
          <button className="btn-ghost" onClick={logout}>Salir</button>
        </div>
      </nav>

      <main className="main">
        {section === 'board' && param && (
          <BoardView boardId={Number(param)} initialCardId={route[2] === 'card' ? Number(route[3]) : undefined} />
        )}
        {section === 'notes' && (
          <NotesView noteId={param ? Number(param) : notes[0]?.id} notes={notes} onChanged={refreshSidebar} />
        )}
        {section === 'chat' && param && <ChatView channelId={Number(param)} user={user} />}
        {section === 'graph' && <GraphView />}
        {!section && (
          <div className="empty-state">
            <h3>Bienvenido a Obstresla</h3>
            <p>Crea un tablero, una nota o un canal desde la barra lateral.</p>
          </div>
        )}
      </main>

      {paletteOpen && <SearchPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!!getToken());

  useEffect(() => {
    if (!getToken()) return;
    get<{ user: User }>('/api/me')
      .then(({ user }) => setUser(user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="empty-state" style={{ height: '100vh' }}>Cargando…</div>;
  if (!user) return <Login onAuth={setUser} />;
  return <Workspace user={user} onLogout={() => setUser(null)} />;
}
