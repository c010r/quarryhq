import { useEffect, useRef, useState } from 'react';
import { get, onWsEvent } from '../api';
import type { GraphEdge, GraphNode } from '../types';
import { navigate } from '../App';
import { mainHeader, viewTitle } from '../ui';

// Los nodos usan el color de su módulo: notas violeta, tarjetas ámbar, canales teal.
const NODE_COLORS: Record<string, string> = { note: '#b18cfa', card: '#e9a23b', channel: '#3ecfb2' };

interface SimNode extends GraphNode { x: number; y: number; vx: number; vy: number }

export default function GraphView() {
  const [data, setData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [positions, setPositions] = useState<SimNode[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ key: string; offsetX: number; offsetY: number } | null>(null);

  useEffect(() => {
    const load = () => get<{ nodes: GraphNode[]; edges: GraphEdge[] }>('/api/graph').then(setData);
    load();
    return onWsEvent((e) => {
      if (['links:changed', 'notes:changed', 'boards:changed', 'channels:changed', 'board:changed'].includes(e.type)) load();
    });
  }, []);

  // Simulación de fuerzas: repulsión entre nodos + atracción por aristas + centrado
  useEffect(() => {
    if (!data) return;
    const width = containerRef.current?.clientWidth ?? 900;
    const height = containerRef.current?.clientHeight ?? 600;
    const nodes: SimNode[] = data.nodes.map((n, i) => {
      const angle = (i / Math.max(data.nodes.length, 1)) * Math.PI * 2;
      return {
        ...n,
        x: width / 2 + Math.cos(angle) * 180 + (Math.random() - 0.5) * 40,
        y: height / 2 + Math.sin(angle) * 180 + (Math.random() - 0.5) * 40,
        vx: 0, vy: 0,
      };
    });
    const byKey = new Map(nodes.map((n) => [n.key, n]));

    for (let iter = 0; iter < 300; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const distSq = Math.max(dx * dx + dy * dy, 100);
          const force = 2600 / distSq;
          const dist = Math.sqrt(distSq);
          a.vx += (dx / dist) * force; a.vy += (dy / dist) * force;
          b.vx -= (dx / dist) * force; b.vy -= (dy / dist) * force;
        }
      }
      for (const edge of data.edges) {
        const a = byKey.get(edge.source), b = byKey.get(edge.target);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = (dist - 110) * 0.012;
        a.vx += (dx / dist) * force; a.vy += (dy / dist) * force;
        b.vx -= (dx / dist) * force; b.vy -= (dy / dist) * force;
      }
      for (const n of nodes) {
        n.vx += (width / 2 - n.x) * 0.004;
        n.vy += (height / 2 - n.y) * 0.004;
        n.x += n.vx * 0.5; n.y += n.vy * 0.5;
        n.vx *= 0.6; n.vy *= 0.6;
        n.x = Math.max(40, Math.min(width - 40, n.x));
        n.y = Math.max(30, Math.min(height - 30, n.y));
      }
    }
    setPositions(nodes);
  }, [data]);

  function onMouseMove(e: React.MouseEvent) {
    if (!dragRef.current) return;
    const rect = containerRef.current!.getBoundingClientRect();
    const { key, offsetX, offsetY } = dragRef.current;
    setPositions((prev) => prev.map((n) =>
      n.key === key ? { ...n, x: e.clientX - rect.left - offsetX, y: e.clientY - rect.top - offsetY } : n));
  }

  async function openNode(node: GraphNode) {
    if (node.type === 'note') navigate(`/notes/${node.id}`);
    else if (node.type === 'channel') navigate(`/chat/${node.id}`);
    else if (node.type === 'card') {
      const { card } = await get<{ card: { board_id: number } }>(`/api/cards/${node.id}`);
      navigate(`/board/${card.board_id}/card/${node.id}`);
    }
  }

  const byKey = new Map(positions.map((n) => [n.key, n]));

  return (
    <>
      <div className={mainHeader}>
        <h2 className={viewTitle + " truncate"}>◉ Grafo de conocimiento</h2>
        <span className="text-[13px] text-dim">
          {data ? `${data.nodes.length} nodos · ${data.edges.length} vínculos` : 'Cargando…'}
        </span>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="relative h-full min-h-[420px] min-w-[640px]" ref={containerRef}
          onMouseMove={onMouseMove}
          onMouseUp={() => (dragRef.current = null)}
          onMouseLeave={() => (dragRef.current = null)}>
          <svg className="block h-full w-full">
            {data?.edges.map((edge, i) => {
              const a = byKey.get(edge.source), b = byKey.get(edge.target);
              if (!a || !b) return null;
              return (
                <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={edge.kind === 'discussion' ? '#3ecfb255' : '#b18cfa55'}
                  strokeWidth={1.5}
                  strokeDasharray={edge.kind === 'manual' ? '4 3' : undefined} />
              );
            })}
            {positions.map((node) => (
              <g key={node.key} className="group cursor-pointer"
                transform={`translate(${node.x}, ${node.y})`}
                onMouseDown={(e) => {
                  const rect = containerRef.current!.getBoundingClientRect();
                  dragRef.current = { key: node.key, offsetX: e.clientX - rect.left - node.x, offsetY: e.clientY - rect.top - node.y };
                }}
                onDoubleClick={() => openNode(node)}>
                <circle r={node.type === 'note' ? 11 : 9} fill={NODE_COLORS[node.type]}
                  stroke="var(--color-ink)" strokeWidth={2} />
                <text y={node.type === 'note' ? 25 : 23} textAnchor="middle"
                  className="pointer-events-none fill-dim text-[10px] group-hover:fill-fg group-hover:font-semibold">
                  {node.label.length > 22 ? node.label.slice(0, 20) + '…' : node.label}
                </text>
              </g>
            ))}
          </svg>
          <div className="absolute right-2 top-2 sm:right-3.5 sm:top-3.5 flex flex-col gap-1.5 rounded-xl border border-edge bg-panel px-4 py-3 text-xs">
            <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-note" /> Notas</div>
            <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-board" /> Tarjetas</div>
            <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-chat" /> Canales</div>
            <div className="mt-1 flex items-center gap-2 text-dim">Doble clic para abrir · arrastra para mover</div>
          </div>
        </div>
      </div>
    </>
  );
}
