import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, patch, del, notifyPlanBlock, onWsEvent, sendWs } from '../api';
import type { Backlink, Note, NoteMeta, NoteVersion, TagCount, Template } from '../types';
import { renderMarkdown } from '../markdown';
import { MD_COMMANDS, MD_CHEATSHEET, detectMenu, getCaretCoords, type EditorMenu, type MdCommand } from '../editor';
import { pickDriveFile, driveFileSnippet } from '../googleDrive';
import { buildZip } from '../zip';
import { navigate } from '../App';
import { chip, emptyState, headerBtn, iconBtn, modalClose, sectionTitle, sideHeading, sideIcon, sideItem, sideLabel, titleChip } from '../ui';
import { alertDialog, confirmDialog, promptDialog } from '../dialog';
import ShareModal from './ShareModal';
import PresenceAvatars, { type PresenceViewer } from './PresenceAvatars';
import MoreMenu from './MoreMenu';

// Shell compartido de los paneles laterales (historial, guía): entra
// deslizando, con backdrop para cerrar tocando afuera y también con Escape.
function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-50 animate-fade-in bg-black/40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-60 flex w-full max-w-[340px] animate-panel-in flex-col border-l border-edge bg-panel shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3.5 font-display font-bold">
          {title}
          <button className={modalClose} onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </>
  );
}

interface NoteDetail {
  note: Note;
  backlinks: Backlink[];
  outgoing: { id: number; title: string }[];
}

