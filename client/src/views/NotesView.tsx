import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, patch, del, notifyPlanBlock } from '../api';
import type { Backlink, Note, NoteMeta, NoteVersion, TagCount, Template } from '../types';
import { renderMarkdown } from '../markdown';
import { navigate } from '../App';
import { btnDanger, chip, emptyState, headerBtn, modalClose, sectionTitle, sideHeading, sideIcon, sideItem, sideLabel } from '../ui';

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
function VersionHistory({ noteId, isPremium, onRestore, onClose }: {
  noteId: number;
  isPremium: boolean;
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
    if (!isPremium) {
      notifyPlanBlock('Restaurar versiones anteriores es parte de Premium.');
      return;
    }
    if (!confirm('¿Restaurar esta versión? El estado actual se guardará en el historial.')) return;
    await post(`/api/notes/${noteId}/restore`, { version_id: versionId });
    onRestore();
    onClose();
  }

  return (
    <div className="fixed inset-y-0 right-0 z-60 flex w-[340px] flex-col border-l border-edge bg-panel shadow-2xl shadow-black/40">
      <div className="flex items-center justify-between border-b border-edge px-4 py-3.5 font-display font-bold">
        🕘 Historial de versiones
        <button className={modalClose} onClick={onClose}>✕</button>
      </div>
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
              <button className="text-xs text-accent hover:brightness-110" onClick={() => restore(v.id)}>
                ↩ Restaurar{!isPremium && ' 🔒'}
              </button>
            </div>
            {expanded === v.id && (
              <pre className="mt-1.5 max-h-30 overflow-auto whitespace-pre-wrap rounded-md bg-ink p-2 font-mono text-[11.5px]">{previewContent}</pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function NotesView({ noteId, notes, onChanged, isPremium }: {
  noteId?: number;
  notes: NoteMeta[];
  onChanged: () => void;
  isPremium: boolean;
}) {
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedId = useRef<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [filteredNotes, setFilteredNotes] = useState<NoteMeta[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);

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
    const title = prompt('Título de la nueva nota:');
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
    const name = prompt('Nombre de la plantilla:', detail.note.title);
    if (!name?.trim()) return;
    try {
      await post('/api/templates', { name, content: content });
      alert(`Plantilla "${name}" guardada.`);
    } catch (err: any) { alert(err.message); }
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
    const data = await get<NoteDetail>(`/api/notes/${id}`);
    setDetail(data);
    setTitle(data.note.title);
    setContent(data.note.content);
    setSaveState('saved');
    loadedId.current = id;
  }, []);

  useEffect(() => {
    if (noteId) load(noteId);
    else setDetail(null);
  }, [noteId, load]);

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
    if (!detail || !confirm(`¿Eliminar la nota "${detail.note.title}"?`)) return;
    await del(`/api/notes/${detail.note.id}`);
    onChanged();
    navigate('/notes');
    setDetail(null);
  }

  // Interceptar clics en wiki-links dentro de la vista previa
  function onPreviewClick(e: React.MouseEvent) {
    const anchor = (e.target as HTMLElement).closest('a');
    if (anchor?.getAttribute('href')?.startsWith('#/wiki/')) {
      e.preventDefault();
      navigate(anchor.getAttribute('href')!.slice(1));
    }
  }

  const toggleBtn = (active: boolean) =>
    `px-3 py-1.5 text-xs transition-colors ${active ? 'bg-note/10 font-semibold text-note' : 'text-dim hover:text-fg'}`;

  return (
    <div className="flex h-full">
      <div className="w-48 shrink-0 overflow-y-auto border-r border-edge p-2.5 lg:w-[250px]">
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
        {(filteredNotes ?? notes).map((n) => (
          <button key={n.id} className={sideItem(detail?.note.id === n.id, 'note')}
            onClick={() => navigate(`/notes/${n.id}`)}>
            <span className={`${sideIcon} text-note`}>◆</span><span className={sideLabel}>{n.title}</span>
          </button>
        ))}
        {(filteredNotes ?? notes).length === 0 && <div className="p-6 text-center text-[13px] text-dim">Sin notas.</div>}
      </div>

      {detail ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-edge px-5 py-3">
            <input value={title}
              onChange={(e) => { setTitle(e.target.value); scheduleSave(e.target.value, content); }}
              className="min-w-40 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 font-display text-[17px] font-bold outline-none transition-colors focus:border-accent focus:bg-ink" />
            <span className="min-w-18 text-right text-xs text-dim">
              {saveState === 'saved' ? '✓ Guardado' : saveState === 'saving' ? 'Guardando…' : 'Sin guardar'}
            </span>
            <div className="flex overflow-hidden rounded-lg border border-edge bg-ink">
              <button className={toggleBtn(mode === 'edit')} onClick={() => setMode('edit')}>Editar</button>
              <button className={toggleBtn(mode === 'preview')} onClick={() => setMode('preview')}>Vista previa</button>
            </div>
            <button className={headerBtn} onClick={() => setShowHistory(true)} title="Historial de versiones">🕘 Historial</button>
            <button className={headerBtn} onClick={saveAsTemplate}
              title={isPremium ? 'Guardar como plantilla' : 'Guardar como plantilla (Premium)'}>
              📄{!isPremium && '🔒'}
            </button>
            <button className={btnDanger} onClick={removeNote} title="Eliminar nota">🗑</button>
          </div>

          <div className="flex flex-1 overflow-hidden">
            {mode === 'edit' ? (
              <textarea value={content} placeholder="Escribe en markdown… usa [[Título]] para enlazar otras notas."
                onChange={(e) => { setContent(e.target.value); scheduleSave(title, e.target.value); }}
                className="flex-1 resize-none bg-transparent px-6 py-5 font-mono text-[13.5px] leading-[1.65] outline-none" />
            ) : (
              <div className="md flex-1 overflow-y-auto px-6 py-5" onClick={onPreviewClick}
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
                        else if (b.source_type === 'card') alert(`Vinculada desde la tarjeta: ${b.label}`);
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
        <VersionHistory noteId={detail.note.id} isPremium={isPremium}
          onRestore={() => load(detail.note.id)}
          onClose={() => setShowHistory(false)} />
      )}
    </div>
  );
}
