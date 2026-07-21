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
// El tamaño va en el texto alt, no en el título markdown estándar ("...") —
// ese título no sobrevive al paso por escapeHtml (convierte " en &quot;
// antes de que marked parsee la sintaxis de título). El alt es texto
// plano, así que un prefijo con ":" es seguro.
// Formato: ![kind:N:nombre](url), N de 1 a 4 = 25/50/75/100% del ancho.
// Un dígito discreto en vez de arrastrar y guardar píxeles exactos: más
// simple de leer/escribir a mano y sin los líos de un resize nativo sobre
// un <iframe> de otro origen (scrollbar tapando el handle, el documento de
// adentro quedándose con el mousedown, etc.)
const DRIVE_SIZE_RE = /^([1-4]):/;
const DRIVE_SIZE_STEPS = [25, 50, 75, 100];

renderer.image = ({ href, text }: Tokens.Image) => {
  const previewMatch = DRIVE_PREVIEW_RE.exec(href);
  const kind = DRIVE_EMBED_KINDS.find((k) => text.startsWith(`${k}:`));
  if (previewMatch && kind) {
    let label = text.slice(kind.length + 1);
    const sizeMatch = DRIVE_SIZE_RE.exec(label);
    const step = sizeMatch ? Number(sizeMatch[1]) : 4;
    if (sizeMatch) label = label.slice(sizeMatch[0].length);
    const id = previewMatch[1];
    const controls = [1, 2, 3, 4].map((n) =>
      `<button type="button" data-drive-size="${n}" class="drive-size-btn${n === step ? ' active' : ''}">${DRIVE_SIZE_STEPS[n - 1]}%</button>`).join('');
    return `<div data-drive-id="${id}" data-drive-kind="${kind}" class="drive-embed drive-frame" style="width:${DRIVE_SIZE_STEPS[step - 1]}%"><iframe src="https://drive.google.com/file/d/${id}/preview" title="${escapeHtml(label)}" class="drive-frame-inner" loading="lazy" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" allow="autoplay"></iframe><div class="drive-size-controls">${controls}</div></div>`;
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
