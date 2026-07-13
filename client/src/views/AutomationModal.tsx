import { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '../api';
import type { BoardRule, List } from '../types';
import { LABEL_COLORS } from '../types';
import { btnSmall, modalBackdrop, modalBox, modalClose, sectionTitle, selectBase } from '../ui';

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
    <div className={modalBackdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${modalBox} max-w-[560px]`}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="px-2 py-1 font-display text-lg font-bold">⚙ Automatizaciones del tablero</h3>
          <button className={modalClose} onClick={onClose}>✕</button>
        </div>
        <p className="-mt-2 px-2 text-[13px] text-dim">
          Reglas estilo Butler: cuando una tarjeta se mueva a una lista, se aplica la acción automáticamente.
        </p>

        <div>
          <h4 className={sectionTitle}>Reglas activas</h4>
          {rules.length === 0 && <p className="text-[13px] text-dim">Sin reglas todavía.</p>}
          {rules.map((rule) => (
            <div key={rule.id} className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-raised px-2.5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                Cuando una tarjeta llegue a <strong>{rule.list_name}</strong> → {ACTION_LABELS[rule.action] ?? rule.action}
                {rule.action === 'label' && (
                  <span className="ml-1.5 inline-block h-2 w-6 rounded-full"
                    style={{ background: LABEL_COLORS[rule.param] ?? '#666' }} />
                )}
              </span>
              <button className="ml-auto text-dim transition-colors hover:text-danger" onClick={() => removeRule(rule.id)}>✕</button>
            </div>
          ))}
        </div>

        <div>
          <h4 className={sectionTitle}>Nueva regla</h4>
          <div className="flex flex-wrap items-center gap-2">
            <span>Cuando llegue a</span>
            <select className={selectBase} value={listId} onChange={(e) => setListId(Number(e.target.value))}>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <span>→</span>
            <select className={selectBase} value={action} onChange={(e) => setAction(e.target.value)}>
              {Object.entries(ACTION_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            {action === 'label' && (
              <select className={selectBase} value={param} onChange={(e) => setParam(e.target.value)}>
                {Object.keys(LABEL_COLORS).map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            )}
            <button className={btnSmall} onClick={addRule}>Añadir</button>
          </div>
        </div>
      </div>
    </div>
  );
}
