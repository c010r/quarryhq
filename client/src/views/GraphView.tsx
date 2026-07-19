import { useEffect, useMemo, useRef, useState } from 'react';
import { get, onWsEvent } from '../api';
import type { GraphEdge, GraphNode } from '../types';
import { navigate } from '../App';
import { mainHeader, modalClose, sectionTitle, viewTitle } from '../ui';

// Los nodos usan el color de su módulo: notas violeta, tarjetas ámbar, canales teal.
const NODE_COLORS: Record<string, string> = { note: '#b18cfa', card: '#e9a23b', channel: '#3ecfb2' };
const TYPE_NAMES: Record<string, string> = { note: 'Nota', card: 'Tarjeta', channel: 'Canal' };
// Paleta para comunidades, en la misma familia tonal que el resto de la app
const COMMUNITY_PALETTE = [
  '#b18cfa', '#6bb2f2', '#3ecfb2', '#e9a23b', '#f27d98',
  '#8b93f8', '#f97316', '#a3e635', '#f43f5e', '#06b6d4',
];
const GRAY = '#8a90a5';

interface SimNode extends GraphNode { x: number; y: number; vx: number; vy: number }

interface CommunityInfo { id: number; label: string; size: number; color: string }
interface GodNode { key: string; label: string; type: string; degree: number }
interface Bridge { a: string; b: string; aLabel: string; bLabel: string }

interface Analysis {
  degree: Map<string, number>;
  community: Map<string, number>;
  communities: CommunityInfo[];
  gods: GodNode[];
  bridges: Bridge[];
  neighbors: Map<string, Set<string>>;
}

// Detección de comunidades por propagación de etiquetas (estilo graphify,
// pero en cliente y determinista) + god nodes y puentes entre comunidades.
function analyzeGraph(nodes: GraphNode[], edges: GraphEdge[]): Analysis {
  const neighbors = new Map<string, Set<string>>(nodes.map((n) => [n.key, new Set<string>()]));
  for (const e of edges) {
    if (!neighbors.has(e.source) || !neighbors.has(e.target)) continue;
    neighbors.get(e.source)!.add(e.target);
    neighbors.get(e.target)!.add(e.source);
  }
  const degree = new Map(nodes.map((n) => [n.key, neighbors.get(n.key)!.size]));

  // Propagación de etiquetas: cada nodo adopta la etiqueta mayoritaria de sus vecinos
  const label = new Map(nodes.map((n, i) => [n.key, i]));
  for (let iter = 0; iter < 15; iter++) {
    let changed = false;
    for (const n of nodes) {
      const counts = new Map<number, number>();
      for (const nb of neighbors.get(n.key)!) {
        const l = label.get(nb)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      if (counts.size === 0) continue;
      let best = label.get(n.key)!, bestCount = counts.get(best) ?? 0;
      for (const [l, c] of counts) {
        if (c > bestCount || (c === bestCount && l < best)) { best = l; bestCount = c; }
      }
      if (best !== label.get(n.key)) { label.set(n.key, best); changed = true; }
    }
    if (!changed) break;
  }

  // Renumerar comunidades por tamaño descendente
  const groups = new Map<number, string[]>();
  for (const n of nodes) {
    const l = label.get(n.key)!;
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l)!.push(n.key);
  }
  const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
  const community = new Map<string, number>();
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const communities: CommunityInfo[] = ordered.map((keys, id) => {
    for (const k of keys) community.set(k, id);
    // La comunidad hereda el nombre de su nodo más conectado
    const top = keys.reduce((a, b) => (degree.get(b)! > degree.get(a)! ? b : a));
    return {
      id,
      label: byKey.get(top)!.label,
      size: keys.length,
      color: id < COMMUNITY_PALETTE.length ? COMMUNITY_PALETTE[id] : GRAY,
    };
  });

  const gods: GodNode[] = [...degree.entries()]
    .filter(([, d]) => d > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, d]) => ({ key, label: byKey.get(key)!.label, type: byKey.get(key)!.type, degree: d }));

  // Puentes: única arista que conecta dos comunidades distintas
  const pairEdges = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const ca = community.get(e.source), cb = community.get(e.target);
    if (ca === undefined || cb === undefined || ca === cb) continue;
    const pair = ca < cb ? `${ca}-${cb}` : `${cb}-${ca}`;
    if (!pairEdges.has(pair)) pairEdges.set(pair, []);
    pairEdges.get(pair)!.push(e);
  }
  const bridges: Bridge[] = [...pairEdges.values()]
    .filter((list) => list.length === 1)
    .map(([e]) => ({
      a: e.source, b: e.target,
      aLabel: byKey.get(e.source)!.label, bLabel: byKey.get(e.target)!.label,
    }))
    .slice(0, 6);

  return { degree, community, communities, gods, bridges, neighbors };
}

