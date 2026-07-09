import { useCallback, useEffect, useState } from 'react';
import { get, post, patch, del } from '../api';
import type { Backlink, Card, Channel, ChecklistItem, LinkedNote, NoteMeta, User } from '../types';
import { LABEL_COLORS } from '../types';
import { navigate } from '../App';

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
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title-row">
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== detail.card.title && save({ title })} />
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="subtitle" style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: -10 }}>
          en la lista <strong>{detail.card.list_name}</strong>
        </div>

        <div className="modal-section">
          <h4>Estado y vencimiento</h4>
          <div className="chip-row">
            <label className="chip" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={!!detail.card.completed}
                onChange={(e) => save({ completed: e.target.checked })}
                style={{ accentColor: 'var(--green)' }} />
              Completada
            </label>
            <input type="date" value={detail.card.due_date ?? ''}
              onChange={(e) => save({ due_date: e.target.value || null })}
              style={{
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7,
                padding: '5px 10px', fontSize: 13, outline: 'none', colorScheme: 'dark',
              }} />
            {detail.card.due_date && (
              <button className="btn-ghost" onClick={() => save({ due_date: null })}>Quitar fecha</button>
            )}
          </div>
        </div>

        <div className="modal-section">
          <h4>Etiquetas</h4>
          <div className="label-picker">
            {Object.entries(LABEL_COLORS).map(([name, color]) => (
              <button key={name} title={name}
                className={`label-swatch ${labels.includes(name) ? 'selected' : ''}`}
                style={{ background: color }}
                onClick={() => toggleLabel(name)} />
            ))}
          </div>
        </div>

        <div className="modal-section">
          <h4>Descripción <span style={{ textTransform: 'none', letterSpacing: 0 }}>(admite [[wiki-links]] a notas)</span></h4>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)}
            onBlur={() => description !== detail.card.description && save({ description })}
            placeholder="Añade una descripción…" />
        </div>

        <div className="modal-section">
          <h4>Checklist {detail.checklist.length > 0 && `(${detail.checklist.filter((i) => i.done).length}/${detail.checklist.length})`}</h4>
          {detail.checklist.length > 0 && (
            <div className="checklist-progress">
              <div className="fill" style={{ width: `${(detail.checklist.filter((i) => i.done).length / detail.checklist.length) * 100}%` }} />
            </div>
          )}
          {detail.checklist.map((item) => (
            <div key={item.id} className="checklist-item">
              <input type="checkbox" checked={!!item.done} onChange={() => toggleItem(item)} />
              <span className={`text ${item.done ? 'done' : ''}`}>{item.text}</span>
              <button className="remove" onClick={() => removeItem(item)}>✕</button>
            </div>
          ))}
          <form className="checklist-add" onSubmit={addChecklistItem}>
            <input placeholder="Añadir elemento…" value={newItem} onChange={(e) => setNewItem(e.target.value)} />
            <button className="btn-small" type="submit">+</button>
          </form>
        </div>

        <div className="modal-section">
          <h4>Miembros</h4>
          <div className="chip-row">
            {detail.members.map((m) => (
              <span key={m.id} className="chip">
                @{m.username}
                <button className="remove" onClick={() => removeMember(m.id)}>✕</button>
              </span>
            ))}
            {pickingMember ? (
              <select className="note-select" autoFocus defaultValue=""
                onChange={(e) => e.target.value && addMember(Number(e.target.value))}
                onBlur={() => setPickingMember(false)}>
                <option value="" disabled>Elegir usuario…</option>
                {allUsers.map((u) => <option key={u.id} value={u.id}>@{u.username}</option>)}
              </select>
            ) : (
              <button className="chip chip-add" onClick={startPickingMember}>+ Asignar miembro</button>
            )}
          </div>
        </div>

        <div className="modal-section">
          <h4>Notas vinculadas</h4>
          <div className="chip-row">
            {detail.linkedNotes.map((n) => (
              <span key={`${n.link_id}-${n.id}`} className="chip" onClick={() => { onClose(); navigate(`/notes/${n.id}`); }}>
                <span className="icon">◆</span>{n.title}
                {n.kind === 'manual' && (
                  <button className="remove" onClick={(e) => { e.stopPropagation(); unlinkNote(n.link_id); }}>✕</button>
                )}
              </span>
            ))}
            {pickingNote ? (
              <select className="note-select" autoFocus defaultValue=""
                onChange={(e) => e.target.value && linkNote(Number(e.target.value))}
                onBlur={() => setPickingNote(false)}>
                <option value="" disabled>Elegir nota…</option>
                {allNotes.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
              </select>
            ) : (
              <button className="chip chip-add" onClick={startPickingNote}>+ Vincular nota</button>
            )}
          </div>
        </div>

        <div className="modal-section">
          <h4>Conversación</h4>
          {detail.discussion ? (
            <span className="chip" onClick={() => { onClose(); navigate(`/chat/${detail.discussion!.id}`); }}>
              <span className="icon">#</span>{detail.discussion.name}
            </span>
          ) : (
            <button className="chip chip-add" onClick={openDiscussion}>＃ Abrir canal de discusión</button>
          )}
        </div>

        {detail.mentions.length > 0 && (
          <div className="modal-section">
            <h4>Mencionada en</h4>
            <div className="chip-row">
              {detail.mentions.map((m, i) => (
                <span key={i} className="chip" onClick={() => {
                  onClose();
                  if (m.source_type === 'message' && m.channel_id) navigate(`/chat/${m.channel_id}`);
                  else if (m.source_type === 'note') navigate(`/notes/${m.source_id}`);
                }}>
                  <span className="icon">{m.source_type === 'message' ? '💬' : '◆'}</span>
                  {(m.label ?? '').slice(0, 60) || '(sin contenido)'}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="modal-footer">
          <button className="btn-danger" onClick={removeCard}>Eliminar tarjeta</button>
          <button className="btn-small" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
