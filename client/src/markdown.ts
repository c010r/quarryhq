import { marked, Renderer, type Tokens } from 'marked';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isSafeUrl(href: string): boolean {
  const value = href.trim();
  if (value.startsWith('#/') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true;
  try {
    const url = new URL(value, window.location.origin);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol);
  } catch {
    return false;
  }
}

const renderer = new Renderer();
renderer.link = ({ href, title, tokens }: Tokens.Link) => {
  const text = marked.parser(tokens);
  if (!isSafeUrl(href)) return text;
  const safeHref = escapeHtml(href);
  const safeTitle = title ? ` title="${escapeHtml(title)}"` : '';
  const external = /^(https?:)?\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a href="${safeHref}"${safeTitle}${external}>${text}</a>`;
};
// Las imágenes normales siguen deshabilitadas (no se renderiza contenido
// remoto arbitrario), salvo un caso: los embeds insertados por el selector
// de Google Drive (ver googleDrive.ts), reconocidos por URL exacta y con el
// id de archivo validado — nunca se interpola nada sin chequear.
// Los tres tipos (imagen/video/PDF) usan el visor embebido de Drive
// (iframe), no un <img> directo: el hack "uc?export=view" depende de la
// cookie de sesión de Google, que los navegadores bloquean en contexto de
// terceros (subrecurso cross-site) aunque la misma URL funcione navegando
// directo — el iframe del visor de Drive no tiene ese problema.
const DRIVE_PREVIEW_RE = /^https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)\/preview$/;
const DRIVE_EMBED_KINDS = ['image', 'video', 'pdf'];
// El tamaño (si el usuario redimensionó el embed) va en el texto alt, no en
// el título markdown estándar ("...") — ese título no sobrevive al paso por
// escapeHtml (convierte " en &quot; antes de que marked parsee la sintaxis
// de título). El alt es texto plano, así que un prefijo con ":" es seguro.
// Formato: ![kind:anchoxalto:nombre](url). Ver NotesView.tsx, que reescribe
// ese prefijo al soltar el mouse tras un resize.
const DRIVE_SIZE_RE = /^(\d{2,4})x(\d{2,4}):/;

renderer.image = ({ href, text }: Tokens.Image) => {
  const previewMatch = DRIVE_PREVIEW_RE.exec(href);
  const kind = DRIVE_EMBED_KINDS.find((k) => text.startsWith(`${k}:`));
  if (previewMatch && kind) {
    let label = text.slice(kind.length + 1);
    const sizeMatch = DRIVE_SIZE_RE.exec(label);
    const style = sizeMatch ? ` style="width:${sizeMatch[1]}px;height:${sizeMatch[2]}px"` : '';
    if (sizeMatch) label = label.slice(sizeMatch[0].length);
    return `<iframe src="https://drive.google.com/file/d/${previewMatch[1]}/preview" title="${escapeHtml(label)}" data-drive-id="${previewMatch[1]}" data-drive-kind="${kind}" class="drive-embed drive-frame" loading="lazy" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" allow="autoplay"${style}></iframe>`;
  }
  return escapeHtml(text);
};

marked.setOptions({ breaks: true, gfm: true, renderer });

// Convierte [[Título]] en enlaces markdown hacia #/wiki/Título antes de renderizar
function preprocessWikilinks(text: string): string {
  return text.replace(/\[\[([^\[\]]+)\]\]/g, (_m, title: string) =>
    `[${title.trim()}](#/wiki/${encodeURIComponent(title.trim())})`);
}

// Resalta @usuario como una mención. Exige borde de palabra antes del @ para
// no confundir "foo@example.com" con una mención (mismo criterio que el
// servidor). Corre sobre texto ya escapado, así que el username capturado
// (solo [A-Za-z0-9._-]) no puede contener HTML.
function preprocessMentions(text: string): string {
  return text.replace(/(^|\s)@([a-zA-Z0-9._-]{2,32})/g, (_m, pre: string, username: string) =>
    `${pre}<span class="mention">@${username}</span>`);
}

export function renderMarkdown(source: string): string {
  return marked.parse(preprocessMentions(preprocessWikilinks(escapeHtml(source)))) as string;
}

export function renderInlineMarkdown(source: string): string {
  return marked.parseInline(preprocessMentions(preprocessWikilinks(escapeHtml(source)))) as string;
}