export default function GraphView() {
  const [data, setData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [positions, setPositions] = useState<SimNode[]>([]);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [colorMode, setColorMode] = useState<'community' | 'type'>('community');
  const [selectedCommunity, setSelectedCommunity] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ key: string; offsetX: number; offsetY: number } | null>(null);

  useEffect(() => {
    const load = () => get<{ nodes: GraphNode[]; edges: GraphEdge[] }>('/api/graph').then(setData);
    load();
    return onWsEvent((e) => {
      if (['links:changed', 'notes:changed', 'boards:changed', 'channels:changed', 'board:changed'].includes(e.type)) load();
    });
  }, []);

  const analysis = useMemo(() => data ? analyzeGraph(data.nodes, data.edges) : null, [data]);

  // Simulación de fuerzas: repulsión + atracción por aristas (más corta dentro
  // de la misma comunidad, para que los clústeres se agrupen) + centrado
  useEffect(() => {
    if (!data || !analysis) return;
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
        const sameCommunity = analysis.community.get(edge.source) === analysis.community.get(edge.target);
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = (dist - (sameCommunity ? 90 : 160)) * 0.012;
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
  }, [data, analysis]);

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
  const query = search.trim().toLowerCase();

  function nodeColor(node: GraphNode): string {
    if (colorMode === 'type') return NODE_COLORS[node.type];
    const c = analysis?.community.get(node.key);
    return c === undefined ? GRAY : analysis!.communities[c].color;
  }

  function isDimmed(node: GraphNode): boolean {
    if (!analysis) return false;
    if (hoverKey) return node.key !== hoverKey && !analysis.neighbors.get(hoverKey)?.has(node.key);
    if (selectedCommunity !== null) return analysis.community.get(node.key) !== selectedCommunity;
    if (query) return !node.label.toLowerCase().includes(query);
    return false;
  }

  const hoverNode = hoverKey ? byKey.get(hoverKey) : null;
  const hoverCommunity = hoverNode && analysis ? analysis.communities[analysis.community.get(hoverKey!)!] : null;
  const godKeys = new Set(analysis?.gods.slice(0, 3).map((g) => g.key));

  const panelRow = (selected = false) =>
    `flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 transition-colors ${
      selected ? 'bg-accent/10 text-fg' : 'text-dim hover:bg-hover hover:text-fg'
    }`;
  const toggleBtn = (active: boolean) =>
    `px-2.5 py-1 text-[11.5px] transition-colors ${active ? 'bg-accent/10 font-semibold text-accent' : 'text-dim hover:text-fg'}`;

  return (
    <>
      <div className={mainHeader}>
        <h2 className={viewTitle + " truncate"}>◉ Grafo de conocimiento</h2>
        <span className="text-[13px] text-dim">
          {data && analysis
            ? `${data.nodes.length} nodos · ${data.edges.length} vínculos · ${analysis.communities.filter((c) => c.size > 1).length} comunidades`
            : 'Cargando…'}
        </span>
        {!panelOpen && (
          <button className="ml-auto rounded-lg border border-edge bg-panel px-3 py-1.5 text-xs text-dim transition-colors hover:border-accent hover:text-fg"
            onClick={() => setPanelOpen(true)}>☰ Análisis</button>
        )}
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
              const touchesHover = hoverKey && (edge.source === hoverKey || edge.target === hoverKey);
              const dim = (isDimmed(a) || isDimmed(b)) && !touchesHover;
              return (
                <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  className="transition-opacity duration-150"
                  stroke={touchesHover ? nodeColor(hoverNode!) : nodeColor(a) + '55'}
                  strokeWidth={touchesHover ? 2 : 1.5}
                  opacity={dim ? 0.08 : 1}
                  strokeDasharray={edge.kind === 'manual' ? '4 3' : undefined} />
              );
            })}
            {positions.map((node) => {
              const deg = analysis?.degree.get(node.key) ?? 0;
              const r = 6 + Math.min(10, Math.sqrt(deg) * 2.4);
              const dim = isDimmed(node);
              return (
                <g key={node.key} className="group cursor-pointer transition-opacity duration-150"
                  transform={`translate(${node.x}, ${node.y})`}
                  opacity={dim ? 0.15 : 1}
                  onMouseDown={(e) => {
                    const rect = containerRef.current!.getBoundingClientRect();
                    dragRef.current = { key: node.key, offsetX: e.clientX - rect.left - node.x, offsetY: e.clientY - rect.top - node.y };
                  }}
                  onMouseEnter={() => setHoverKey(node.key)}
                  onMouseLeave={() => setHoverKey(null)}
                  onDoubleClick={() => openNode(node)}>
                  {godKeys.has(node.key) && (
                    <circle r={r + 5} fill="none" stroke={nodeColor(node)} strokeWidth={1.5} opacity={0.45} />
                  )}
                  <circle r={r} fill={nodeColor(node)} stroke="var(--color-ink)" strokeWidth={2} />
                  <text y={r + 13} textAnchor="middle"
                    className="pointer-events-none fill-dim text-[10px] group-hover:fill-fg group-hover:font-semibold">
                    {node.label.length > 22 ? node.label.slice(0, 20) + '…' : node.label}
                  </text>
                </g>
              );
            })}
          </svg>

          {hoverNode && analysis && (
            <div className="pointer-events-none absolute z-20 max-w-60 rounded-lg border border-edge bg-raised px-2.5 py-2 text-xs shadow-xl shadow-black/30"
              style={{ left: hoverNode.x + 18, top: hoverNode.y - 12 }}>
              <div className="font-semibold">{hoverNode.label}</div>
              <div className="text-dim">
                {TYPE_NAMES[hoverNode.type]} · {analysis.degree.get(hoverNode.key)} conexiones
                {hoverCommunity && colorMode === 'community' && <> · <span style={{ color: hoverCommunity.color }}>●</span> {hoverCommunity.label}</>}
              </div>
              <div className="mt-1 text-[10.5px] text-dim opacity-80">Doble clic para abrir</div>
            </div>
          )}

          {panelOpen && analysis && (
            <div className="absolute right-2 top-2 flex max-h-[calc(100%-16px)] w-[270px] flex-col gap-3.5 overflow-y-auto rounded-xl border border-edge bg-panel/95 p-3.5 text-xs backdrop-blur-sm sm:right-3.5 sm:top-3.5">
              <div className="flex items-center justify-between">
                <strong className="font-display">Análisis del grafo</strong>
                <button className={modalClose} onClick={() => setPanelOpen(false)}>✕</button>
              </div>
              <input value={search} placeholder="Buscar nodo…"
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-edge bg-ink px-2.5 py-1.5 text-xs outline-none transition-colors focus:border-accent" />
              <div className="flex self-start overflow-hidden rounded-lg border border-edge bg-ink">
                <button className={toggleBtn(colorMode === 'community')} onClick={() => setColorMode('community')}>Comunidades</button>
                <button className={toggleBtn(colorMode === 'type')} onClick={() => { setColorMode('type'); setSelectedCommunity(null); }}>Tipo</button>
              </div>

              {colorMode === 'community' ? (
                <div>
                  <h4 className={sectionTitle}>Comunidades</h4>
                  {analysis.communities.filter((c) => c.size > 1).slice(0, 8).map((c) => (
                    <div key={c.id} className={panelRow(selectedCommunity === c.id)}
                      onClick={() => setSelectedCommunity(selectedCommunity === c.id ? null : c.id)}>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.color }} />
                      <span className="flex-1 truncate">{c.label}</span>
                      <span className="text-dim">{c.size}</span>
                    </div>
                  ))}
                  {analysis.communities.every((c) => c.size <= 1) && (
                    <div className="text-dim">Aún no hay clústeres: vincula notas con [[…]]</div>
                  )}
                </div>
              ) : (
                <div>
                  <h4 className={sectionTitle}>Tipos</h4>
                  {Object.entries(NODE_COLORS).map(([t, color]) => (
                    <div key={t} className={panelRow()}>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                      <span className="flex-1">{TYPE_NAMES[t]}s</span>
                    </div>
                  ))}
                </div>
              )}

              {analysis.gods.length > 0 && (
                <div>
                  <h4 className={sectionTitle}>Nodos centrales</h4>
                  {analysis.gods.map((g) => (
                    <div key={g.key} className={panelRow()}
                      onMouseEnter={() => setHoverKey(g.key)}
                      onMouseLeave={() => setHoverKey(null)}
                      onClick={() => { const n = byKey.get(g.key); if (n) openNode(n); }}>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: byKey.get(g.key) ? nodeColor(byKey.get(g.key)!) : GRAY }} />
                      <span className="flex-1 truncate">{g.label}</span>
                      <span className="text-dim">{g.degree} ⇄</span>
                    </div>
                  ))}
                </div>
              )}

              {analysis.bridges.length > 0 && (
                <div>
                  <h4 className={sectionTitle}>Conexiones puente</h4>
                  {analysis.bridges.map((b, i) => (
                    <div key={i} className={panelRow()}
                      onMouseEnter={() => setHoverKey(b.a)}
                      onMouseLeave={() => setHoverKey(null)}>
                      <span className="flex-1 leading-snug">{b.aLabel} <span className="text-dim">⇠⇢</span> {b.bLabel}</span>
                    </div>
                  ))}
                  <div className="mt-1 text-dim">Única arista que une dos comunidades.</div>
                </div>
              )}

              <div className="text-dim">Doble clic abre el elemento · arrastra para reordenar</div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
