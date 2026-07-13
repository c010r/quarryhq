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
renderer.image = ({ text }: Tokens.Image) => escapeHtml(text);

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
