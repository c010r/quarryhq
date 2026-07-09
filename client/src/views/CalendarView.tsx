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

  return (
    <div className="calendar-view">
      <div className="calendar-nav">
        <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>←</button>
        <h3>{monthLabel}</h3>
        <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>→</button>
        <button onClick={() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Hoy</button>
        <span className="subtitle" style={{ color: 'var(--text-dim)', fontSize: 12.5 }}>
          Las tarjetas aparecen en su fecha de vencimiento
        </span>
      </div>
      <div className="calendar-grid">
        {DOW.map((d) => <div key={d} className="calendar-dow">{d}</div>)}
        {days.map((day) => {
          const key = toKey(day);
          const cards = cardsByDay.get(key) ?? [];
          const otherMonth = day.getMonth() !== cursor.getMonth();
          return (
            <div key={key} className={`calendar-day ${otherMonth ? 'other-month' : ''} ${key === todayKey ? 'today' : ''}`}>
              <span className="day-num">{day.getDate()}</span>
              {cards.map((c) => (
                <button key={c.id} className={`calendar-card ${c.completed ? 'completed' : ''}`}
                  onClick={() => onOpenCard(c.id)} title={c.title}>
                  {c.title}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
