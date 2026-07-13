import { useMemo, useState } from 'react';
import type { Card, List } from '../types';
import { LABEL_COLORS } from '../types';
import { patch } from '../api';
import { emptyState } from '../ui';

type SortKey = 'title' | 'list' | 'due_date' | 'completed';

export default function TableView({ lists, onOpenCard, onChanged, isViewer }: {
  lists: List[];
  onOpenCard: (id: number) => void;
  onChanged: () => void;
  isViewer?: boolean;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('list');
  const [asc, setAsc] = useState(true);

  const rows = useMemo(() => {
    const flat = lists.flatMap((l) => l.cards.map((c) => ({ ...c, list_name: l.name })));
    const dir = asc ? 1 : -1;
    return flat.sort((a, b) => {
      if (sortKey === 'title') return a.title.localeCompare(b.title) * dir;
      if (sortKey === 'list') return (a.list_name ?? '').localeCompare(b.list_name ?? '') * dir;
      if (sortKey === 'completed') return (a.completed - b.completed) * dir;
      return ((a.due_date ?? '9999') > (b.due_date ?? '9999') ? 1 : -1) * dir;
    });
  }, [lists, sortKey, asc]);

  function sortBy(key: SortKey) {
    if (key === sortKey) setAsc(!asc);
    else { setSortKey(key); setAsc(true); }
  }

  async function toggleCompleted(card: Card, e: React.MouseEvent) {
    e.stopPropagation();
    if (isViewer) return;
    await patch(`/api/cards/${card.id}`, { completed: !card.completed });
    onChanged();
  }

  const arrow = (key: SortKey) => sortKey === key ? (asc ? ' ↑' : ' ↓') : '';
  const th = 'cursor-pointer select-none border-b border-edge px-3 py-2.5 text-left text-[11.5px] font-semibold uppercase tracking-wider text-dim transition-colors hover:text-fg';
  const td = 'border-b border-edge px-3 py-2.5 text-[13.5px]';

  return (
    <div className="min-w-0 p-3 sm:p-5">
      <div className="overflow-x-auto"><table className="min-w-[760px] w-full border-collapse">
        <thead>
          <tr>
            <th className={th} onClick={() => sortBy('completed')}>✓{arrow('completed')}</th>
            <th className={th} onClick={() => sortBy('title')}>Tarjeta{arrow('title')}</th>
            <th className={th} onClick={() => sortBy('list')}>Lista{arrow('list')}</th>
            <th className={`${th} cursor-default`}>Etiquetas</th>
            <th className={th} onClick={() => sortBy('due_date')}>Vencimiento{arrow('due_date')}</th>
            <th className={`${th} cursor-default`}>Miembros</th>
            <th className={`${th} cursor-default`}>Checklist</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((card) => {
            const labels: string[] = JSON.parse(card.labels || '[]');
            return (
              <tr key={card.id} onClick={() => onOpenCard(card.id)} className="cursor-pointer transition-colors hover:bg-panel">
                <td className={td} onClick={(e) => toggleCompleted(card, e)}>
                  <input type="checkbox" checked={!!card.completed} readOnly className="accent-ok" />
                </td>
                <td className={`${td} ${card.completed ? 'text-dim line-through' : ''}`}>
                  {card.title}
                </td>
                <td className={`${td} text-dim`}>{card.list_name}</td>
                <td className={td}>{labels.map((l) => (
                  <span key={l} className="mr-1 inline-block h-1.5 w-6 rounded-full" style={{ background: LABEL_COLORS[l] ?? '#666' }} />
                ))}</td>
                <td className={`${td} text-dim`}>{card.due_date ?? '—'}</td>
                <td className={`${td} text-dim`}>{card.member_names ?? '—'}</td>
                <td className={`${td} text-dim`}>
                  {card.checklist_total ? `${card.checklist_done}/${card.checklist_total}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      {rows.length === 0 && <div className={`${emptyState} h-48`}>No hay tarjetas en este tablero.</div>}
    </div>
  );
}
