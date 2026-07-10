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

export function renderMarkdown(source: string): string {
  return marked.parse(preprocessWikilinks(escapeHtml(source))) as string;
}

export function renderInlineMarkdown(source: string): string {
  return marked.parseInline(preprocessWikilinks(escapeHtml(source))) as string;
}
