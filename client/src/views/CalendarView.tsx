import { useMemo, useState } from 'react';
import type { List } from '../types';

const DOW = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function toKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function CalendarView({ lists, onOpenCard }: {
  lists: List[];
  onOpenCard: (id: number) => void;
}) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });

  const cardsByDay = useMemo(() => {
    const map = new Map<string, { id: number; title: string; completed: number }[]>();
    for (const list of lists) {
      for (const card of list.cards) {
        if (!card.due_date) continue;
        const key = card.due_date.slice(0, 10);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ id: card.id, title: card.title, completed: card.completed });
      }
    }
    return map;
  }, [lists]);

  // Cuadrícula de 6 semanas empezando en lunes
  const days = useMemo(() => {
    const first = new Date(cursor);
    const offset = (first.getDay() + 6) % 7; // lunes = 0
    const start = new Date(first);
    start.setDate(first.getDate() - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [cursor]);

  const todayKey = toKey(new Date());
  const monthLabel = cursor.toLocaleDateString('es', { month: 'long', year: 'numeric' });
  const totalThisMonth = useMemo(() => {
    const monthKey = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    let total = 0;
    for (const [k, v] of cardsByDay) if (k.startsWith(monthKey)) total += v.length;
    return total;
  }, [cardsByDay, cursor]);
  const navBtn = 'rounded-lg border border-edge bg-panel px-3 py-1 text-dim transition-colors hover:border-board hover:text-fg active:scale-[0.97]';

  return (
    <div className="min-w-0 p-3 sm:p-5">
      <div className="mb-3.5 flex flex-wrap items-center gap-2 sm:gap-3.5">
        <button className={navBtn} aria-label="Mes anterior" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>←</button>
        <h3 className="font-display text-[15px] font-bold capitalize" aria-live="polite">{monthLabel}</h3>
        <button className={navBtn} aria-label="Mes siguiente" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>→</button>
        <button className={navBtn} aria-label="Ir al mes actual" onClick={() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Hoy</button>
        <span className="basis-full text-xs text-dim sm:basis-auto">Las tarjetas aparecen en su fecha de vencimiento</span>
      </div>
      {totalThisMonth === 0 && (
        <p className="mb-3 rounded-lg border border-edge bg-panel px-3.5 py-2 text-[12.5px] text-dim" role="status">
          Sin tarjetas con vencimiento este mes.
        </p>
      )}
      <div className="overflow-x-auto"><div className="grid min-w-[640px] grid-cols-7 gap-1.5" role="grid" aria-label={`Calendario de ${monthLabel}`}>
        {DOW.map((d) => (
          <div key={d} className="p-1 text-center text-[11px] uppercase tracking-wider text-dim" role="columnheader">{d}</div>
        ))}
        {days.map((day) => {
          const key = toKey(day);
          const cards = cardsByDay.get(key) ?? [];
          const otherMonth = day.getMonth() !== cursor.getMonth();
          return (
            <div key={key}
              className={`flex min-h-24 flex-col gap-1 rounded-lg border bg-panel p-1.5 ${key === todayKey ? 'border-board' : 'border-edge'} ${otherMonth ? 'opacity-55' : ''}`}
              role="gridcell" aria-label={`${day.getDate()} de ${day.toLocaleDateString('es', { month: 'long' })}${cards.length > 0 ? `, ${cards.length} tarjeta${cards.length === 1 ? '' : 's'}` : ''}`}>
              <span className={`text-[11.5px] ${key === todayKey ? 'font-bold text-board' : 'text-dim'}`}>{day.getDate()}</span>
              {cards.map((c) => (
                <button key={c.id} title={c.title}
                  aria-label={`${c.completed ? 'Completada: ' : ''}${c.title}, vence el ${key}`}
                  className={`overflow-hidden text-ellipsis whitespace-nowrap rounded border-l-3 bg-raised px-1.5 py-0.5 text-left text-[11.5px] transition-colors hover:bg-hover ${c.completed ? 'border-ok opacity-70 line-through' : 'border-board'}`}
                  onClick={() => onOpenCard(c.id)}>
                  {c.title}
                </button>
              ))}
            </div>
          );
        })}
      </div></div>
    </div>
  );
}
