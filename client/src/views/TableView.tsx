import { useMemo, useState } from 'react';
import type { Card, List } from '../types';
import { LABEL_COLORS } from '../types';
import { patch } from '../api';

type SortKey = 'title' | 'list' | 'due_date' | 'completed';

export default function TableView({ lists, onOpenCard, onChanged }: {
  lists: List[];
  onOpenCard: (id: number) => void;
  onChanged: () => void;
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
    await patch(`/api/cards/${card.id}`, { completed: !card.completed });
    onChanged();
  }

  const arrow = (key: SortKey) => sortKey === key ? (asc ? ' ↑' : ' ↓') : '';

  return (
    <div className="table-view">
      <table>
        <thead>
          <tr>
            <th onClick={() => sortBy('completed')}>✓{arrow('completed')}</th>
            <th onClick={() => sortBy('title')}>Tarjeta{arrow('title')}</th>
            <th onClick={() => sortBy('list')}>Lista{arrow('list')}</th>
            <th>Etiquetas</th>
            <th onClick={() => sortBy('due_date')}>Vencimiento{arrow('due_date')}</th>
            <th>Miembros</th>
            <th>Checklist</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((card) => {
            const labels: string[] = JSON.parse(card.labels || '[]');
            return (
              <tr key={card.id} onClick={() => onOpenCard(card.id)}>
                <td onClick={(e) => toggleCompleted(card, e)}>
                  <input type="checkbox" checked={!!card.completed} readOnly style={{ accentColor: 'var(--green)' }} />
                </td>
                <td style={card.completed ? { textDecoration: 'line-through', color: 'var(--text-dim)' } : undefined}>
                  {card.title}
                </td>
                <td style={{ color: 'var(--text-dim)' }}>{card.list_name}</td>
                <td>{labels.map((l) => <span key={l} className="label-pill" style={{ background: LABEL_COLORS[l] ?? '#666' }} />)}</td>
                <td style={{ color: 'var(--text-dim)' }}>{card.due_date ?? '—'}</td>
                <td style={{ color: 'var(--text-dim)' }}>{card.member_names ?? '—'}</td>
                <td style={{ color: 'var(--text-dim)' }}>
                  {card.checklist_total ? `${card.checklist_done}/${card.checklist_total}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty-state" style={{ height: 200 }}>No hay tarjetas en este tablero.</div>}
    </div>
  );
}
