import { useCallback, useEffect, useState } from 'react';
import { get, post, del, onWsEvent } from '../api';
import type { Board, Card, List } from '../types';
import { LABEL_COLORS } from '../types';
import CardModal from './CardModal';
import TableView from './TableView';
import CalendarView from './CalendarView';
import AutomationModal from './AutomationModal';

const AVATAR_COLORS = ['#8b5cf6', '#3b82f6', '#22c55e', '#f97316', '#ec4899', '#14b8a6'];
function avatarColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function CardBadges({ card }: { card: Card }) {
  const members = (card.member_names ?? '').split(',').filter(Boolean);
  const hasChecklist = (card.checklist_total ?? 0) > 0;
  const today = new Date().toISOString().slice(0, 10);
  const dueClass = card.completed ? 'done' : card.due_date && card.due_date < today ? 'overdue'
    : card.due_date === today ? 'due-soon' : '';
  if (!card.due_date && !hasChecklist && members.length === 0 && !card.completed) return null;
  return (
    <div className="card-badges">
      {card.completed ? <span className="badge done">✓ Hecha</span> : null}
      {card.due_date && <span className={`badge ${dueClass}`}>🕓 {card.due_date}</span>}
      {hasChecklist && (
        <span className={`badge ${card.checklist_done === card.checklist_total ? 'checklist-done' : ''}`}>
          ☑ {card.checklist_done}/{card.checklist_total}
        </span>
      )}
      {members.length > 0 && (
        <span className="member-avatars">
          {members.slice(0, 3).map((m) => (
            <span key={m} className="mini-avatar" style={{ background: avatarColor(m) }} title={m}>
              {m.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function AddForm({ placeholder, onSubmit, onCancel }: {
  placeholder: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  return (
    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim()); }}>
      <input autoFocus placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()} />
      <div className="row">
        <button className="btn-small" type="submit">Añadir</button>
        <button className="btn-cancel" type="button" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}

function DropZone({ active, over, onDrop, onDragOver, onDragLeave }: {
  active: boolean; over: boolean;
  onDrop: () => void; onDragOver: () => void; onDragLeave: () => void;
}) {
  if (!active) return null;
  return (
    <div className={`drop-zone ${over ? 'over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
      onDragLeave={onDragLeave}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
    />
  );
}

export default function BoardView({ boardId, initialCardId }: { boardId: number; initialCardId?: number }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [lists, setLists] = useState<List[]>([]);
  const [addingCardTo, setAddingCardTo] = useState<number | null>(null);
  const [addingList, setAddingList] = useState(false);
  const [openCardId, setOpenCardId] = useState<number | null>(null);
  const [dragging, setDragging] = useState<Card | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [view, setView] = useState<'kanban' | 'table' | 'calendar'>('kanban');
  const [showRules, setShowRules] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await get<{ board: Board; lists: List[] }>(`/api/boards/${boardId}`);
      setBoard(data.board);
      setLists(data.lists);
    } catch { setBoard(null); }
  }, [boardId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (initialCardId) setOpenCardId(initialCardId); }, [initialCardId]);
  useEffect(() => onWsEvent((e) => {
    if ((e.type === 'board:changed' && e.boardId === boardId) || e.type === 'links:changed') load();
  }), [boardId, load]);

  async function addCard(listId: number, title: string) {
    await post('/api/cards', { list_id: listId, title });
    setAddingCardTo(null);
    load();
  }

  async function addList(name: string) {
    await post('/api/lists', { board_id: boardId, name });
    setAddingList(false);
    load();
  }

  async function moveCard(card: Card, listId: number, index: number) {
    await post(`/api/cards/${card.id}/move`, { list_id: listId, index });
    load();
  }

  async function removeList(list: List) {
    if (!confirm(`¿Eliminar la lista "${list.name}" y sus ${list.cards.length} tarjetas?`)) return;
    await del(`/api/lists/${list.id}`);
    load();
  }

  if (!board) return <div className="empty-state">Tablero no encontrado.</div>;

  return (
    <>
      <div className="main-header">
        <h2>▦ {board.name}</h2>
        <span className="subtitle">{lists.reduce((n, l) => n + l.cards.length, 0)} tarjetas</span>
        <div className="view-switcher">
          <button className={view === 'kanban' ? 'active' : ''} onClick={() => setView('kanban')}>▦ Tablero</button>
          <button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>☰ Tabla</button>
          <button className={view === 'calendar' ? 'active' : ''} onClick={() => setView('calendar')}>📅 Calendario</button>
        </div>
        <button className="header-btn" onClick={() => setShowRules(true)}>⚙ Automatización</button>
      </div>
      <div className="main-body">
        {view === 'table' && <TableView lists={lists} onOpenCard={setOpenCardId} onChanged={load} />}
        {view === 'calendar' && <CalendarView lists={lists} onOpenCard={setOpenCardId} />}
        {view === 'kanban' && <div className="board">
          {lists.map((list) => (
            <div key={list.id} className="kanban-list"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging && dropTarget === null) moveCard(dragging, list.id, list.cards.length);
                setDragging(null); setDropTarget(null);
              }}>
              <div className="kanban-list-header">
                <span>{list.name} <span className="count">· {list.cards.length}</span></span>
                <button className="btn-ghost" onClick={() => removeList(list)} title="Eliminar lista">✕</button>
              </div>
              <div className="kanban-cards">
                {list.cards.map((card, i) => {
                  const labels: string[] = JSON.parse(card.labels || '[]');
                  const zoneKey = `${list.id}:${i}`;
                  return (
                    <div key={card.id}>
                      <DropZone active={!!dragging && dragging.id !== card.id} over={dropTarget === zoneKey}
                        onDragOver={() => setDropTarget(zoneKey)}
                        onDragLeave={() => setDropTarget(null)}
                        onDrop={() => { if (dragging) moveCard(dragging, list.id, i); setDragging(null); setDropTarget(null); }} />
                      <div className={`kanban-card ${dragging?.id === card.id ? 'dragging' : ''}`}
                        draggable
                        onDragStart={() => setDragging(card)}
                        onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                        onClick={() => setOpenCardId(card.id)}>
                        {labels.length > 0 && (
                          <div className="labels">
                            {labels.map((l) => <span key={l} className="label-pill" style={{ background: LABEL_COLORS[l] ?? '#666' }} />)}
                          </div>
                        )}
                        <div style={card.completed ? { textDecoration: 'line-through', color: 'var(--text-dim)' } : undefined}>
                          {card.title}
                        </div>
                        {card.description && <div className="card-meta"><span>≡ descripción</span></div>}
                        <CardBadges card={card} />
                      </div>
                    </div>
                  );
                })}
                <DropZone active={!!dragging} over={dropTarget === `${list.id}:end`}
                  onDragOver={() => setDropTarget(`${list.id}:end`)}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={() => { if (dragging) moveCard(dragging, list.id, list.cards.length); setDragging(null); setDropTarget(null); }} />
              </div>
              {addingCardTo === list.id ? (
                <AddForm placeholder="Título de la tarjeta…" onSubmit={(t) => addCard(list.id, t)} onCancel={() => setAddingCardTo(null)} />
              ) : (
                <button className="add-card-btn" onClick={() => setAddingCardTo(list.id)}>+ Añadir tarjeta</button>
              )}
            </div>
          ))}
          {addingList ? (
            <div className="kanban-list" style={{ width: 280 }}>
              <AddForm placeholder="Nombre de la lista…" onSubmit={addList} onCancel={() => setAddingList(false)} />
            </div>
          ) : (
            <button className="add-list-btn" onClick={() => setAddingList(true)}>+ Añadir lista</button>
          )}
        </div>}
      </div>
      {openCardId !== null && (
        <CardModal cardId={openCardId} onClose={() => { setOpenCardId(null); load(); }} />
      )}
      {showRules && <AutomationModal boardId={boardId} lists={lists} onClose={() => setShowRules(false)} />}
    </>
  );
}
