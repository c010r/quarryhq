import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
