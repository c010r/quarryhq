import { useCallback, useEffect, useState } from 'react';
import { get, post, del, onWsEvent, notifyPlanBlock } from '../api';
import type { Board, Card, List } from '../types';
import { LABEL_COLORS } from '../types';
import CardModal from './CardModal';
import TableView from './TableView';
import CalendarView from './CalendarView';
import AutomationModal from './AutomationModal';
import ShareModal from './ShareModal';
import { avatarColor, btnGhost, btnSmall, emptyState, headerBtn, mainHeader, viewTitle } from '../ui';
import { confirmDialog } from '../dialog';

function CardBadges({ card }: { card: Card }) {
  const members = (card.member_names ?? '').split(',').filter(Boolean);
  const hasChecklist = (card.checklist_total ?? 0) > 0;
  const today = new Date().toISOString().slice(0, 10);
  const badgeBase = 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px]';
  const dueClass = card.completed ? `${badgeBase} bg-ok/15 text-ok`
    : card.due_date && card.due_date < today ? `${badgeBase} bg-danger/15 text-danger`
    : card.due_date === today ? `${badgeBase} bg-board/15 text-board`
    : `${badgeBase} bg-ink text-dim`;
  if (!card.due_date && !hasChecklist && members.length === 0 && !card.completed) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {card.completed ? <span className={`${badgeBase} bg-ok/15 text-ok`}>✓ Hecha</span> : null}
      {card.due_date && <span className={dueClass}>🕓 {card.due_date}</span>}
      {hasChecklist && (
        <span className={`${badgeBase} bg-ink ${card.checklist_done === card.checklist_total ? 'text-ok' : 'text-dim'}`}>
          ☑ {card.checklist_done}/{card.checklist_total}
        </span>
      )}
      {members.length > 0 && (
        <span className="ml-auto flex">
          {members.slice(0, 3).map((m, i) => (
            <span key={m} title={m}
              className={`flex h-5 w-5 items-center justify-center rounded-full border-2 border-raised text-[10px] font-bold text-ink ${i > 0 ? '-ml-1.5' : ''}`}
              style={{ background: avatarColor(m) }}>
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
    <form className="flex flex-col gap-1.5 px-2.5 pb-2.5 pt-1" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim()); }}>
      <input autoFocus placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        className="rounded-lg border border-accent bg-ink px-2.5 py-2 text-[13px] outline-none" />
      <div className="flex gap-1.5">
        <button className={btnSmall} type="submit">Añadir</button>
        <button className="px-2 py-1.5 text-[13px] text-dim hover:text-fg" type="button" onClick={onCancel}>Cancelar</button>
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
    <div
      className={`rounded transition-all duration-100 ${over ? 'h-10 border border-dashed border-board bg-board/10' : '-my-1 h-1'}`}
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
      onDragLeave={onDragLeave}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
    />
  );
}

