localStorage.removeItem('quarryhq_token');
let token: string | null = null;

export function setToken(t: string | null) {
  token = t;
}

export function getToken() { return token; }

export class ApiError extends Error {
  code?: string;
  status?: number;
}

// El servidor responde 403 con estos códigos cuando el plan Free bloquea la
// acción; cualquier parte de la UI puede escuchar el evento y ofrecer upgrade.
export function isPlanError(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'premium_required' || err.code === 'limit_reached');
}

export function notifyPlanBlock(message: string) {
  window.dispatchEvent(new CustomEvent('quarryhq:plan-block', { detail: { message } }));
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(data.error ?? `Error ${res.status}`);
    err.code = data.code;
    err.status = res.status;
    if (isPlanError(err)) notifyPlanBlock(err.message);
    throw err;
  }
  return data as T;
}

export const get = <T = any>(path: string) => api<T>(path);
export const post = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const patch = <T = any>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

// ---------- WebSocket con reconexión ----------
type WsListener = (event: any) => void;
const listeners = new Set<WsListener>();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsEnabled = false;

export function connectWs() {
  wsEnabled = true;
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      listeners.forEach((fn) => fn(event));
    } catch { /* ignorar mensajes malformados */ }
  };
  socket.onclose = () => {
    socket = null;
    if (wsEnabled && !reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWs(); }, 2000);
    }
  };
}

export function disconnectWs() {
  wsEnabled = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  socket?.close();
  socket = null;
}

export function onWsEvent(fn: WsListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Mensajes cliente -> servidor (hoy solo presencia: "estoy viendo este tablero/nota/canal").
// Best-effort: si el socket no está abierto todavía, se pierde (no es crítico, la
// presencia es efímera y se resincroniza sola en la próxima acción).
export function sendWs(event: Record<string, unknown>) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}
