import { useEffect, useRef, useState } from 'react';
import { get, onWsEvent } from '../api';
import type { GraphEdge, GraphNode } from '../types';
import { navigate } from '../App';

const NODE_COLORS: Record<string, string> = { note: '#8b5cf6', card: '#3b82f6', channel: '#22c55e' };

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
      <div className="main-header">
        <h2>◉ Grafo de conocimiento</h2>
        <span className="subtitle">
          {data ? `${data.nodes.length} nodos · ${data.edges.length} vínculos` : 'Cargando…'}
        </span>
      </div>
      <div className="main-body">
        <div className="graph-container" ref={containerRef}
          onMouseMove={onMouseMove}
          onMouseUp={() => (dragRef.current = null)}
          onMouseLeave={() => (dragRef.current = null)}>
          <svg>
            {data?.edges.map((edge, i) => {
              const a = byKey.get(edge.source), b = byKey.get(edge.target);
              if (!a || !b) return null;
              return (
                <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={edge.kind === 'discussion' ? '#22c55e55' : '#8b5cf655'}
                  strokeWidth={1.5}
                  strokeDasharray={edge.kind === 'manual' ? '4 3' : undefined} />
              );
            })}
            {positions.map((node) => (
              <g key={node.key} className="graph-node"
                transform={`translate(${node.x}, ${node.y})`}
                onMouseDown={(e) => {
                  const rect = containerRef.current!.getBoundingClientRect();
                  dragRef.current = { key: node.key, offsetX: e.clientX - rect.left - node.x, offsetY: e.clientY - rect.top - node.y };
                }}
                onDoubleClick={() => openNode(node)}>
                <circle r={node.type === 'note' ? 11 : 9} fill={NODE_COLORS[node.type]}
                  stroke="var(--bg)" strokeWidth={2} />
                <text y={node.type === 'note' ? 25 : 23} textAnchor="middle">
                  {node.label.length > 22 ? node.label.slice(0, 20) + '…' : node.label}
                </text>
              </g>
            ))}
          </svg>
          <div className="graph-legend">
            <div className="row"><span className="dot" style={{ background: NODE_COLORS.note }} /> Notas</div>
            <div className="row"><span className="dot" style={{ background: NODE_COLORS.card }} /> Tarjetas</div>
            <div className="row"><span className="dot" style={{ background: NODE_COLORS.channel }} /> Canales</div>
            <div className="row" style={{ color: 'var(--text-dim)', marginTop: 4 }}>Doble clic para abrir · arrastra para mover</div>
          </div>
        </div>
      </div>
    </>
  );
}