export default function BoardView({ boardId, initialCardId, isPremium, currentUserId }: {
  boardId: number;
  initialCardId?: number;
  isPremium: boolean;
  currentUserId: number;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [lists, setLists] = useState<List[]>([]);
  const [addingCardTo, setAddingCardTo] = useState<number | null>(null);
  const [addingList, setAddingList] = useState(false);
  const [openCardId, setOpenCardId] = useState<number | null>(null);
  const [dragging, setDragging] = useState<Card | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [view, setView] = useState<'kanban' | 'table' | 'calendar'>('kanban');
  const [showRules, setShowRules] = useState(false);
  const [showShare, setShowShare] = useState(false);

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
    if (!await confirmDialog(`¿Eliminar la lista "${list.name}" y sus ${list.cards.length} tarjetas?`, { danger: true, confirmText: 'Eliminar' })) return;
    await del(`/api/lists/${list.id}`);
    load();
  }

  if (!board) return <div className={emptyState}>Tablero no encontrado.</div>;

  const viewTab = (active: boolean) =>
    `px-3 py-1.5 text-xs transition-colors ${active ? 'bg-board/10 font-semibold text-board' : 'text-dim hover:text-fg'}`;

  return (
    <>
      <div className={mainHeader}>
        <h2 className={viewTitle + " truncate"}><span className="text-board">▦</span> {board.name}</h2>
        <span className="text-[13px] text-dim">{lists.reduce((n, l) => n + l.cards.length, 0)} tarjetas</span>
        <div className="flex max-w-full overflow-x-auto rounded-lg border border-edge bg-panel sm:ml-auto">
          <button className={viewTab(view === 'kanban')} onClick={() => setView('kanban')}>▦ Tablero</button>
          <button className={viewTab(view === 'table')}
            onClick={() => isPremium ? setView('table') : notifyPlanBlock('Las vistas Tabla y Calendario son parte de Premium.')}>
            ☰ Tabla{!isPremium && ' 🔒'}
          </button>
          <button className={viewTab(view === 'calendar')}
            onClick={() => isPremium ? setView('calendar') : notifyPlanBlock('Las vistas Tabla y Calendario son parte de Premium.')}>
            📅 Calendario{!isPremium && ' 🔒'}
          </button>
        </div>
        <button className={headerBtn}
          onClick={() => isPremium ? setShowRules(true) : notifyPlanBlock('Las automatizaciones estilo Butler son parte de Premium.')}>
          ⚙ Automatización{!isPremium && ' 🔒'}
        </button>
        <button className={headerBtn} onClick={() => setShowShare(true)}>🤝 Compartir</button>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {view === 'table' && <TableView lists={lists} onOpenCard={setOpenCardId} onChanged={load} />}
        {view === 'calendar' && <CalendarView lists={lists} onOpenCard={setOpenCardId} />}
        {view === 'kanban' && <div className="flex min-h-full items-start gap-3 p-3 sm:gap-3.5 sm:p-4.5">
          {lists.map((list) => (
            <div key={list.id}
              className="flex max-h-[calc(100dvh-120px)] w-[min(17.5rem,calc(100dvw-2rem))] shrink-0 flex-col rounded-xl border border-edge bg-panel md:max-h-[calc(100dvh-110px)]"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging && dropTarget === null) moveCard(dragging, list.id, list.cards.length);
                setDragging(null); setDropTarget(null);
              }}>
              <div className="flex items-center justify-between px-3.5 py-3 text-[13.5px] font-semibold">
                <span>{list.name} <span className="font-normal text-dim">· {list.cards.length}</span></span>
                <button className={btnGhost} onClick={() => removeList(list)} title="Eliminar lista">✕</button>
              </div>
              <div className="flex min-h-8 flex-col gap-2 overflow-y-auto px-2.5 pb-2.5 pt-1">
                {list.cards.map((card, i) => {
                  const labels: string[] = JSON.parse(card.labels || '[]');
                  const zoneKey = `${list.id}:${i}`;
                  return (
                    <div key={card.id}>
                      <DropZone active={!!dragging && dragging.id !== card.id} over={dropTarget === zoneKey}
                        onDragOver={() => setDropTarget(zoneKey)}
                        onDragLeave={() => setDropTarget(null)}
                        onDrop={() => { if (dragging) moveCard(dragging, list.id, i); setDragging(null); setDropTarget(null); }} />
                      <div
                        className={`cursor-grab rounded-lg border border-edge bg-raised px-3 py-2.5 transition-colors hover:border-board ${dragging?.id === card.id ? 'opacity-40' : ''}`}
                        draggable
                        onDragStart={() => setDragging(card)}
                        onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                        onClick={() => setOpenCardId(card.id)}>
                        {labels.length > 0 && (
                          <div className="mb-1.5 flex gap-1">
                            {labels.map((l) => <span key={l} className="h-1.5 w-7 rounded-full" style={{ background: LABEL_COLORS[l] ?? '#666' }} />)}
                          </div>
                        )}
                        <div className={card.completed ? 'text-dim line-through' : ''}>
                          {card.title}
                        </div>
                        {card.description && <div className="mt-1.5 flex gap-2.5 text-xs text-dim"><span>≡ descripción</span></div>}
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
                <button className="px-3.5 pb-3 pt-2 text-left text-[13px] text-dim transition-colors hover:text-fg"
                  onClick={() => setAddingCardTo(list.id)}>+ Añadir tarjeta</button>
              )}
            </div>
          ))}
          {addingList ? (
            <div className="w-[min(17.5rem,calc(100dvw-2rem))] shrink-0 rounded-xl border border-edge bg-panel pt-2">
              <AddForm placeholder="Nombre de la lista…" onSubmit={addList} onCancel={() => setAddingList(false)} />
            </div>
          ) : (
            <button
              className="w-[min(17.5rem,calc(100dvw-2rem))] shrink-0 rounded-xl border border-dashed border-edge bg-panel/70 p-3.5 text-left text-[13px] text-dim transition-colors hover:border-board hover:text-fg"
              onClick={() => setAddingList(true)}>+ Añadir lista</button>
          )}
        </div>}
      </div>
      {openCardId !== null && (
        <CardModal cardId={openCardId} onClose={() => { setOpenCardId(null); load(); }} />
      )}
      {showRules && <AutomationModal boardId={boardId} lists={lists} onClose={() => setShowRules(false)} />}
      {showShare && (
        <ShareModal type="board" resourceId={boardId} resourceName={board.name} currentUserId={currentUserId} onClose={() => setShowShare(false)} />
      )}
    </>
  );
}
