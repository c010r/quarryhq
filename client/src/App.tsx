import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, setToken, getToken, connectWs, disconnectWs, onWsEvent, isPlanError } from './api';
import type { Board, Channel, NoteMeta, User } from './types';
import BoardView from './views/BoardView';
import NotesView from './views/NotesView';
import ChatView from './views/ChatView';
import GraphView from './views/GraphView';
import SearchPalette from './views/SearchPalette';
import UpgradeModal from './views/UpgradeModal';
import { btnPrimary, btnGhost, emptyState, inputBase, sideHeading, sideIcon, sideItem, sideLabel } from './ui';

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

// Tres nodos enlazados: tableros (ámbar), notas (violeta) y chat (teal).
function LinkMark() {
  return (
    <svg viewBox="0 0 120 44" className="h-11 w-[120px]" aria-hidden>
      <line x1="20" y1="30" x2="60" y2="12" stroke="var(--color-edge)" strokeWidth="1.5" />
      <line x1="60" y1="12" x2="100" y2="30" stroke="var(--color-edge)" strokeWidth="1.5" />
      <line x1="20" y1="30" x2="100" y2="30" stroke="var(--color-edge)" strokeWidth="1.5" strokeDasharray="4 3" />
      <circle cx="20" cy="30" r="7" fill="var(--color-board)" />
      <circle cx="60" cy="12" r="7" fill="var(--color-note)" />
      <circle cx="100" cy="30" r="7" fill="var(--color-chat)" />
    </svg>
  );
}

// ---------- Google Sign-In ----------
declare global {
  interface Window { google?: any }
}

let gsiScript: Promise<void> | null = null;
function loadGsi(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  gsiScript ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar Google Sign-In'));
    document.head.appendChild(s);
  });
  return gsiScript;
}

// Solo aparece si el servidor tiene GOOGLE_CLIENT_ID configurado
function GoogleButton({ onAuth, onError }: { onAuth: (user: User) => void; onError: (msg: string) => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { googleClientId } = await get<{ googleClientId: string | null }>('/api/auth/config');
        if (!googleClientId || cancelled) return;
        await loadGsi();
        if (cancelled || !slot.current) return;
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: async ({ credential }: { credential: string }) => {
            try {
              const data = await post<{ token: string; user: User }>('/api/auth/google', { credential });
              setToken(data.token);
              onAuth(data.user);
            } catch (err: any) {
              onError(err.message);
            }
          },
        });
        window.google.accounts.id.renderButton(slot.current, {
          theme: 'filled_black', size: 'large', width: 300, text: 'continue_with',
        });
        setReady(true);
      } catch {
        // Sin Google el formulario clásico sigue funcionando
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className={ready ? 'flex flex-col gap-3.5' : 'hidden'}>
      <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.08em] text-dim">
        <span className="h-px flex-1 bg-edge" />o<span className="h-px flex-1 bg-edge" />
      </div>
      <div ref={slot} className="flex justify-center" />
    </div>
  );
}

