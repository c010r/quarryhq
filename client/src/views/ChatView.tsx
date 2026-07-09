import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, patch, del, onWsEvent } from '../api';
import type { Channel, Message, Reaction, ScheduledMessage, User } from '../types';
import { renderInlineMarkdown } from '../markdown';
import { navigate } from '../App';

const AVATAR_COLORS = ['#8b5cf6', '#3b82f6', '#22c55e', '#f97316', '#ec4899', '#14b8a6'];
const QUICK_EMOJIS = ['👍', '❤️', '✅', '🎉', '👀'];

function avatarColor(username: string): string {
  let hash = 0;
  for (const ch of username) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatTime(iso: string): string {
  const date = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function onWikilinkClick(e: React.MouseEvent) {
  const anchor = (e.target as HTMLElement).closest('a');
  if (anchor?.getAttribute('href')?.startsWith('#/wiki/')) {
    e.preventDefault();
    navigate(anchor.getAttribute('href')!.slice(1));
  }
}

function MessageItem({ message, user, reactions, inThread, onReact, onOpenThread, onPin, onEdit, onDelete }: {
  message: Message;
  user: User;
  reactions: Reaction[];
  inThread?: boolean;
  onReact: (id: number, emoji: string) => void;
  onOpenThread?: (id: number) => void;
  onPin: (id: number) => void;
  onEdit: (id: number, content: string) => Promise<void>;
  onDelete: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const mine = message.user_id === user.id;

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (draft.trim() && draft !== message.content) await onEdit(message.id, draft.trim());
    setEditing(false);
  }

  return (
    <div className="chat-message">
      <div className="msg-actions">
        {QUICK_EMOJIS.slice(0, 3).map((emoji) => (
          <button key={emoji} onClick={() => onReact(message.id, emoji)} title={`Reaccionar ${emoji}`}>{emoji}</button>
        ))}
        {onOpenThread && <button onClick={() => onOpenThread(message.id)} title="Responder en hilo">💬</button>}
        <button onClick={() => onPin(message.id)} title={message.pinned ? 'Desfijar' : 'Fijar mensaje'}>
          {message.pinned ? '📌✕' : '📌'}
        </button>
        {mine && <button onClick={() => { setDraft(message.content); setEditing(true); }} title="Editar">✏️</button>}
        {mine && <button onClick={() => onDelete(message.id)} title="Eliminar">🗑</button>}
      </div>
      <div className="chat-avatar" style={{ background: avatarColor(message.username) }}>
        {message.username.slice(0, 1).toUpperCase()}
      </div>
      <div className="msg-body">
        <div className="msg-head">
          <span className="author">{message.username}{mine ? ' (tú)' : ''}</span>
          <span className="time">{formatTime(message.created_at)}</span>
          {message.pinned ? <span className="time">📌</span> : null}
          {message.edited_at && <span className="edited-mark">(editado)</span>}
        </div>
        {editing ? (
          <form className="msg-edit-form" onSubmit={submitEdit}>
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} />
            <button className="btn-small" type="submit">Guardar</button>
          </form>
        ) : (
          <div className="msg-text" onClick={onWikilinkClick}
            dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(message.content) }} />
        )}
        {reactions.length > 0 && (
          <div className="reactions-row">
            {reactions.map((r) => (
              <button key={r.emoji} className={`reaction-chip ${r.mine ? 'mine' : ''}`}
                onClick={() => onReact(message.id, r.emoji)}>
                {r.emoji} {r.count}
              </button>
            ))}
          </div>
        )}
        {!inThread && (message.reply_count ?? 0) > 0 && onOpenThread && (
          <a className="thread-link" href="#" onClick={(e) => { e.preventDefault(); onOpenThread(message.id); }}>
            💬 {message.reply_count} {message.reply_count === 1 ? 'respuesta' : 'respuestas'} — ver hilo
          </a>
        )}
      </div>
    </div>
  );
}

