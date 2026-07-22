import { useCallback, useEffect, useState } from 'react';
import { get, post, patch, del, onWsEvent } from '../api';
import type { Backlink, Card, Channel, ChecklistItem, LinkedNote, NoteMeta, User } from '../types';
import { LABEL_COLORS } from '../types';
import { navigate } from '../App';
import { btnDanger, btnGhost, btnSmall, chip, chipAdd, chipRemove, emptyInline, GLYPH, inputBase, inputSm, modalBackdrop, modalBox, modalClose, sectionTitle, selectBase, spinnerCls } from '../ui';
import { confirmDialog } from '../dialog';
import { useModalA11y } from '../useModalA11y';

interface CardDetail {
  card: Card;
  linkedNotes: LinkedNote[];
  discussion: { id: number; name: string } | null;
  mentions: Backlink[];
  checklist: ChecklistItem[];
  members: User[];
}

export default function CardModal({ cardId, isViewer, onClose }: { cardId: number; isViewer?: boolean; onClose: () => void }) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [allNotes, setAllNotes] = useState<NoteMeta[]>([]);
  const [pickingNote, setPickingNote] = useState(false);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [pickingMember, setPickingMember] = useState(false);
  const [newItem, setNewItem] = useState('');
  const [titleFocused, setTitleFocused] = useState(false);
  const [descFocused, setDescFocused] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoadError(false);
      const data = await get<CardDetail>(`/api/cards/${cardId}`);
      setDetail(data);
      // No se pisa lo que el usuario está tipeando (antes del blur que guarda)
      if (!titleFocused) setTitle(data.card.title);
      if (!descFocused) setDescription(data.card.description);
    } catch {
      setLoadError(true);
    }
  }, [cardId, titleFocused, descFocused]);

  useEffect(() => { load(); }, [load]);

  // Cambios remotos de un colaborador en el mismo tablero: se refleja al
  // instante (checklist, etiquetas, miembros, y título/descripción si no
  // estás editándolos vos en este momento).
  useEffect(() => onWsEvent((e) => {
    if (e.type === 'board:changed' && detail && e.boardId === detail.card.board_id) load();
  }), [detail?.card.board_id, load]);

  const containerRef = useModalA11y(onClose);

  if (loadError && !detail) return (
    <div ref={containerRef} className={modalBackdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={modalBox}>
        <div className={emptyInline}>
          <span className="text-2xl opacity-60">{GLYPH.board}</span>
          <p className="text-fg">No se pudo cargar la tarjeta.</p>
          <button className={btnSmall} onClick={load}>Reintentar</button>
        </div>
      </div>
    </div>
  );
  if (!detail) return (
    <div ref={containerRef} className={modalBackdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={modalBox + ' items-center'}>
        <div className={spinnerCls} aria-hidden />
        <p className="text-[13px] text-dim">Cargando tarjeta…</p>
      </div>
    </div>
  );
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
    const { users } = await get<{ users: User[] }>(`/api/boards/${detail!.card.board_id}/collaborators`);
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
    if (!await confirmDialog('¿Eliminar esta tarjeta?', { danger: true, confirmText: 'Eliminar' })) return;
    await del(`/api/cards/${cardId}`);
    onClose();
  }

  async function startPickingNote() {
    const { notes } = await get<{ notes: NoteMeta[] }>('/api/notes');
    setAllNotes(notes.filter((n) => !detail!.linkedNotes.some((ln) => ln.id === n.id)));
    setPickingNote(true);
  }

  return (
    <div ref={containerRef} className={modalBackdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={modalBox}>
        <div className="flex items-start justify-between gap-3">
          <label className="sr-only" htmlFor="card-title-input">Título de la tarjeta</label>
          <input id="card-title-input" value={title} onChange={(e) => setTitle(e.target.value)}
            onFocus={() => setTitleFocused(true)}
            onBlur={() => { setTitleFocused(false); title.trim() && title !== detail.card.title && save({ title }); }}
            readOnly={isViewer}
            className="flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 font-display text-[19px] font-bold outline-none transition-colors focus:border-accent focus:bg-ink" />
          <button className={modalClose} aria-label="Cerrar tarjeta" onClick={onClose}>✕</button>
        </div>
        <div className="-mt-2.5 flex flex-wrap items-center gap-x-2 px-2 text-[13px] text-dim">
          <span>en la lista <strong className="text-fg">{detail.card.list_name}</strong></span>
          {detail.card.updated_by_username && <span>· editado por @{detail.card.updated_by_username}</span>}
          {isViewer && <span aria-label="Solo lectura">· {GLYPH.read} solo lectura</span>}
        </div>

        <div>
          <h4 className={sectionTitle}>Estado y vencimiento</h4>
          <div className="flex flex-wrap items-center gap-2">
            <label className={`${chip} accent-ok`}>
              <input type="checkbox" checked={!!detail.card.completed} disabled={isViewer}
                onChange={(e) => save({ completed: e.target.checked })} />
              Completada
            </label>
            <input type="date" value={detail.card.due_date ?? ''} disabled={isViewer}
              aria-label="Fecha de vencimiento"
              onChange={(e) => save({ due_date: e.target.value || null })}
              className={`${inputSm} disabled:opacity-60`} />
            {detail.card.due_date && !isViewer && (
              <button className={btnGhost} onClick={() => save({ due_date: null })}>Quitar fecha</button>
            )}
          </div>
        </div>

        <div>
          <h4 className={sectionTitle}>Etiquetas</h4>
          <div className="flex flex-wrap gap-2">
            {Object.entries(LABEL_COLORS).map(([name, color]) => {
              const active = labels.includes(name);
              return (
                <button key={name} title={name} disabled={isViewer}
                  aria-pressed={active} aria-label={`${active ? 'Quitar' : 'Añadir'} etiqueta ${name}`}
                  className={`h-6 w-11 rounded-md border-2 transition-all disabled:cursor-default ${active ? 'border-fg opacity-100' : 'border-transparent opacity-55 hover:opacity-80'}`}
                  style={{ background: color }}
                  onClick={() => toggleLabel(name)} />
              );
            })}
          </div>
        </div>

        <div>
          <h4 className={sectionTitle}>Descripción <span className="normal-case tracking-normal">(admite [[wiki-links]] a notas)</span></h4>
          <label className="sr-only" htmlFor="card-description-input">Descripción</label>
          <textarea id="card-description-input" value={description} onChange={(e) => setDescription(e.target.value)}
            onFocus={() => setDescFocused(true)}
            onBlur={() => { setDescFocused(false); description !== detail.card.description && save({ description }); }}
            placeholder="Añade una descripción…"
            readOnly={isViewer}
            className="min-h-28 w-full resize-y rounded-lg border border-edge bg-ink px-3 py-2.5 leading-relaxed outline-none transition-colors focus:border-accent" />
        </div>

        <div>
          <h4 className={sectionTitle}>Checklist {detail.checklist.length > 0 && `(${detail.checklist.filter((i) => i.done).length}/${detail.checklist.length})`}</h4>
          {detail.checklist.length > 0 && (
            <div className="mb-2.5 h-1.5 overflow-hidden rounded-full bg-ink"
              role="progressbar" aria-valuemin={0} aria-valuemax={detail.checklist.length}
              aria-valuenow={detail.checklist.filter((i) => i.done).length}
              aria-label={`Checklist: ${detail.checklist.filter((i) => i.done).length} de ${detail.checklist.length} completadas`}>
              <div className="h-full rounded-full bg-ok transition-all duration-200"
                style={{ width: `${(detail.checklist.filter((i) => i.done).length / detail.checklist.length) * 100}%` }} />
            </div>
          )}
          {detail.checklist.map((item) => (
            <div key={item.id} className="group flex items-center gap-2 py-1">
              <label className="flex flex-1 items-center gap-2">
                <input type="checkbox" checked={!!item.done} disabled={isViewer} onChange={() => toggleItem(item)} className="h-4 w-4 accent-accent" />
                <span className={`flex-1 ${item.done ? 'text-dim line-through' : ''}`}>{item.text}</span>
              </label>
              {!isViewer && (
                <button className="text-dim opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus:opacity-100 focus:outline-none"
                  aria-label={`Eliminar elemento de checklist: ${item.text}`}
                  onClick={() => removeItem(item)}>✕</button>
              )}
            </div>
          ))}
          {!isViewer && (
            <form className="mt-1.5 flex gap-1.5" onSubmit={addChecklistItem}>
              <label className="sr-only" htmlFor="card-checklist-input">Nuevo elemento de checklist</label>
              <input id="card-checklist-input" placeholder="Añadir elemento…" value={newItem} onChange={(e) => setNewItem(e.target.value)}
                className={`flex-1 ${inputBase} py-1.5 text-[13px]`} />
              <button className={btnSmall} type="submit" aria-label="Añadir elemento">{GLYPH.plus}</button>
            </form>
          )}
        </div>

        <div>
          <h4 className={sectionTitle}>Miembros</h4>
          <div className="flex flex-wrap items-center gap-2">
            {detail.members.map((m) => (
              <span key={m.id} className={chip}>
                @{m.username}
                {!isViewer && <button className={chipRemove} aria-label={`Quitar a ${m.username} de la tarjeta`} onClick={() => removeMember(m.id)}>✕</button>}
              </span>
            ))}
            {!isViewer && (pickingMember ? (
              <select className={selectBase} autoFocus defaultValue="" aria-label="Elegir usuario miembro"
                onChange={(e) => e.target.value && addMember(Number(e.target.value))}
                onBlur={() => setPickingMember(false)}>
                <option value="" disabled>Elegir usuario…</option>
                {allUsers.map((u) => <option key={u.id} value={u.id}>@{u.username}</option>)}
              </select>
            ) : (
              <button className={chipAdd} onClick={startPickingMember}>+ Asignar miembro</button>
            ))}
          </div>
        </div>

        <div>
          <h4 className={sectionTitle}>Notas vinculadas</h4>
          <div className="flex flex-wrap items-center gap-2">
            {detail.linkedNotes.map((n) => (
              <span key={`${n.link_id}-${n.id}`} className={chip} role="button" tabIndex={0}
                aria-label={`Abrir nota ${n.title}`}
                onClick={() => { onClose(); navigate(`/notes/${n.id}`); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClose(); navigate(`/notes/${n.id}`); } }}>
                <span className="text-note">{GLYPH.note}</span>{n.title}
                {n.kind === 'manual' && !isViewer && (
                  <button className={chipRemove} aria-label={`Desvincular nota ${n.title}`}
                    onClick={(e) => { e.stopPropagation(); unlinkNote(n.link_id); }}>✕</button>
                )}
              </span>
            ))}
            {!isViewer && (pickingNote ? (
              <select className={selectBase} autoFocus defaultValue="" aria-label="Elegir nota para vincular"
                onChange={(e) => e.target.value && linkNote(Number(e.target.value))}
                onBlur={() => setPickingNote(false)}>
                <option value="" disabled>Elegir nota…</option>
                {allNotes.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
              </select>
            ) : (
              <button className={chipAdd} onClick={startPickingNote}>+ Vincular nota</button>
            ))}
          </div>
        </div>

        <div>
          <h4 className={sectionTitle}>Conversación</h4>
          {detail.discussion ? (
            <span className={chip} role="button" tabIndex={0}
              aria-label={`Abrir canal de discusión ${detail.discussion.name}`}
              onClick={() => { onClose(); navigate(`/chat/${detail.discussion!.id}`); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClose(); navigate(`/chat/${detail.discussion!.id}`); } }}>
              <span className="text-chat">{GLYPH.channel}</span>{detail.discussion.name}
            </span>
          ) : !isViewer ? (
            <button className={chipAdd} onClick={openDiscussion}>{GLYPH.channel} Abrir canal de discusión</button>
          ) : (
            <div className={emptyInline + ' py-4'}>
              <span className="text-2xl opacity-60">{GLYPH.channel}</span>
              <p>Sin discusión todavía.</p>
            </div>
          )}
        </div>

        {detail.mentions.length > 0 && (
          <div>
            <h4 className={sectionTitle}>Mencionada en</h4>
            <div className="flex flex-wrap items-center gap-2">
              <div className="sr-only">Mencionada en {detail.mentions.length} lugares.</div>
              {detail.mentions.map((m, i) => (
                <span key={i} className={chip} role="button" tabIndex={0}
                  aria-label={`Abrir ${m.source_type === 'message' ? 'canal' : 'nota'}: ${(m.label ?? '').slice(0, 60) || 'sin contenido'}`}
                  onClick={() => {
                    onClose();
                    if (m.source_type === 'message' && m.channel_id) navigate(`/chat/${m.channel_id}`);
                    else if (m.source_type === 'note') navigate(`/notes/${m.source_id}`);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    onClose();
                    if (m.source_type === 'message' && m.channel_id) navigate(`/chat/${m.channel_id}`);
                    else if (m.source_type === 'note') navigate(`/notes/${m.source_id}`);
                  }}>
                  <span className={m.source_type === 'message' ? 'text-chat' : 'text-note'}>
                    {m.source_type === 'message' ? GLYPH.message : GLYPH.note}
                  </span>
                  {(m.label ?? '').slice(0, 60) || '(sin contenido)'}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between">
          {!isViewer ? <button className={btnDanger} onClick={removeCard}>Eliminar tarjeta</button> : <span />}
          <button className={btnSmall} onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