// ---------- Login ----------
function Login({ onAuth }: { onAuth: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [identifier, setIdentifier] = useState(''); // email o usuario según el modo
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState(location.hash.includes('verificado') && !location.hash.includes('fallida')
    ? '✓ Correo confirmado. Ya puedes iniciar sesión.'
    : location.hash.includes('verificacion-fallida')
      ? 'El enlace de verificación es inválido o venció.'
      : '');
  const [busy, setBusy] = useState(false);

  function switchMode(next: 'login' | 'register' | 'forgot') {
    setMode(next);
    setError('');
    setInfo('');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'forgot') {
        await post('/api/auth/forgot', { email: identifier });
        setInfo('Si existe una cuenta con ese email, te enviamos un enlace para restablecer la contraseña.');
        return;
      }
      const body: Record<string, string> = { password };
      if (mode === 'register') {
        body.email = identifier;
        if (inviteCode.trim()) body.invite_code = inviteCode.trim();
      } else {
        body.username = identifier;
      }
      const data = await post<{ token: string; user: User }>(`/api/${mode}`, body);
      setToken(data.token);
      onAuth(data.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-ink [background-image:radial-gradient(ellipse_at_top,#1a1f3a_0%,var(--color-ink)_62%)]">
      <form onSubmit={submit} className="flex w-[380px] flex-col gap-3.5 rounded-2xl border border-edge bg-panel p-9 shadow-2xl shadow-black/50">
        <LinkMark />
        <h1 className="font-display text-[28px] font-extrabold tracking-tight">QuarryHQ</h1>
        <p className="mb-1 text-[13px] leading-relaxed text-dim">
          <span className="font-semibold text-board">Tableros</span>,{' '}
          <span className="font-semibold text-note">notas</span> y{' '}
          <span className="font-semibold text-chat">chat</span> — todo conectado en un solo espacio de trabajo.
        </p>
        <input className={inputBase} autoFocus
          placeholder={mode === 'login' ? 'Email o usuario' : 'Email'}
          type={mode === 'login' ? 'text' : 'email'}
          value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
        {mode !== 'forgot' && (
          <input className={inputBase} type="password" value={password}
            placeholder={mode === 'register' ? 'Contraseña (mín. 8 caracteres)' : 'Contraseña'}
            onChange={(e) => setPassword(e.target.value)} />
        )}
        {mode === 'register' && (
          <input className={inputBase} placeholder="Código de invitación (opcional)"
            value={inviteCode} onChange={(e) => setInviteCode(e.target.value.toUpperCase())} />
        )}
        {error && <div className="text-[13px] text-danger">{error}</div>}
        {info && <div className="text-[13px] text-ok">{info}</div>}
        <button className={btnPrimary} disabled={busy}>
          {mode === 'login' ? 'Entrar' : mode === 'register' ? 'Crear cuenta' : 'Enviar enlace'}
        </button>
        <div className="flex items-center justify-between">
          <button type="button" className={btnGhost} onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? '¿No tienes cuenta? Regístrate' : '¿Ya tienes cuenta? Inicia sesión'}
          </button>
          {mode === 'login' && (
            <button type="button" className={btnGhost} onClick={() => switchMode('forgot')}>
              ¿Olvidaste tu contraseña?
            </button>
          )}
        </div>
        {mode !== 'forgot' && <GoogleButton onAuth={onAuth} onError={setError} />}
      </form>
    </div>
  );
}

// Pantalla de nueva contraseña (llega desde el enlace del correo: #/reset/TOKEN)
function ResetPassword({ token, onAuth }: { token: string; onAuth: (user: User) => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError('Las contraseñas no coinciden'); return; }
    setBusy(true);
    setError('');
    try {
      const data = await post<{ token: string; user: User }>('/api/auth/reset', { token, password });
      setToken(data.token);
      location.hash = '';
      onAuth(data.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-ink [background-image:radial-gradient(ellipse_at_top,#1a1f3a_0%,var(--color-ink)_62%)]">
      <form onSubmit={submit} className="flex w-[380px] flex-col gap-3.5 rounded-2xl border border-edge bg-panel p-9 shadow-2xl shadow-black/50">
        <LinkMark />
        <h1 className="font-display text-[22px] font-extrabold tracking-tight">Nueva contraseña</h1>
        <p className="text-[13px] text-dim">Elige una contraseña nueva para tu cuenta. Se cerrarán las sesiones abiertas.</p>
        <input className={inputBase} type="password" placeholder="Nueva contraseña (mín. 8 caracteres)" autoFocus
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <input className={inputBase} type="password" placeholder="Repite la contraseña"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {error && <div className="text-[13px] text-danger">{error}</div>}
        <button className={btnPrimary} disabled={busy || !password}>Guardar y entrar</button>
        <button type="button" className={btnGhost} onClick={() => { location.hash = ''; location.reload(); }}>
          Volver al inicio de sesión
        </button>
      </form>
    </div>
  );
}

// ---------- Shell autenticado ----------
function Workspace({ user, onLogout, onUserChanged }: {
  user: User;
  onLogout: () => void;
  onUserChanged: () => void;
}) {
  const route = useHashRoute();
  const [boards, setBoards] = useState<Board[]>([]);
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // null = modal cerrado; '' = abierto sin mensaje; texto = abierto por un bloqueo
  const [upgradeMsg, setUpgradeMsg] = useState<string | null>(null);
  const isPremium = user.plan === 'premium';

  // Cualquier 403 de plan (premium_required / limit_reached) abre el modal
  useEffect(() => {
    const onBlock = (e: Event) => setUpgradeMsg((e as CustomEvent).detail?.message ?? '');
    window.addEventListener('quarryhq:plan-block', onBlock);
    return () => window.removeEventListener('quarryhq:plan-block', onBlock);
  }, []);

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
    try {
      const { board } = await post<{ board: Board }>('/api/boards', { name });
      await refreshSidebar();
      navigate(`/board/${board.id}`);
    } catch (err: any) {
      if (!isPlanError(err)) alert(err.message); // los errores de plan abren el modal solos
    }
  }

  async function createNote() {
    const title = prompt('Título de la nota:');
    if (!title?.trim()) return;
    try {
      const { note } = await post<{ note: { id: number } }>('/api/notes', { title });
      await refreshSidebar();
      navigate(`/notes/${note.id}`);
    } catch (err: any) {
      if (!isPlanError(err)) alert(err.message);
    }
  }

  async function createChannel() {
    const name = prompt('Nombre del canal:');
    if (!name?.trim()) return;
    try {
      const { channel } = await post<{ channel: Channel }>('/api/channels', { name });
      await refreshSidebar();
      navigate(`/chat/${channel.id}`);
    } catch (err: any) {
      if (!isPlanError(err)) alert(err.message);
    }
  }

  async function logout() {
    try { await post('/api/logout'); } catch { /* la sesión ya no existe */ }
    disconnectWs();
    setToken(null);
    onLogout();
  }

  const [section, param] = route;

  const newButton = (onClick: () => void, title: string) => (
    <button onClick={onClick} title={title} className="px-1 text-[15px] leading-none text-dim transition-colors hover:text-fg">+</button>
  );

  return (
    <div className="flex h-full">
      <nav className="flex w-48 shrink-0 flex-col overflow-y-auto border-r border-edge bg-panel lg:w-60">
        <div className="flex items-center gap-2 border-b border-edge p-4 font-display text-[17px] font-bold tracking-tight">
          <svg viewBox="0 0 24 24" className="h-6.5 w-6.5" aria-hidden>
            <line x1="5" y1="17" x2="12" y2="6" stroke="var(--color-edge)" strokeWidth="1.5" />
            <line x1="12" y1="6" x2="19" y2="17" stroke="var(--color-edge)" strokeWidth="1.5" />
            <circle cx="5" cy="17" r="3.4" fill="var(--color-board)" />
            <circle cx="12" cy="6" r="3.4" fill="var(--color-note)" />
            <circle cx="19" cy="17" r="3.4" fill="var(--color-chat)" />
          </svg>
          QuarryHQ
        </div>
        <button
          onClick={() => setPaletteOpen(true)}
          className="m-3 flex items-center justify-between rounded-lg border border-edge bg-ink px-3 py-2 text-left text-[13px] text-dim transition-colors hover:border-accent"
        >
          Buscar en todo…
          <kbd className="rounded border border-edge bg-raised px-1.5 py-px font-sans text-[11px]">Ctrl K</kbd>
        </button>

        <div className="px-3 py-1.5">
          <div className={sideHeading}>Tableros {newButton(createBoard, 'Nuevo tablero')}</div>
          {boards.map((b) => (
            <button key={b.id} className={sideItem(section === 'board' && Number(param) === b.id, 'board')}
              onClick={() => navigate(`/board/${b.id}`)}>
              <span className={`${sideIcon} text-board`}>▦</span><span className={sideLabel}>{b.name}</span>
            </button>
          ))}
        </div>

        <div className="px-3 py-1.5">
          <div className={sideHeading}>Notas {newButton(createNote, 'Nueva nota')}</div>
          {notes.slice(0, 8).map((n) => (
            <button key={n.id} className={sideItem(section === 'notes' && Number(param) === n.id, 'note')}
              onClick={() => navigate(`/notes/${n.id}`)}>
              <span className={`${sideIcon} text-note`}>◆</span><span className={sideLabel}>{n.title}</span>
            </button>
          ))}
          {notes.length > 8 && (
            <button className={sideItem(false)} onClick={() => setPaletteOpen(true)}>
              <span className={sideIcon}>…</span><span className={sideLabel}>{notes.length - 8} notas más</span>
            </button>
          )}
        </div>

        <div className="px-3 py-1.5">
          <div className={sideHeading}>Canales {newButton(createChannel, 'Nuevo canal')}</div>
          {channels.map((c) => (
            <button key={c.id} className={sideItem(section === 'chat' && Number(param) === c.id, 'chat')}
              onClick={() => navigate(`/chat/${c.id}`)}>
              <span className={`${sideIcon} text-chat`}>#</span><span className={sideLabel}>{c.name}</span>
            </button>
          ))}
        </div>

        <div className="px-3 py-1.5">
          <button className={sideItem(section === 'graph')} onClick={() => navigate('/graph')}>
            <span className={sideIcon}>◉</span><span className={sideLabel}>Grafo de conocimiento</span>
          </button>
        </div>

        <div className="mt-auto">
          <div className="px-3 pb-1">
            {isPremium ? (
              <button
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-[12px] font-semibold text-accent transition hover:bg-accent/15"
                onClick={() => setUpgradeMsg('')}>
                ★ Premium
              </button>
            ) : (
              <button
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-ink transition hover:brightness-110"
                onClick={() => setUpgradeMsg('')}>
                ⚡ Pasar a Premium
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-edge p-3 text-[13px] text-dim">
            <span className="flex min-w-0 items-center gap-2">
              {user.picture && <img src={user.picture} alt="" referrerPolicy="no-referrer" className="h-5 w-5 shrink-0 rounded-full" />}
              <span className={sideLabel} title={`@${user.username}`}>{user.name ?? `@${user.username}`}</span>
            </span>
            <button className={btnGhost} onClick={logout}>Salir</button>
          </div>
        </div>
      </nav>

      <main className="flex flex-1 flex-col overflow-hidden">
        {section === 'board' && param && (
          <BoardView boardId={Number(param)} initialCardId={route[2] === 'card' ? Number(route[3]) : undefined} isPremium={isPremium} />
        )}
        {section === 'notes' && (
          <NotesView noteId={param ? Number(param) : notes[0]?.id} notes={notes} onChanged={refreshSidebar} isPremium={isPremium} />
        )}
        {section === 'chat' && param && <ChatView channelId={Number(param)} user={user} isPremium={isPremium} />}
        {section === 'graph' && <GraphView />}
        {!section && (
          <div className={emptyState}>
            <h3 className="font-display text-base font-bold text-fg">Bienvenido a QuarryHQ</h3>
            <p>Crea un tablero, una nota o un canal desde la barra lateral.</p>
          </div>
        )}
      </main>

      {paletteOpen && <SearchPalette onClose={() => setPaletteOpen(false)} />}
      {upgradeMsg !== null && (
        <UpgradeModal plan={user.plan ?? 'free'}
          message={upgradeMsg || undefined}
          onClose={() => setUpgradeMsg(null)}
          onChanged={onUserChanged} />
      )}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!!getToken());

  const refreshUser = useCallback(() => {
    get<{ user: User }>('/api/me')
      .then(({ user }) => setUser(user))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!getToken()) return;
    get<{ user: User }>('/api/me')
      .then(({ user }) => setUser(user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className={`${emptyState} h-screen`}>Cargando…</div>;
  const resetMatch = location.hash.match(/^#\/reset\/([a-f0-9]{64})$/);
  if (resetMatch) return <ResetPassword token={resetMatch[1]} onAuth={setUser} />;
  if (!user) return <Login onAuth={setUser} />;
  return <Workspace user={user} onLogout={() => setUser(null)} onUserChanged={refreshUser} />;
}
