import { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '../api';
import type { BoardRule, List } from '../types';
import { LABEL_COLORS } from '../types';

const ACTION_LABELS: Record<string, string> = {
  complete: 'marcarla como completada',
  uncomplete: 'quitar el estado completada',
  label: 'añadir la etiqueta',
  due_today: 'fijar vencimiento hoy',
  clear_due: 'quitar el vencimiento',
};

export default function AutomationModal({ boardId, lists, onClose }: {
  boardId: number;
  lists: List[];
  onClose: () => void;
}) {
  const [rules, setRules] = useState<BoardRule[]>([]);
  const [listId, setListId] = useState<number>(lists[0]?.id ?? 0);
  const [action, setAction] = useState('complete');
  const [param, setParam] = useState('violeta');

  const load = useCallback(async () => {
    const data = await get<{ rules: BoardRule[] }>(`/api/boards/${boardId}/rules`);
    setRules(data.rules);
  }, [boardId]);

  useEffect(() => { load(); }, [load]);

  async function addRule() {
    if (!listId) return;
    await post(`/api/boards/${boardId}/rules`, { list_id: listId, action, param: action === 'label' ? param : '' });
    load();
  }

  async function removeRule(id: number) {
    await del(`/api/rules/${id}`);
    load();
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 560 }}>
        <div className="modal-title-row">
          <h3 style={{ fontSize: 18, padding: '4px 8px' }}>⚙ Automatizaciones del tablero</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: -8 }}>
          Reglas estilo Butler: cuando una tarjeta se mueva a una lista, se aplica la acción automáticamente.
        </p>

        <div className="modal-section">
          <h4>Reglas activas</h4>
          {rules.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>Sin reglas todavía.</p>}
          {rules.map((rule) => (
            <div key={rule.id} className="rule-row">
              <span>
                Cuando una tarjeta llegue a <strong>{rule.list_name}</strong> → {ACTION_LABELS[rule.action] ?? rule.action}
                {rule.action === 'label' && (
                  <span className="label-pill" style={{
                    display: 'inline-block', width: 24, height: 8, borderRadius: 3,
                    background: LABEL_COLORS[rule.param] ?? '#666', marginLeft: 6,
                  }} />
                )}
              </span>
              <button className="remove" onClick={() => removeRule(rule.id)}>✕</button>
            </div>
          ))}
        </div>

        <div className="modal-section">
          <h4>Nueva regla</h4>
          <div className="rule-form">
            <span>Cuando llegue a</span>
            <select value={listId} onChange={(e) => setListId(Number(e.target.value))}>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <span>→</span>
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              {Object.entries(ACTION_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            {action === 'label' && (
              <select value={param} onChange={(e) => setParam(e.target.value)}>
                {Object.keys(LABEL_COLORS).map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            )}
            <button className="btn-small" onClick={addRule}>Añadir</button>
          </div>
        </div>
      </div>
    </div>
  );
}
