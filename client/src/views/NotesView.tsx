import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, patch, del } from '../api';
import type { Backlink, Note, NoteMeta, NoteVersion, TagCount, Template } from '../types';
import { renderMarkdown } from '../markdown';
import { navigate } from '../App';

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
function VersionHistory({ noteId, onRestore, onClose }: {
  noteId: number;
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
    if (!confirm('¿Restaurar esta versión? El estado actual se guardará en el historial.')) return;
    await post(`/api/notes/${noteId}/restore`, { version_id: versionId });
    onRestore();
    onClose();
  }

  return (
    <div className="side-panel">
      <div className="side-panel-header">
        🕘 Historial de versiones
        <button className="modal-close" onClick={onClose}>✕</button>
      </div>
      <div className="side-panel-body">
        {versions.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>Sin versiones anteriores. Se crean automáticamente al editar.</p>}
        {versions.map((v) => (
          <div key={v.id} className="version-item">
            <div className="meta">{formatVersionDate(v.created_at)} · {v.size} caracteres</div>
            <div>{v.title}</div>
            <div className="actions">
              <button onClick={() => toggle(v.id)}>{expanded === v.id ? 'Ocultar' : 'Ver contenido'}</button>
              <button onClick={() => restore(v.id)}>↩ Restaurar</button>
            </div>
            {expanded === v.id && <pre>{previewContent}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function NotesView({ noteId, notes, onChanged }: {
  noteId?: number;
  notes: NoteMeta[];
  onChanged: () => void;
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

  return (
    <div className="notes-layout">
      <div className="notes-list">
        <div className="sidebar-heading">Acciones</div>
        <button className="sidebar-item" onClick={openDailyNote}>
          <span className="icon">☀</span><span>Nota diaria de hoy</span>
        </button>
        <button className="sidebar-item" onClick={openTemplates}>
          <span className="icon">📄</span><span>Nueva desde plantilla…</span>
        </button>
        {showTemplates && templates.map((t) => (
          <button key={t.id} className="sidebar-item" style={{ paddingLeft: 24 }}
            onClick={() => createFromTemplate(t.id)}>
            <span className="icon">↳</span><span>{t.name}</span>
          </button>
        ))}

        {tags.length > 0 && (
          <>
            <div className="sidebar-heading">Etiquetas</div>
            <div className="tags-row" style={{ padding: '4px 6px 8px' }}>
              {tags.map((t) => (
                <span key={t.tag}
                  className={`tag-chip ${activeTag === t.tag ? '' : 'inactive'}`}
                  onClick={() => setActiveTag(activeTag === t.tag ? null : t.tag)}>
                  #{t.tag} <span style={{ opacity: 0.7 }}>{t.count}</span>
                </span>
              ))}
            </div>
          </>
        )}

        <div className="sidebar-heading">
          {activeTag ? `Notas con #${activeTag}` : 'Todas las notas'}
        </div>
        {(filteredNotes ?? notes).map((n) => (
          <button key={n.id} className={`sidebar-item ${detail?.note.id === n.id ? 'active' : ''}`}
            onClick={() => navigate(`/notes/${n.id}`)}>
            <span className="icon">◆</span><span>{n.title}</span>
          </button>
        ))}
        {(filteredNotes ?? notes).length === 0 && <div className="palette-empty">Sin notas.</div>}
      </div>

      {detail ? (
        <div className="note-editor">
          <div className="note-toolbar">
            <input className="note-title" value={title}
              onChange={(e) => { setTitle(e.target.value); scheduleSave(e.target.value, content); }} />
            <span className="save-status">
              {saveState === 'saved' ? '✓ Guardado' : saveState === 'saving' ? 'Guardando…' : 'Sin guardar'}
            </span>
            <div className="toggle-group">
              <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>Editar</button>
              <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>Vista previa</button>
            </div>
            <button className="header-btn" onClick={() => setShowHistory(true)} title="Historial de versiones">🕘 Historial</button>
            <button className="header-btn" onClick={saveAsTemplate} title="Guardar como plantilla">📄</button>
            <button className="btn-danger" onClick={removeNote} title="Eliminar nota">🗑</button>
          </div>

          <div className="note-content">
            {mode === 'edit' ? (
              <textarea value={content} placeholder="Escribe en markdown… usa [[Título]] para enlazar otras notas."
                onChange={(e) => { setContent(e.target.value); scheduleSave(title, e.target.value); }} />
            ) : (
              <div className="note-preview" onClick={onPreviewClick}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
            )}
          </div>

          {(detail.backlinks.length > 0 || detail.outgoing.length > 0) && (
            <div className="backlinks-panel">
              {detail.backlinks.length > 0 && (
                <>
                  <h4>← Enlaces entrantes ({detail.backlinks.length})</h4>
                  <div className="chip-row" style={{ marginBottom: 10 }}>
                    {detail.backlinks.map((b, i) => (
                      <span key={i} className="chip" onClick={() => {
                        if (b.source_type === 'note') navigate(`/notes/${b.source_id}`);
                        else if (b.source_type === 'card') alert(`Vinculada desde la tarjeta: ${b.label}`);
                        else if (b.source_type === 'message' && b.channel_id) navigate(`/chat/${b.channel_id}`);
                      }}>
                        <span className="icon">{b.source_type === 'note' ? '◆' : b.source_type === 'card' ? '▦' : '💬'}</span>
                        {(b.label ?? '').slice(0, 50) || '(sin título)'}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {detail.outgoing.length > 0 && (
                <>
                  <h4>→ Enlaces salientes ({detail.outgoing.length})</h4>
                  <div className="chip-row">
                    {detail.outgoing.map((o) => (
                      <span key={o.id} className="chip" onClick={() => navigate(`/notes/${o.id}`)}>
                        <span className="icon">◆</span>{o.title}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="empty-state" style={{ flex: 1 }}>
          <h3>◆ Tus notas</h3>
          <p>Selecciona una nota o crea una nueva desde la barra lateral.</p>
        </div>
      )}
      {showHistory && detail && (
        <VersionHistory noteId={detail.note.id}
          onRestore={() => load(detail.note.id)}
          onClose={() => setShowHistory(false)} />
      )}
    </div>
  );
}
