import { useCallback, useEffect, useState } from 'react';
import { get, post, patch, del } from '../api';
import type { Backlink, Card, Channel, ChecklistItem, LinkedNote, NoteMeta, User } from '../types';
import { LABEL_COLORS } from '../types';
import { navigate } from '../App';
import { btnDanger, btnGhost, btnSmall, chip, chipAdd, chipRemove, inputBase, modalBackdrop, modalBox, modalClose, sectionTitle, selectBase } from '../ui';

interface CardDetail {
  card: Card;
  linkedNotes: LinkedNote[];
  discussion: { id: number; name: string } | null;
  mentions: Backlink[];
  checklist: ChecklistItem[];
  members: User[];
}

export default function CardModal({ cardId, onClose }: { cardId: number; onClose: () => void }) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [allNotes, setAllNotes] = useState<NoteMeta[]>([]);
  const [pickingNote, setPickingNote] = useState(false);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [pickingMember, setPickingMember] = useState(false);
  const [newItem, setNewItem] = useState('');

  const load = useCallback(async () => {
    const data = await get<CardDetail>(`/api/cards/${cardId}`);
    setDetail(data);
    setTitle(data.card.title);
    setDescription(data.card.description);
  }, [cardId]);

  useEffect(() => { load(); }, [load]);

  if (!detail) return null;
  const labels: string[] = JSON.parse(detail.card.labels || '[]');

  async function save(fields: Partial<{ title: string; description: string; labels: string[]; due_date: string | null; completed: boolean }>) {
    await patch(`/api/cards/${cardId}`, fields);
    load();
  }

  async function addChecklistItem(e: React.FormEvent) {
    e.preventDefault();
    if (!newItem.trim()) return;
    await post(`/api/cards/${cardId}/checklist`, { text: newItem.trim() });
    setNewItem('');
    load();
  }

  async function toggleItem(item: ChecklistItem) {
    await patch(`/api/checklist/${item.id}`, { done: !item.done });
    load();
  }

  async function removeItem(item: ChecklistItem) {
    await del(`/api/checklist/${item.id}`);
    load();
  }

  async function startPickingMember() {
    const { users } = await get<{ users: User[] }>('/api/users');
    setAllUsers(users.filter((u) => !detail!.members.some((m) => m.id === u.id)));
    setPickingMember(true);
  }

  async function addMember(userId: number) {
    await post(`/api/cards/${cardId}/members`, { user_id: userId });
    setPickingMember(false);
    load();
  }

  async function removeMember(userId: number) {
    await del(`/api/cards/${cardId}/members/${userId}`);
    load();
  }

  async function toggleLabel(name: string) {
    const next = labels.includes(name) ? labels.filter((l) => l !== name) : [...labels, name];
    save({ labels: next });
  }

  async function linkNote(noteId: number) {
    await post('/api/links', { source_type: 'card', source_id: cardId, target_type: 'note', target_id: noteId });
    setPickingNote(false);
    load();
  }

  async function unlinkNote(linkId: number) {
    await del(`/api/links/${linkId}`);
    load();
  }

  async function openDiscussion() {
    const { channel } = await post<{ channel: Channel }>(`/api/cards/${cardId}/discussion`);
    onClose();
    navigate(`/chat/${channel.id}`);
  }

  async function removeCard() {
    if (!confirm('¿Eliminar esta tarjeta?')) return;
    await del(`/api/cards/${cardId}`);
    onClose();
  }

  async function startPickingNote() {
    const { notes } = await get<{ notes: NoteMeta[] }>('/api/notes');
    setAllNotes(notes.filter((n) => !detail!.linkedNotes.some((ln) => ln.id === n.id)));
    setPickingNote(true);
  }

  return (
    <div className={modalBackdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={modalBox}>
        <div className="flex items-start justify-between gap-3">
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== detail.card.title && save({ title })}
            className="flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 font-display text-[19px] font-bold outline-none transition-colors focus:border-accent focus:bg-ink" />
          <button className={modalClose} onClick={onClose}>✕</button>
        </div>
        <div className="-mt-2.5 px-2 text-[13px] text-dim">
          en la lista <strong className="text-fg">{detail.card.list_name}</strong>
        </div>

        <div>
          <h4 className={sectionTitle}>Estado y vencimiento</h4>
          <div className="flex flex-wrap items-center gap-2">
            <label className={`${chip} accent-ok`}>
              <input type="checkbox" checked={!!detail.card.completed}
                onChange={(e) => save({ completed: e.target.checked })} />
              Completada
            </label>
            <input type="date" value={detail.card.due_date ?? ''}
              onChange={(e) => save({ due_date: e.target.value || null })}
              className="rounded-lg border border-edge bg-ink px-2.5 py-1.5 text-[13px] outline-none focus:border-accent" />
            {detail.card.due_date && (
              <button className={btnGhost} onClick={() => save({ due_date: null })}>Quitar fecha</button>
            )}
          </div>
        </div>

        <div>
          <h4 className={sectionTitle}>Etiquetas</h4>
          <div className="flex flex-wrap gap-2">
            {Object.entries(LABEL_COLORS).map(([name, color]) => (
              <button key={name} title={name}
                className={`h-6 w-11 rounded-md border-2 transition-all ${labels.includes(name) ? 'border-fg opacity-100' : 'border-transparent opacity-55 hover:opacity-80'}`}
                style={{ background: color }}
                onClick={() => toggleLabel(name)} />
            ))}
          </div>
        </div>

        <div>
          <h4 className={sectionTitle}>Descripción <span className="normal-case tracking-normal">(admite [[wiki-links]] a notas)</span></h4>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)}
            onBlur={() => description !== detail.card.description && save({ description })}
            placeholder="Añade una descripción…"
            className="min-h-28 w-full resize-y rounded-lg border border-edge bg-ink px-3 py-2.5 leading-relaxed outline-none transition-colors focus:border-accent" />
        </div>

        <div>
          <h4 className={sectionTitle}>Checklist {detail.checklist.length > 0 && `(${detail.checklist.filter((i) => i.done).length}/${detail.checklist.length})`}</h4>
          {detail.checklist.length > 0 && (
            <div className="mb-2.5 h-1.5 overflow-hidden rounded-full bg-ink">
              <div className="h-full rounded-full bg-ok transition-all duration-200"
                style={{ width: `${(detail.checklist.filter((i) => i.done).length / detail.checklist.length) * 100}%` }} />
            </div>
          )}
          {detail.checklist.map((item) => (
            <div key={item.id} className="group flex items-center gap-2 py-1">
              <input type="checkbox" checked={!!item.done} onChange={() => toggleItem(item)} className="h-4 w-4 accent-accent" />
              <span className={`flex-1 ${item.done ? 'text-dim line-through' : ''}`}>{item.text}</span>
              <button className="text-dim opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                onClick={() => removeItem(item)}>✕</button>
            </div>
          ))}
          <form className="mt-1.5 flex gap-1.5" onSubmit={addChecklistItem}>
            <input placeholder="Añadir elemento…" value={newItem} onChange={(e) => setNewItem(e.target.value)}
              className={`flex-1 ${inputBase} py-1.5 text-[13px]`} />
            <button className={btnSmall} type="submit">+</button>
          </form>
        </div>

        <div>
          <h4 className={sectionTitle}>Miembros</h4>
          <div className="flex flex-wrap items-center gap-2">
            {detail.members.map((m) => (
              <span key={m.id} className={chip}>
                @{m.username}
                <button className={chipRemove} onClick={() => removeMember(m.id)}>✕</button>
              </span>
            ))}
            {pickingMember ? (
              <select className={selectBase} autoFocus defaultValue=""
                onChange={(e) => e.target.value && addMember(Number(e.target.value))}
                onBlur={() => setPickingMember(false)}>
                <option value="" disabled>Elegir usuario…</option>
                {allUsers.map((u) => <option key={u.id} value={u.id}>@{u.username}</option>)}
              </select>
            ) : (
              <button className={chipAdd} onClick={startPickingMember}>+ Asignar miembro</button>
            )}
          </div>
        </div>

        <div>
          <h4 className={sectionTitle}>Notas vinculadas</h4>
          <div className="flex flex-wrap items-center gap-2">
            {detail.linkedNotes.map((n) => (
              <span key={`${n.link_id}-${n.id}`} className={chip} onClick={() => { onClose(); navigate(`/notes/${n.id}`); }}>
                <span className="text-note">◆</span>{n.title}
                {n.kind === 'manual' && (
                  <button className={chipRemove} onClick={(e) => { e.stopPropagation(); unlinkNote(n.link_id); }}>✕</button>
                )}
              </span>
            ))}
            {pickingNote ? (
              <select className={selectBase} autoFocus defaultValue=""
                onChange={(e) => e.target.value && linkNote(Number(e.target.value))}
                onBlur={() => setPickingNote(false)}>
                <option value="" disabled>Elegir nota…</option>
                {allNotes.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
              </select>
            ) : (
              <button className={chipAdd} onClick={startPickingNote}>+ Vincular nota</button>
            )}
          </div>
        </div>

        <div>
          <h4 className={sectionTitle}>Conversación</h4>
          {detail.discussion ? (
            <span className={chip} onClick={() => { onClose(); navigate(`/chat/${detail.discussion!.id}`); }}>
              <span className="text-chat">#</span>{detail.discussion.name}
            </span>
          ) : (
            <button className={chipAdd} onClick={openDiscussion}>＃ Abrir canal de discusión</button>
          )}
        </div>

        {detail.mentions.length > 0 && (
          <div>
            <h4 className={sectionTitle}>Mencionada en</h4>
            <div className="flex flex-wrap items-center gap-2">
              {detail.mentions.map((m, i) => (
                <span key={i} className={chip} onClick={() => {
                  onClose();
                  if (m.source_type === 'message' && m.channel_id) navigate(`/chat/${m.channel_id}`);
                  else if (m.source_type === 'note') navigate(`/notes/${m.source_id}`);
                }}>
                  <span className={m.source_type === 'message' ? 'text-chat' : 'text-note'}>
                    {m.source_type === 'message' ? '💬' : '◆'}
                  </span>
                  {(m.label ?? '').slice(0, 60) || '(sin contenido)'}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between">
          <button className={btnDanger} onClick={removeCard}>Eliminar tarjeta</button>
          <button className={btnSmall} onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