function formatVersionDate(iso: string): string {
  const date = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return date.toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Panel lateral con el historial de versiones (estilo Obsidian Sync)
function VersionHistory({ noteId, isPremium, isViewer, onRestore, onClose }: {
  noteId: number;
  isPremium: boolean;
  isViewer?: boolean;
  onRestore: () => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [previewContent, setPreviewContent] = useState('');

  useEffect(() => {
    get<{ versions: NoteVersion[] }>(`/api/notes/${noteId}/versions`).then((d) => setVersions(d.versions));
  }, [noteId]);

  async function toggle(versionId: number) {
    if (expanded === versionId) { setExpanded(null); return; }
    const { version } = await get<{ version: { content: string } }>(`/api/versions/${versionId}`);
    setPreviewContent(version.content);
    setExpanded(versionId);
  }

  async function restore(versionId: number) {
    if (isViewer) return;
    if (!isPremium) {
      notifyPlanBlock('Restaurar versiones anteriores es parte de Premium.');
      return;
    }
    if (!await confirmDialog('¿Restaurar esta versión? El estado actual se guardará en el historial.', { confirmText: 'Restaurar' })) return;
    await post(`/api/notes/${noteId}/restore`, { version_id: versionId });
    onRestore();
    onClose();
  }

  return (
    <SidePanel title="🕘 Historial de versiones" onClose={onClose}>
      <div className="flex-1 overflow-y-auto p-3">
        {!isPremium && (
          <p className="mb-2.5 rounded-lg border border-edge bg-raised px-3 py-2 text-[12px] text-dim">
            El plan Free muestra las últimas 3 versiones. Con Premium ves el historial completo y puedes restaurar.
          </p>
        )}
        {versions.length === 0 && <p className="text-[13px] text-dim">Sin versiones anteriores. Se crean automáticamente al editar.</p>}
        {versions.map((v) => (
          <div key={v.id} className="mb-2 rounded-lg border border-edge bg-raised px-3 py-2.5 text-[13px]">
            <div className="mb-1.5 text-[11.5px] text-dim">{formatVersionDate(v.created_at)} · {v.size} caracteres</div>
            <div>{v.title}</div>
            <div className="mt-1.5 flex gap-2.5">
              <button className="text-xs text-accent hover:brightness-110" onClick={() => toggle(v.id)}>
                {expanded === v.id ? 'Ocultar' : 'Ver contenido'}
              </button>
              {!isViewer && (
                <button className="text-xs text-accent hover:brightness-110" onClick={() => restore(v.id)}>
                  ↩ Restaurar{!isPremium && ' 🔒'}
                </button>
              )}
            </div>
            {expanded === v.id && (
              <pre className="mt-1.5 max-h-30 overflow-auto whitespace-pre-wrap rounded-md bg-ink p-2 font-mono text-[11.5px]">{previewContent}</pre>
            )}
          </div>
        ))}
      </div>
    </SidePanel>
  );
}

// Panel lateral con la guía de sintaxis markdown y atajos del editor
function MdHelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <SidePanel title="📖 Guía Markdown" onClose={onClose}>
      <div className="flex-1 overflow-y-auto p-4">
        {MD_CHEATSHEET.map((sec) => (
          <div key={sec.title} className="mb-4.5">
            <h4 className={sectionTitle}>{sec.title}</h4>
            {sec.entries.map((entry) => (
              <div key={entry.syntax} className="flex items-baseline gap-2.5 py-1 text-[12.5px]">
                <code className="min-w-[112px] shrink-0 whitespace-nowrap rounded-md border border-edge bg-raised px-1.5 py-0.5 font-mono text-[11.5px]">{entry.syntax}</code>
                <span className="text-dim">{entry.desc}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </SidePanel>
  );
}

export default function NotesView({ noteId, notes, onChanged, isPremium, currentUserId }: {
  noteId?: number;
  notes: NoteMeta[];
  onChanged: () => void;
  isPremium: boolean;
  currentUserId: number;
}) {
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'edit' | 'split' | 'preview'>('edit');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedId = useRef<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [filteredNotes, setFilteredNotes] = useState<NoteMeta[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [listFilter, setListFilter] = useState('');
  const isViewer = detail?.note.myRole === 'viewer';
  const [viewers, setViewers] = useState<PresenceViewer[]>([]);

  // Menú flotante del editor: comandos "/" y autocompletado de "[["
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<EditorMenu | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  // Presencia: le avisa al resto quién está mirando esta nota ahora
  useEffect(() => {
    if (!noteId) return;
    sendWs({ type: 'presence:join', resourceType: 'note', resourceId: noteId });
    return () => sendWs({ type: 'presence:leave' });
  }, [noteId]);
  useEffect(() => onWsEvent((e) => {
    if (e.type === 'presence:update' && e.resourceType === 'note' && e.resourceId === noteId) setViewers(e.viewers);
  }), [noteId]);

  const loadTags = useCallback(() => {
    get<{ tags: TagCount[] }>('/api/tags').then((d) => setTags(d.tags));
  }, []);

  useEffect(() => { loadTags(); }, [loadTags, notes]);

  useEffect(() => {
    if (!activeTag) { setFilteredNotes(null); return; }
    get<{ notes: NoteMeta[] }>(`/api/notes?tag=${encodeURIComponent(activeTag)}`).then((d) => setFilteredNotes(d.notes));
  }, [activeTag, notes]);

  async function openTemplates() {
    const { templates } = await get<{ templates: Template[] }>('/api/templates');
    setTemplates(templates);
    setShowTemplates(!showTemplates);
  }

  async function createFromTemplate(templateId: number) {
    const title = await promptDialog('Título de la nueva nota:');
    if (!title?.trim()) return;
    const { note } = await post<{ note: { id: number } }>('/api/notes', { title, template_id: templateId });
    setShowTemplates(false);
    onChanged();
    navigate(`/notes/${note.id}`);
  }

  async function saveAsTemplate() {
    if (!detail) return;
    if (!isPremium) {
      notifyPlanBlock('Crear plantillas personalizadas es parte de Premium.');
      return;
    }
    const name = await promptDialog('Nombre de la plantilla:', { defaultValue: detail.note.title });
    if (!name?.trim()) return;
    try {
      await post('/api/templates', { name, content: content });
      alertDialog(`Plantilla "${name}" guardada.`);
    } catch (err: any) { alertDialog(err.message); }
  }

  async function openDailyNote() {
    const today = new Date().toISOString().slice(0, 10);
    const { templates } = await get<{ templates: Template[] }>('/api/templates');
    const daily = templates.find((t) => t.name === 'Nota diaria');
    const { note } = await post<{ note: { id: number } }>('/api/notes', {
      title: `Diario ${today}`,
      template_id: daily?.id,
    });
    onChanged();
    navigate(`/notes/${note.id}`);
  }

  const load = useCallback(async (id: number) => {
    try {
      const data = await get<NoteDetail>(`/api/notes/${id}`);
      setDetail(data);
      setTitle(data.note.title);
      setContent(data.note.content);
      setSaveState('saved');
      setMenu(null);
      loadedId.current = id;
    } catch {
      // Borrada, o perdiste el acceso (te sacaron como colaborador)
      setDetail(null);
      navigate('/notes');
    }
  }, []);

  useEffect(() => {
    if (noteId) load(noteId);
    else setDetail(null);
  }, [noteId, load]);

  // Cambios remotos (colaborador editando el mismo recurso compartido): se
  // refresca al instante, salvo que haya tipeo local sin guardar todavía —
  // ahí se pisaría lo que el usuario está escribiendo.
  useEffect(() => onWsEvent((e) => {
    if (e.type !== 'notes:changed' || e.noteId !== noteId) return;
    if (e.deleted) { navigate('/notes'); return; }
    if (saveState === 'saved') load(noteId!);
  }), [noteId, saveState, load]);

  // Autoguardado con debounce de 800 ms
  function scheduleSave(nextTitle: string, nextContent: string) {
    setSaveState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (!loadedId.current) return;
      setSaveState('saving');
      await patch(`/api/notes/${loadedId.current}`, { title: nextTitle, content: nextContent });
      setSaveState('saved');
      onChanged();
      // Refrescar backlinks/salientes sin pisar el texto que se está editando
      const data = await get<NoteDetail>(`/api/notes/${loadedId.current}`);
      setDetail((prev) => prev ? { ...prev, backlinks: data.backlinks, outgoing: data.outgoing } : data);
    }, 800);
  }

  async function removeNote() {
    if (!detail || !await confirmDialog(`¿Eliminar la nota "${detail.note.title}"?`, { danger: true, confirmText: 'Eliminar' })) return;
    await del(`/api/notes/${detail.note.id}`);
    onChanged();
    navigate('/notes');
    setDetail(null);
  }

  // ---------- Exportar ----------

  function sanitizeFilename(name: string): string {
    return name.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 120) || 'nota';
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // .md conserva tal cual el texto de la nota — los [[wikilinks]] ya usan la
  // misma sintaxis que Obsidian, así que no hace falta transformar nada.
  async function exportMarkdown() {
    if (!detail) return;
    const linked = new Map<number, string>();
    for (const o of detail.outgoing) linked.set(o.id, o.title);
    for (const b of detail.backlinks) if (b.source_type === 'note' && b.label) linked.set(b.source_id, b.label);

    if (linked.size === 0) {
      downloadBlob(new Blob([content], { type: 'text/markdown' }), `${sanitizeFilename(title)}.md`);
      return;
    }

    const includeLinked = await confirmDialog(
      `Esta nota está vinculada con ${linked.size} nota${linked.size === 1 ? '' : 's'} más. ¿Incluirlas para mantener los enlaces al importar en Obsidian?`,
      { confirmText: 'Incluir vinculadas (.zip)', cancelText: 'Solo esta nota' });

    if (!includeLinked) {
      downloadBlob(new Blob([content], { type: 'text/markdown' }), `${sanitizeFilename(title)}.md`);
      return;
    }

    // BFS sobre el grafo de enlaces (saliente y entrante) para juntar todo
    // el componente conectado, no solo los vecinos directos.
    const visited = new Map<number, { title: string; content: string }>();
    visited.set(detail.note.id, { title, content });
    const queue = [...linked.entries()].map(([id, t]) => ({ id, title: t }));
    while (queue.length) {
      const next = queue.shift()!;
      if (visited.has(next.id)) continue;
      const data = await get<NoteDetail>(`/api/notes/${next.id}`);
      visited.set(next.id, { title: data.note.title, content: data.note.content });
      for (const o of data.outgoing) if (!visited.has(o.id)) queue.push(o);
      for (const b of data.backlinks) {
        if (b.source_type === 'note' && b.label && !visited.has(b.source_id)) queue.push({ id: b.source_id, title: b.label });
      }
    }

    const files = [...visited.values()].map((n) => ({ name: `${sanitizeFilename(n.title)}.md`, content: n.content }));
    downloadBlob(buildZip(files), `${sanitizeFilename(title)}-obsidian.zip`);
  }

  // PDF vía el diálogo nativo de impresión del navegador ("Guardar como
  // PDF"): no agrega ninguna librería de generación de PDF solo para esto.
  function exportPdf() {
    const win = window.open('', '_blank');
    if (!win) { alertDialog('El navegador bloqueó la ventana de impresión. Habilitá los popups para este sitio.'); return; }
    const escaped = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escaped}</title><style>
      body { font-family: Georgia, 'Times New Roman', serif; max-width: 720px; margin: 40px auto; color: #1a1a1a; line-height: 1.6; }
      h1 { font-size: 1.6em; margin-bottom: 0.3em; }
      h1, h2, h3 { font-family: system-ui, sans-serif; }
      code { background: #f0f0f0; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
      pre { background: #f0f0f0; padding: 10px; border-radius: 6px; overflow-x: auto; }
      pre code { background: transparent; padding: 0; }
      blockquote { border-left: 3px solid #ccc; padding-left: 12px; color: #555; margin-left: 0; }
      a { color: #4550e5; }
      .drive-embed { display: none; } /* el visor de Drive no imprime bien */
    </style></head><body><h1>${escaped}</h1>${renderMarkdown(content)}</body></html>`);
    win.document.close();
    win.onload = () => win.print();
  }

  // Botones de tamaño (25/50/75/100%) y alineación (izq/centro/der) sobre un
  // embed de Drive: reescriben el prefijo guardado en el texto alt del
  // enlace (![kind:N:A:nombre](url)) — no en el título markdown estándar,
  // que no sobrevive al escapeHtml previo (ver markdown.ts). Al tocar
  // cualquiera de los dos controles se preserva el otro valor ya guardado.
  function setDriveMeta(id: string, kind: string, patch: { size?: string; align?: string }) {
    if (isViewer) return;
    const re = new RegExp(`!\\[${kind}:(?:([1-4]):)?(?:([lcr]):)?([^\\]]*)\\]\\(https://drive\\.google\\.com/file/d/${id}/preview\\)`);
    const m = re.exec(content);
    if (!m) return;
    const size = patch.size ?? m[1] ?? '4';
    const align = patch.align ?? m[2] ?? 'l';
    const next = content.slice(0, m.index) +
      `![${kind}:${size}:${align}:${m[3]}](https://drive.google.com/file/d/${id}/preview)` +
      content.slice(m.index + m[0].length);
    if (next !== content) { setContent(next); scheduleSave(title, next); }
  }

  // Interceptar clics en wiki-links y en los controles de tamaño/alineación
  // de Drive dentro de la vista previa
  function onPreviewClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    const sizeBtn = target.closest<HTMLElement>('[data-drive-size]');
    const alignBtn = target.closest<HTMLElement>('[data-drive-align]');
    if (sizeBtn || alignBtn) {
      const wrap = (sizeBtn ?? alignBtn)!.closest<HTMLElement>('.drive-embed[data-drive-id]');
      if (wrap) {
        setDriveMeta(wrap.dataset.driveId!, wrap.dataset.driveKind!,
          sizeBtn ? { size: sizeBtn.dataset.driveSize! } : { align: alignBtn!.dataset.driveAlign! });
      }
      return;
    }
    const anchor = (e.target as HTMLElement).closest('a');
    if (anchor?.getAttribute('href')?.startsWith('#/wiki/')) {
      e.preventDefault();
      navigate(anchor.getAttribute('href')!.slice(1));
    }
  }

  // ---------- Menú de comandos "/" y autocompletado de "[[" ----------

  const slashOptions: MdCommand[] = menu?.type === 'slash'
    ? MD_COMMANDS.filter((c) =>
        (c.label + ' ' + c.keywords + ' ' + c.id).toLowerCase().includes(menu.query.toLowerCase()))
    : [];

  const wikiQuery = menu?.type === 'wiki' ? menu.query.trim() : '';
  const wikiMatches: NoteMeta[] = menu?.type === 'wiki'
    ? notes.filter((n) => n.id !== detail?.note.id && n.title.toLowerCase().includes(wikiQuery.toLowerCase())).slice(0, 8)
    : [];
  const wikiCanCreate = menu?.type === 'wiki' && wikiQuery.length > 0 &&
    !notes.some((n) => n.title.toLowerCase() === wikiQuery.toLowerCase());
  const menuCount = menu?.type === 'slash' ? slashOptions.length : wikiMatches.length + (wikiCanCreate ? 1 : 0);

  // Recalcula el menú contextual a partir del texto y la posición del caret
  function updateMenu(ta: HTMLTextAreaElement) {
    if (isViewer) return;
    const next = detectMenu(ta.value, ta.selectionStart);
    if (next) {
      const coords = getCaretCoords(ta, next.start);
      setMenuPos({
        top: coords.top + 26,
        left: Math.max(8, Math.min(coords.left, ta.clientWidth - 300)),
      });
      setMenuIndex((prev) => (menu && menu.start === next.start ? prev : 0));
    }
    setMenu(next);
  }

  // Aplica una edición programática y restaura foco + caret
  function applyEdit(next: string, selStart: number, selEnd = selStart) {
    setContent(next);
    scheduleSave(title, next);
    setMenu(null);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(selStart, selEnd);
      updateMenu(ta); // reabre el menú si el snippet deja "[[" antes del caret
    });
  }

  function runSlashCommand(cmd: MdCommand) {
    const ta = taRef.current;
    if (!ta || !menu) return;
    const caret = ta.selectionStart;
    const cursorIdx = cmd.snippet.indexOf('$0');
    const clean = cmd.snippet.replace('$0', '');
    const next = content.slice(0, menu.start) + clean + content.slice(caret);
    applyEdit(next, menu.start + (cursorIdx >= 0 ? cursorIdx : clean.length));
  }

  function insertWikiLink(linkTitle: string) {
    const ta = taRef.current;
    if (!ta || !menu) return;
    const caret = ta.selectionEnd; // cubre también el placeholder seleccionado por la barra
    let rest = content.slice(caret);
    if (rest.startsWith(']]')) rest = rest.slice(2); // el snippet [[]] ya dejó el cierre
    const next = content.slice(0, menu.start) + `[[${linkTitle}]]` + rest;
    applyEdit(next, menu.start + linkTitle.length + 4);
  }

  function pickMenuOption(index: number) {
    if (!menu) return;
    if (menu.type === 'slash') {
      if (slashOptions[index]) runSlashCommand(slashOptions[index]);
    } else if (index < wikiMatches.length) {
      insertWikiLink(wikiMatches[index].title);
    } else if (wikiCanCreate) {
      insertWikiLink(wikiQuery);
    }
  }

  // ---------- Barra de formato ----------

  function wrapSelection(before: string, after: string, placeholder: string) {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = content.slice(s, e) || placeholder;
    const next = content.slice(0, s) + before + sel + after + content.slice(e);
    applyEdit(next, s + before.length, s + before.length + sel.length);
  }

  // Añade (o quita, si ya está) un prefijo a cada línea de la selección
  function prefixLines(prefix: string) {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const lineStart = content.lastIndexOf('\n', s - 1) + 1;
    const nextBreak = content.indexOf('\n', e);
    const lineEnd = nextBreak === -1 ? content.length : nextBreak;
    const block = content.slice(lineStart, lineEnd);
    const toggled = block.split('\n')
      .map((l) => l.startsWith(prefix) ? l.slice(prefix.length) : prefix + l)
      .join('\n');
    const next = content.slice(0, lineStart) + toggled + content.slice(lineEnd);
    applyEdit(next, lineStart, lineStart + toggled.length);
  }

  function insertBlockAtCaret(snippet: string) {
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart;
    const needsBreak = caret > 0 && content[caret - 1] !== '\n';
    const clean = (needsBreak ? '\n' : '') + snippet.replace('$0', '');
    const cursorIdx = snippet.indexOf('$0');
    const next = content.slice(0, caret) + clean + content.slice(ta.selectionEnd);
    applyEdit(next, caret + (cursorIdx >= 0 ? cursorIdx + (needsBreak ? 1 : 0) : clean.length));
  }

  const [drivePicking, setDrivePicking] = useState(false);
  async function insertFromDrive() {
    if (drivePicking) return;
    setDrivePicking(true);
    try {
      const file = await pickDriveFile();
      if (file) insertBlockAtCaret(driveFileSnippet(file) + '\n$0');
    } catch (err: any) {
      alertDialog(err.message ?? 'No se pudo abrir el selector de Google Drive');
    } finally {
      setDrivePicking(false);
    }
  }

  function onEditorKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menu && menuCount > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenuIndex((i) => (i + 1) % menuCount); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenuIndex((i) => (i - 1 + menuCount) % menuCount); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMenuOption(menuIndex); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
    }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); wrapSelection('**', '**', 'negrita'); }
      else if (k === 'i') { e.preventDefault(); wrapSelection('*', '*', 'cursiva'); }
      else if (k === 'e') { e.preventDefault(); wrapSelection('`', '`', 'código'); }
    }
  }

  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  const visibleNotes = (filteredNotes ?? notes).filter((n) =>
    !listFilter.trim() || n.title.toLowerCase().includes(listFilter.trim().toLowerCase()));

  const mdBtn = 'flex h-[26px] min-w-[28px] items-center justify-center rounded-md px-1.5 text-xs font-semibold text-dim transition-colors hover:bg-hover hover:text-fg';
  const toolbarSep = 'mx-1.5 h-4 w-px bg-edge';
  const slashItem = (selected: boolean) =>
    `flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors ${selected ? 'bg-accent/10' : 'hover:bg-hover'}`;
  const cmdIcon = 'flex h-[22px] w-7 shrink-0 items-center justify-center rounded-md border border-edge bg-ink text-[10.5px] text-dim';

  const toggleBtn = (active: boolean) =>
    `px-3 py-1.5 text-xs transition-colors ${active ? 'bg-note/10 font-semibold text-note' : 'text-dim hover:text-fg'}`;

  const editorPane = (
    <div className="relative flex min-w-0 flex-1">
      <textarea ref={taRef} value={content}
        placeholder={'Escribe en markdown…\n\nEscribe "/" al inicio de una línea para el menú de comandos, o "[[" para vincular otra nota.'}
        readOnly={isViewer}
        onChange={(e) => {
          setContent(e.target.value);
          scheduleSave(title, e.target.value);
          updateMenu(e.target);
        }}
        onClick={(e) => updateMenu(e.currentTarget)}
        onKeyUp={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) updateMenu(e.currentTarget);
        }}
        onKeyDown={onEditorKeyDown}
        onBlur={() => setTimeout(() => setMenu(null), 150)}
        className="min-w-0 flex-1 resize-none bg-transparent px-6 py-5 font-mono text-[13.5px] leading-[1.65] outline-none" />
      {menu && menuCount > 0 && (
        <div className="absolute z-30 max-h-[280px] w-[290px] overflow-y-auto rounded-xl border border-edge bg-raised p-1 shadow-2xl shadow-black/40"
          style={{ top: menuPos.top, left: menuPos.left }}>
          {menu.type === 'slash' && slashOptions.map((c, i) => (
            <button key={c.id} className={slashItem(i === menuIndex)}
              onMouseDown={(e) => { e.preventDefault(); runSlashCommand(c); }}
              onMouseEnter={() => setMenuIndex(i)}>
              <span className={cmdIcon}>{c.icon}</span>
              <span>{c.label}</span>
              <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-dim">{c.hint}</span>
            </button>
          ))}
          {menu.type === 'wiki' && (
            <>
              {wikiMatches.map((n, i) => (
                <button key={n.id} className={slashItem(i === menuIndex)}
                  onMouseDown={(e) => { e.preventDefault(); insertWikiLink(n.title); }}
                  onMouseEnter={() => setMenuIndex(i)}>
                  <span className={`${cmdIcon} text-note`}>◆</span>
                  <span className="truncate">{n.title}</span>
                </button>
              ))}
              {wikiCanCreate && (
                <button className={slashItem(menuIndex === wikiMatches.length)}
                  onMouseDown={(e) => { e.preventDefault(); insertWikiLink(wikiQuery); }}
                  onMouseEnter={() => setMenuIndex(wikiMatches.length)}>
                  <span className={cmdIcon}>＋</span>
                  <span className="truncate">Crear nota «{wikiQuery}»</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-w-0 flex-col md:flex-row">
      <div className="max-h-56 w-full shrink-0 overflow-y-auto border-b border-edge p-2.5 md:max-h-none md:w-48 md:border-b-0 md:border-r lg:w-[250px]">
        <input value={listFilter} placeholder="Filtrar notas…"
          onChange={(e) => setListFilter(e.target.value)}
          className="mb-1.5 w-full rounded-lg border border-edge bg-ink px-2.5 py-1.5 text-xs outline-none transition-colors focus:border-accent" />
        <div className={sideHeading}>Acciones</div>
        <button className={sideItem(false, 'note')} onClick={openDailyNote}>
          <span className={sideIcon}>☀</span><span className={sideLabel}>Nota diaria de hoy</span>
        </button>
        <button className={sideItem(false, 'note')} onClick={openTemplates}>
          <span className={sideIcon}>📄</span><span className={sideLabel}>Nueva desde plantilla…</span>
        </button>
        {showTemplates && templates.map((t) => (
          <button key={t.id} className={`${sideItem(false, 'note')} pl-6`}
            onClick={() => createFromTemplate(t.id)}>
            <span className={sideIcon}>↳</span><span className={sideLabel}>{t.name}</span>
          </button>
        ))}

        {tags.length > 0 && (
          <>
            <div className={sideHeading}>Etiquetas</div>
            <div className="flex flex-wrap gap-1.5 px-1.5 pb-2 pt-1">
              {tags.map((t) => (
                <span key={t.tag}
                  className={`inline-flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-0.5 text-xs transition ${
                    activeTag === t.tag ? 'bg-note/15 text-note' : 'bg-raised text-dim hover:text-fg'
                  }`}
                  onClick={() => setActiveTag(activeTag === t.tag ? null : t.tag)}>
                  #{t.tag} <span className="opacity-70">{t.count}</span>
                </span>
              ))}
            </div>
          </>
        )}

        <div className={sideHeading}>
          {activeTag ? `Notas con #${activeTag}` : 'Todas las notas'}
        </div>
        {visibleNotes.map((n) => (
          <button key={n.id} className={sideItem(detail?.note.id === n.id, 'note')}
            onClick={() => navigate(`/notes/${n.id}`)}>
            <span className={`${sideIcon} text-note`}>◆</span><span className={sideLabel}>{n.title}</span>
            {n.shared && <span className="shrink-0 text-[11px] text-dim" title={`Compartida por @${n.owner_username}`}>🤝</span>}
          </button>
        ))}
        {visibleNotes.length === 0 && <div className="p-6 text-center text-[13px] text-dim">Sin notas.</div>}
      </div>

      {detail ? (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-edge px-5 py-3">
            <span className={`${titleChip} bg-note/15 text-note`}>◆</span>
            <input value={title}
              onChange={(e) => { setTitle(e.target.value); scheduleSave(e.target.value, content); }}
              readOnly={isViewer}
              className="min-w-40 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 font-display text-[17px] font-bold outline-none transition-colors focus:border-accent focus:bg-ink" />
            <span className="min-w-18 text-right text-xs text-dim">
              {isViewer ? '👁 solo lectura' : saveState === 'saved' ? '✓ Guardado' : saveState === 'saving' ? 'Guardando…' : 'Sin guardar'}
            </span>
            {detail.note.shared && (
              <span className="text-xs text-dim">🤝 compartida por @{detail.note.owner_username}</span>
            )}
            {detail.note.updated_by_username && (
              <span className="text-xs text-dim">· editado por @{detail.note.updated_by_username}</span>
            )}
            <PresenceAvatars viewers={viewers} currentUserId={currentUserId} />
            <div className="flex overflow-hidden rounded-lg border border-edge bg-ink">
              <button className={toggleBtn(mode === 'edit')} onClick={() => setMode('edit')}>Editar</button>
              <button className={`${toggleBtn(mode === 'split')} hidden sm:block`} onClick={() => setMode('split')}>Dividida</button>
              <button className={toggleBtn(mode === 'preview')} onClick={() => setMode('preview')}>Vista previa</button>
            </div>
            {/* En móvil estas acciones se apilaban en varias filas y le
                robaban altura al editor; a partir de sm van inline, antes
                se agrupan en un menú "⋯" (mismo patrón que BoardView). */}
            <div className="hidden items-center gap-2 sm:flex">
              <button className={iconBtn} onClick={exportMarkdown} title="Descargar como .md">⬇ md</button>
              <button className={iconBtn} onClick={exportPdf} title="Descargar como PDF">⬇ PDF</button>
              <button className={headerBtn} onClick={() => setShowHistory(true)} title="Historial de versiones">🕘 Historial</button>
              {!isViewer && (
                <button className={iconBtn} onClick={saveAsTemplate}
                  title={isPremium ? 'Guardar como plantilla' : 'Guardar como plantilla (Premium)'}>
                  📄{!isPremium && '🔒'}
                </button>
              )}
              <button className={iconBtn} onClick={() => setShowShare(true)} title="Compartir nota">🤝</button>
              {!isViewer && (
                <button className={`${iconBtn} hover:border-danger hover:text-danger`} onClick={removeNote} title="Eliminar nota">🗑</button>
              )}
            </div>
            <MoreMenu className="sm:hidden" actions={[
              { label: '⬇ Descargar .md', onClick: exportMarkdown },
              { label: '⬇ Descargar PDF', onClick: exportPdf },
              { label: '🕘 Historial de versiones', onClick: () => setShowHistory(true) },
              ...(!isViewer ? [{ label: `📄 Guardar como plantilla${!isPremium ? ' 🔒' : ''}`, onClick: saveAsTemplate }] : []),
              { label: '🤝 Compartir', onClick: () => setShowShare(true) },
              ...(!isViewer ? [{ label: '🗑 Eliminar nota', onClick: removeNote, danger: true }] : []),
            ]} />
          </div>

          {mode !== 'preview' && !isViewer && (
            <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-edge px-4 py-1.5">
              <button className={mdBtn} title="Negrita (Ctrl+B)" onClick={() => wrapSelection('**', '**', 'negrita')}><b>B</b></button>
              <button className={mdBtn} title="Cursiva (Ctrl+I)" onClick={() => wrapSelection('*', '*', 'cursiva')}><i>I</i></button>
              <button className={mdBtn} title="Tachado" onClick={() => wrapSelection('~~', '~~', 'tachado')}><s>S</s></button>
              <button className={mdBtn} title="Código en línea (Ctrl+E)" onClick={() => wrapSelection('`', '`', 'código')}>‹›</button>
              <span className={toolbarSep} />
              <button className={mdBtn} title="Encabezado 1" onClick={() => prefixLines('# ')}>H1</button>
              <button className={mdBtn} title="Encabezado 2" onClick={() => prefixLines('## ')}>H2</button>
              <button className={mdBtn} title="Encabezado 3" onClick={() => prefixLines('### ')}>H3</button>
              <span className={toolbarSep} />
              <button className={mdBtn} title="Lista" onClick={() => prefixLines('- ')}>•</button>
              <button className={mdBtn} title="Tarea" onClick={() => prefixLines('- [ ] ')}>☐</button>
              <button className={mdBtn} title="Cita" onClick={() => prefixLines('> ')}>❝</button>
              <span className={toolbarSep} />
              <button className={`${mdBtn} text-note`} title="Vincular nota" onClick={() => wrapSelection('[[', ']]', 'Título')}>◆</button>
              <button className={mdBtn} title="Enlace web" onClick={() => wrapSelection('[', '](https://)', 'texto')}>🔗</button>
              <button className={mdBtn} title="Tabla" onClick={() => insertBlockAtCaret('| Columna 1 | Columna 2 |\n| --- | --- |\n| $0 |  |')}>▦</button>
              <button className={mdBtn} title="Divisor" onClick={() => insertBlockAtCaret('---\n$0')}>—</button>
              <span className={toolbarSep} />
              <button className={mdBtn} title="Insertar desde Google Drive" onClick={insertFromDrive} disabled={drivePicking}>🗂️</button>
              <span className="ml-auto hidden pr-1 text-[11.5px] text-dim sm:inline">{words} palabras · {content.length} caracteres</span>
              <button className={mdBtn} title="Guía Markdown" onClick={() => setShowHelp(true)}>?</button>
            </div>
          )}

          <div className="flex min-w-0 flex-1 overflow-hidden">
            {mode !== 'preview' && editorPane}
            {mode !== 'edit' && (
              <div className={`md min-w-0 flex-1 overflow-y-auto px-6 py-5 ${mode === 'split' ? 'border-l border-edge' : ''}`}
                onClick={onPreviewClick}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
            )}
          </div>

          {(detail.backlinks.length > 0 || detail.outgoing.length > 0) && (
            <div className="max-h-44 shrink-0 overflow-y-auto border-t border-edge px-5 py-3.5">
              {detail.backlinks.length > 0 && (
                <>
                  <h4 className={sectionTitle}>← Enlaces entrantes ({detail.backlinks.length})</h4>
                  <div className="mb-2.5 flex flex-wrap items-center gap-2">
                    {detail.backlinks.map((b, i) => (
                      <span key={i} className={chip} onClick={() => {
                        if (b.source_type === 'note') navigate(`/notes/${b.source_id}`);
                        else if (b.source_type === 'card') alertDialog(`Vinculada desde la tarjeta: ${b.label}`);
                        else if (b.source_type === 'message' && b.channel_id) navigate(`/chat/${b.channel_id}`);
                      }}>
                        <span className={b.source_type === 'note' ? 'text-note' : b.source_type === 'card' ? 'text-board' : 'text-chat'}>
                          {b.source_type === 'note' ? '◆' : b.source_type === 'card' ? '▦' : '💬'}
                        </span>
                        {(b.label ?? '').slice(0, 50) || '(sin título)'}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {detail.outgoing.length > 0 && (
                <>
                  <h4 className={sectionTitle}>→ Enlaces salientes ({detail.outgoing.length})</h4>
                  <div className="flex flex-wrap items-center gap-2">
                    {detail.outgoing.map((o) => (
                      <span key={o.id} className={chip} onClick={() => navigate(`/notes/${o.id}`)}>
                        <span className="text-note">◆</span>{o.title}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className={`${emptyState} flex-1`}>
          <h3 className="font-display text-base font-bold text-fg"><span className="text-note">◆</span> Tus notas</h3>
          <p>Selecciona una nota o crea una nueva desde la barra lateral.</p>
        </div>
      )}
      {showHistory && detail && (
        <VersionHistory noteId={detail.note.id} isPremium={isPremium} isViewer={isViewer}
          onRestore={() => load(detail.note.id)}
          onClose={() => setShowHistory(false)} />
      )}
      {showShare && detail && (
        <ShareModal type="note" resourceId={detail.note.id} resourceName={detail.note.title}
          currentUserId={currentUserId} isPremium={isPremium} onClose={() => setShowShare(false)} />
      )}
      {showHelp && <MdHelpPanel onClose={() => setShowHelp(false)} />}
    </div>
  );
}