export default function ChatView({ channelId, user }: { channelId: number; user: User }) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [pinned, setPinned] = useState<{ id: number; content: string; username: string }[]>([]);
  const [showPinned, setShowPinned] = useState(false);
  const [draft, setDraft] = useState('');
  const [threadId, setThreadId] = useState<number | null>(null);
  const [thread, setThread] = useState<{ parent: Message; replies: Message[] } | null>(null);
  const [threadDraft, setThreadDraft] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [scheduled, setScheduled] = useState<ScheduledMessage[]>([]);
  const [showScheduled, setShowScheduled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await get<{
        channel: Channel; messages: Message[]; reactions: Reaction[];
        pinned: { id: number; content: string; username: string }[];
      }>(`/api/channels/${channelId}/messages`);
      setChannel(data.channel);
      setMessages(data.messages);
      setReactions(data.reactions);
      setPinned(data.pinned);
    } catch { setChannel(null); }
  }, [channelId]);

  const loadScheduled = useCallback(async () => {
    const data = await get<{ scheduled: ScheduledMessage[] }>(`/api/channels/${channelId}/scheduled`);
    setScheduled(data.scheduled);
  }, [channelId]);

  const loadThread = useCallback(async (id: number) => {
    const data = await get<{ parent: Message; replies: Message[] }>(`/api/messages/${id}/thread`);
    setThread(data);
  }, []);

  useEffect(() => { load(); loadScheduled(); setThreadId(null); setThread(null); }, [load, loadScheduled]);

  useEffect(() => onWsEvent((e) => {
    if (e.type === 'message:new' && e.channelId === channelId) {
      if (!e.message.parent_id) {
        setMessages((prev) => prev.some((m) => m.id === e.message.id) ? prev : [...prev, e.message]);
        loadScheduled();
      } else {
        // Respuesta de hilo: refrescar contador y el hilo abierto
        load();
        if (threadId !== null && threadId === e.message.parent_id) loadThread(threadId);
      }
    }
    if (e.type === 'chat:changed' && e.channelId === channelId) {
      load();
      if (threadId) loadThread(threadId);
    }
  }), [channelId, threadId, load, loadThread, loadScheduled]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  useEffect(() => {
    if (threadId) loadThread(threadId);
    else setThread(null);
  }, [threadId, loadThread]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setDraft('');
    try {
      const { message } = await post<{ message: Message }>(`/api/channels/${channelId}/messages`, { content });
      setMessages((prev) => prev.some((m) => m.id === message.id) ? prev : [...prev, message]);
    } catch (err: any) {
      alert(err.message);
      setDraft(content);
    }
  }

  async function sendThreadReply(e: React.FormEvent) {
    e.preventDefault();
    const content = threadDraft.trim();
    if (!content || !threadId) return;
    setThreadDraft('');
    await post(`/api/channels/${channelId}/messages`, { content, parent_id: threadId });
    loadThread(threadId);
    load();
  }

  async function schedule() {
    const content = draft.trim();
    if (!content || !scheduleAt) return;
    try {
      await post(`/api/channels/${channelId}/schedule`, { content, send_at: scheduleAt });
      setDraft('');
      setShowSchedule(false);
      setScheduleAt('');
      loadScheduled();
    } catch (err: any) { alert(err.message); }
  }

  async function cancelScheduled(id: number) {
    await del(`/api/scheduled/${id}`);
    loadScheduled();
  }

  const react = (id: number, emoji: string) => post(`/api/messages/${id}/react`, { emoji }).then(load);
  const pin = (id: number) => post(`/api/messages/${id}/pin`).then(load);
  const editMessage = async (id: number, content: string) => { await patch(`/api/messages/${id}`, { content }); load(); };
  const deleteMessage = async (id: number) => {
    if (!confirm('¿Eliminar este mensaje?')) return;
    await del(`/api/messages/${id}`);
    if (threadId === id) setThreadId(null);
    load();
  };

  const reactionsFor = (id: number) => reactions.filter((r) => r.message_id === id);

  if (!channel) return <div className="empty-state">Canal no encontrado.</div>;

  return (
    <div className="chat-layout">
      <div className="main-header">
        <h2># {channel.name}</h2>
        <span className="subtitle">{messages.length} mensajes</span>
      </div>

      {channel.card_id && (
        <div className="chat-card-banner">
          ▦ Este canal discute la tarjeta
          <a href="#" onClick={async (e) => {
            e.preventDefault();
            const { card } = await get<{ card: { board_id: number } }>(`/api/cards/${channel.card_id}`);
            navigate(`/board/${card.board_id}/card/${channel.card_id}`);
          }}>
            <strong>{channel.card_title ?? `#${channel.card_id}`}</strong>
          </a>
        </div>
      )}

      {pinned.length > 0 && (
        <div className="pinned-bar" onClick={() => setShowPinned(!showPinned)}>
          📌 {pinned.length} {pinned.length === 1 ? 'mensaje fijado' : 'mensajes fijados'} {showPinned ? '▲' : '▼'}
          {showPinned && (
            <div className="pinned-list">
              {pinned.map((p) => (
                <div key={p.id} className="pin-item">
                  <strong>{p.username}:</strong> {p.content}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="chat-with-thread">
        <div className="chat-main-col">
          <div className="chat-messages" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="empty-state" style={{ height: 'auto', padding: 40 }}>
                <p>Todavía no hay mensajes en #{channel.name}. ¡Escribe el primero!</p>
              </div>
            )}
            {messages.map((m) => (
              <MessageItem key={m.id} message={m} user={user} reactions={reactionsFor(m.id)}
                onReact={react} onOpenThread={setThreadId} onPin={pin}
                onEdit={editMessage} onDelete={deleteMessage} />
            ))}
          </div>

          <div className="chat-composer">
            <form onSubmit={send} style={{ position: 'relative' }}>
              <input value={draft} onChange={(e) => setDraft(e.target.value)}
                placeholder={`Mensaje para #${channel.name}`} autoFocus />
              <button type="button" className="btn-cancel" title="Programar envío"
                onClick={() => setShowSchedule(!showSchedule)}>⏰</button>
              <button className="btn-small" type="submit">Enviar</button>
              {showSchedule && (
                <div className="schedule-popover">
                  <strong style={{ fontSize: 13 }}>⏰ Enviar más tarde</strong>
                  <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
                  <button className="btn-small" type="button" onClick={schedule}
                    disabled={!draft.trim() || !scheduleAt}>
                    Programar mensaje
                  </button>
                  <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                    Se enviará el texto escrito en el cuadro de mensaje.
                  </span>
                </div>
              )}
            </form>
            <div className="hint">
              Usa <strong>[[Título de nota]]</strong> para enlazar una nota.
              {scheduled.length > 0 && (
                <>
                  {' · '}
                  <a href="#" onClick={(e) => { e.preventDefault(); setShowScheduled(!showScheduled); }}>
                    ⏰ {scheduled.length} {scheduled.length === 1 ? 'programado' : 'programados'}
                  </a>
                </>
              )}
            </div>
            {showScheduled && scheduled.map((s) => (
              <div key={s.id} className="scheduled-item">
                <span>“{s.content.slice(0, 60)}” → {new Date(s.send_at).toLocaleString('es')}</span>
                <button onClick={() => cancelScheduled(s.id)}>Cancelar</button>
              </div>
            ))}
          </div>
        </div>

        {thread && (
          <div className="thread-panel">
            <div className="thread-header">
              💬 Hilo
              <button className="modal-close" onClick={() => setThreadId(null)}>✕</button>
            </div>
            <div className="thread-messages">
              <MessageItem message={thread.parent} user={user} reactions={reactionsFor(thread.parent.id)}
                inThread onReact={react} onPin={pin} onEdit={editMessage} onDelete={deleteMessage} />
              <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0', paddingTop: 4, color: 'var(--text-dim)', fontSize: 12 }}>
                {thread.replies.length} {thread.replies.length === 1 ? 'respuesta' : 'respuestas'}
              </div>
              {thread.replies.map((r) => (
                <MessageItem key={r.id} message={r} user={user} reactions={reactionsFor(r.id)}
                  inThread onReact={react} onPin={pin} onEdit={editMessage} onDelete={deleteMessage} />
              ))}
            </div>
            <form className="thread-composer" onSubmit={sendThreadReply}>
              <input value={threadDraft} onChange={(e) => setThreadDraft(e.target.value)}
                placeholder="Responder en el hilo…" />
              <button className="btn-small" type="submit">↩</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
