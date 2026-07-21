import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, patch, del, onWsEvent, notifyPlanBlock, sendWs } from '../api';
import type { Channel, Message, Reaction, ScheduledMessage, User } from '../types';
import { renderInlineMarkdown } from '../markdown';
import { navigate } from '../App';
import { avatarColor, btnSmall, headerBtn, emptyState, mainHeader, modalClose, viewTitle } from '../ui';
import { alertDialog, confirmDialog } from '../dialog';
import ShareModal from './ShareModal';
import PresenceAvatars, { type PresenceViewer } from './PresenceAvatars';

const QUICK_EMOJIS = ['👍', '❤️', '✅', '🎉', '👀'];

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

function MessageItem({ message, user, reactions, inThread, isViewer, onReact, onOpenThread, onPin, onEdit, onDelete }: {
  message: Message;
  user: User;
  reactions: Reaction[];
  inThread?: boolean;
  isViewer?: boolean;
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

  const actionBtn = 'rounded-md px-1.5 py-1 text-[13px] transition-colors hover:bg-hover';

  return (
    <div className="group relative flex gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-panel">
      <div className="absolute -top-3 right-2 hidden gap-0.5 rounded-lg border border-edge bg-raised p-0.5 shadow-lg shadow-black/30 group-focus-within:flex group-hover:flex">
        {!isViewer && QUICK_EMOJIS.slice(0, 3).map((emoji) => (
          <button key={emoji} className={actionBtn} onClick={() => onReact(message.id, emoji)} title={`Reaccionar ${emoji}`}>{emoji}</button>
        ))}
        {onOpenThread && <button className={actionBtn} onClick={() => onOpenThread(message.id)} title="Responder en hilo">💬</button>}
        {!isViewer && (
          <button className={actionBtn} onClick={() => onPin(message.id)} title={message.pinned ? 'Desfijar' : 'Fijar mensaje'}>
            {message.pinned ? '📌✕' : '📌'}
          </button>
        )}
        {mine && !isViewer && <button className={actionBtn} onClick={() => { setDraft(message.content); setEditing(true); }} title="Editar">✏️</button>}
        {mine && !isViewer && <button className={actionBtn} onClick={() => onDelete(message.id)} title="Eliminar">🗑</button>}
      </div>
      <div className="flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-ink"
        style={{ background: avatarColor(message.username) }}>
        {message.username.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13.5px] font-bold">{message.username}{mine ? ' (tú)' : ''}</span>
          <span className="text-[11.5px] text-dim">{formatTime(message.created_at)}</span>
          {message.pinned ? <span className="text-[11.5px]">📌</span> : null}
          {message.edited_at && <span className="text-[11px] text-dim">(editado)</span>}
        </div>
        {editing ? (
          <form className="mt-0.5 flex gap-1.5" onSubmit={submitEdit}>
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
              className="flex-1 rounded-lg border border-accent bg-ink px-2.5 py-1.5 text-[13px] outline-none" />
            <button className={btnSmall} type="submit">Guardar</button>
          </form>
        ) : (
          <div className="md" onClick={onWikilinkClick}
            dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(message.content) }} />
        )}
        {reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {reactions.map((r) => (
              <button key={r.emoji} disabled={isViewer}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                  r.mine ? 'border-chat bg-chat/10' : 'border-edge bg-raised hover:border-chat'
                } disabled:cursor-default`}
                onClick={() => onReact(message.id, r.emoji)}>
                {r.emoji} {r.count}
              </button>
            ))}
          </div>
        )}
        {!inThread && (message.reply_count ?? 0) > 0 && onOpenThread && (
          <a className="mt-1 inline-block text-xs text-chat hover:brightness-110" href="#"
            onClick={(e) => { e.preventDefault(); onOpenThread(message.id); }}>
            💬 {message.reply_count} {message.reply_count === 1 ? 'respuesta' : 'respuestas'} — ver hilo
          </a>
        )}
      </div>
    </div>
  );
}

export default function ChatView({ channelId, user, isPremium }: { channelId: number; user: User; isPremium: boolean }) {
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
  const [showShare, setShowShare] = useState(false);
  const isViewer = channel?.myRole === 'viewer';
  const [viewers, setViewers] = useState<PresenceViewer[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Presencia: le avisa al resto quién está mirando este canal ahora
  useEffect(() => {
    sendWs({ type: 'presence:join', resourceType: 'channel', resourceId: channelId });
    return () => sendWs({ type: 'presence:leave' });
  }, [channelId]);
  useEffect(() => onWsEvent((e) => {
    if (e.type === 'presence:update' && e.resourceType === 'channel' && e.resourceId === channelId) setViewers(e.viewers);
  }), [channelId]);

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
      alertDialog(err.message);
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
    } catch (err: any) { alertDialog(err.message); }
  }

  async function cancelScheduled(id: number) {
    await del(`/api/scheduled/${id}`);
    loadScheduled();
  }

  const react = (id: number, emoji: string) => post(`/api/messages/${id}/react`, { emoji }).then(load);
  const pin = (id: number) => post(`/api/messages/${id}/pin`).then(load);
  const editMessage = async (id: number, content: string) => { await patch(`/api/messages/${id}`, { content }); load(); };
  const deleteMessage = async (id: number) => {
    if (!await confirmDialog('¿Eliminar este mensaje?', { danger: true, confirmText: 'Eliminar' })) return;
    await del(`/api/messages/${id}`);
    if (threadId === id) setThreadId(null);
    load();
  };

  const reactionsFor = (id: number) => reactions.filter((r) => r.message_id === id);

  if (!channel) return (
    <div className={emptyState}>
      <span className="text-3xl opacity-60">#</span>
      <p>No encontramos este canal. Puede que ya no exista o que hayas perdido el acceso.</p>
    </div>
  );

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className={mainHeader}>
        <h2 className={viewTitle + " truncate"}><span className="text-chat">#</span> {channel.name}</h2>
        <span className="text-[13px] text-dim">{messages.length} mensajes</span>
        {channel.shared && <span className="text-[12px] text-dim">🤝 compartido por @{channel.owner_username}</span>}
        <PresenceAvatars viewers={viewers} currentUserId={user.id} />
        <button className={`${headerBtn} sm:ml-auto`} onClick={() => setShowShare(true)}>🤝 Compartir</button>
      </div>

      {channel.card_id && (
        <div className="mx-3 mt-3 flex flex-wrap items-center gap-2 sm:mx-5 rounded-lg border border-board/60 bg-board/10 px-3.5 py-2.5 text-[13px]">
          <span className="text-board">▦</span> Este canal discute la tarjeta
          <a href="#" className="text-accent hover:brightness-110" onClick={async (e) => {
            e.preventDefault();
            const { card } = await get<{ card: { board_id: number } }>(`/api/cards/${channel.card_id}`);
            navigate(`/board/${card.board_id}/card/${channel.card_id}`);
          }}>
            <strong>{channel.card_title ?? `#${channel.card_id}`}</strong>
          </a>
        </div>
      )}

      {pinned.length > 0 && (
        <div className="mx-3 mt-2.5 cursor-pointer sm:mx-5 rounded-lg border border-edge bg-panel px-3.5 py-2 text-xs text-dim transition-colors hover:border-chat"
          onClick={() => setShowPinned(!showPinned)}>
          📌 {pinned.length} {pinned.length === 1 ? 'mensaje fijado' : 'mensajes fijados'} {showPinned ? '▲' : '▼'}
          {showPinned && (
            <div className="mt-2 flex flex-col gap-1">
              {pinned.map((p) => (
                <div key={p.id} className="border-t border-edge py-1 text-fg">
                  <strong>{p.username}:</strong> {p.content}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-3 sm:px-5 sm:py-4" ref={scrollRef}>
            {messages.length === 0 && (
              <div className={`${emptyState} h-auto p-10`}>
                <p>Todavía no hay mensajes en #{channel.name}. ¡Escribe el primero!</p>
              </div>
            )}
            {messages.map((m) => (
              <MessageItem key={m.id} message={m} user={user} reactions={reactionsFor(m.id)} isViewer={isViewer}
                onReact={react} onOpenThread={setThreadId} onPin={pin}
                onEdit={editMessage} onDelete={deleteMessage} />
            ))}
          </div>

          <div className="shrink-0 px-3 pb-3 pt-3 sm:px-5 sm:pb-4.5">
            {isViewer ? (
              <p className="rounded-xl border border-edge bg-panel px-3 py-2.5 text-center text-[13px] text-dim">
                👁 Solo lectura — no podés escribir en este canal.
              </p>
            ) : (
            <form onSubmit={send} className="relative flex flex-wrap gap-2 rounded-xl border border-edge bg-panel p-2 transition-colors focus-within:border-chat">
              <input value={draft} onChange={(e) => setDraft(e.target.value)}
                placeholder={`Mensaje para #${channel.name}`} autoFocus
                className="min-w-40 flex-1 bg-transparent px-2 py-1 outline-none" />
              <button type="button" className="px-2 text-[13px] text-dim transition-colors hover:text-fg"
                title={isPremium ? 'Programar envío' : 'Programar envío (Premium)'}
                onClick={() => isPremium ? setShowSchedule(!showSchedule) : notifyPlanBlock('Los mensajes programados son parte de Premium.')}>
                ⏰{!isPremium && '🔒'}
              </button>
              <button className={btnSmall} type="submit">Enviar</button>
              {showSchedule && (
                <div className="absolute bottom-full right-0 z-20 mb-2 flex w-[min(16rem,calc(100dvw-2rem))] flex-col gap-2 rounded-xl border border-edge bg-raised p-3 shadow-xl shadow-black/40">
                  <strong className="text-[13px]">⏰ Enviar más tarde</strong>
                  <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)}
                    className="rounded-lg border border-edge bg-ink px-2.5 py-1.5 text-[13px] outline-none focus:border-accent" />
                  <button className={btnSmall} type="button" onClick={schedule}
                    disabled={!draft.trim() || !scheduleAt}>
                    Programar mensaje
                  </button>
                  <span className="text-[11.5px] text-dim">
                    Se enviará el texto escrito en el cuadro de mensaje.
                  </span>
                </div>
              )}
            </form>
            )}
            <div className="mt-1.5 pl-1 text-[11.5px] text-dim">
              Usa <strong className="text-chat">[[Título de nota]]</strong> para enlazar una nota.
              {scheduled.length > 0 && (
                <>
                  {' · '}
                  <a href="#" className="text-accent hover:brightness-110"
                    onClick={(e) => { e.preventDefault(); setShowScheduled(!showScheduled); }}>
                    ⏰ {scheduled.length} {scheduled.length === 1 ? 'programado' : 'programados'}
                  </a>
                </>
              )}
            </div>
            {showScheduled && scheduled.map((s) => (
              <div key={s.id} className="flex justify-between gap-2 py-0.5 text-xs text-dim">
                <span>“{s.content.slice(0, 60)}” → {new Date(s.send_at).toLocaleString('es')}</span>
                <button className="text-[11px] text-danger" onClick={() => cancelScheduled(s.id)}>Cancelar</button>
              </div>
            ))}
          </div>
        </div>

        {thread && (
          <div className="fixed inset-x-3 bottom-3 top-16 z-40 flex animate-modal-in flex-col rounded-xl border border-edge bg-panel shadow-2xl shadow-black/50 md:static md:inset-auto md:z-auto md:w-[360px] md:shrink-0 md:animate-panel-in md:rounded-none md:border-y-0 md:border-r-0 md:shadow-none">
            <div className="flex items-center justify-between border-b border-edge px-4 py-3 font-display font-bold">
              💬 Hilo
              <button className={modalClose} onClick={() => setThreadId(null)}>✕</button>
            </div>
            <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
              <MessageItem message={thread.parent} user={user} reactions={reactionsFor(thread.parent.id)} isViewer={isViewer}
                inThread onReact={react} onPin={pin} onEdit={editMessage} onDelete={deleteMessage} />
              <div className="my-2 border-t border-edge pt-1 text-xs text-dim">
                {thread.replies.length} {thread.replies.length === 1 ? 'respuesta' : 'respuestas'}
              </div>
              {thread.replies.map((r) => (
                <MessageItem key={r.id} message={r} user={user} reactions={reactionsFor(r.id)} isViewer={isViewer}
                  inThread onReact={react} onPin={pin} onEdit={editMessage} onDelete={deleteMessage} />
              ))}
            </div>
            {!isViewer && (
              <form className="flex flex-wrap gap-1.5 border-t border-edge p-3" onSubmit={sendThreadReply}>
                <input value={threadDraft} onChange={(e) => setThreadDraft(e.target.value)}
                  placeholder="Responder en el hilo…"
                  className="min-w-0 flex-1 rounded-lg border border-edge bg-ink px-2.5 py-2 text-[13px] outline-none transition-colors focus:border-chat" />
                <button className={btnSmall} type="submit">↩</button>
              </form>
            )}
          </div>
        )}
      </div>
      {showShare && (
        <ShareModal type="channel" resourceId={channelId} resourceName={channel.name} currentUserId={user.id} isPremium={isPremium} onClose={() => setShowShare(false)} />
      )}
    </div>
  );
}
