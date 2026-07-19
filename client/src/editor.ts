// Utilidades del editor de notas: comandos slash, chuleta markdown y
// posicionamiento del caret dentro del textarea.

export interface MdCommand {
  id: string;
  icon: string;
  label: string;
  hint: string;      // sintaxis mostrada a la derecha
  keywords: string;  // términos extra para filtrar
  snippet: string;   // texto a insertar; $0 marca dónde queda el cursor
}

export const MD_COMMANDS: MdCommand[] = [
  { id: 'h1', icon: 'H1', label: 'Encabezado 1', hint: '# Título', keywords: 'titulo heading h1', snippet: '# $0' },
  { id: 'h2', icon: 'H2', label: 'Encabezado 2', hint: '## Título', keywords: 'subtitulo heading h2', snippet: '## $0' },
  { id: 'h3', icon: 'H3', label: 'Encabezado 3', hint: '### Título', keywords: 'heading h3', snippet: '### $0' },
  { id: 'bold', icon: 'B', label: 'Negrita', hint: '**texto**', keywords: 'bold negrita', snippet: '**$0**' },
  { id: 'italic', icon: 'I', label: 'Cursiva', hint: '*texto*', keywords: 'italic cursiva', snippet: '*$0*' },
  { id: 'list', icon: '•', label: 'Lista', hint: '- elemento', keywords: 'lista bullet ul', snippet: '- $0' },
  { id: 'olist', icon: '1.', label: 'Lista numerada', hint: '1. elemento', keywords: 'numerada ordenada ol', snippet: '1. $0' },
  { id: 'todo', icon: '☐', label: 'Tarea', hint: '- [ ] pendiente', keywords: 'tarea todo checkbox', snippet: '- [ ] $0' },
  { id: 'quote', icon: '❝', label: 'Cita', hint: '> cita', keywords: 'cita quote blockquote', snippet: '> $0' },
  { id: 'code', icon: '‹›', label: 'Código en línea', hint: '`código`', keywords: 'codigo inline code', snippet: '`$0`' },
  { id: 'codeblock', icon: '▤', label: 'Bloque de código', hint: '```…```', keywords: 'codigo bloque fence', snippet: '```\n$0\n```' },
  { id: 'table', icon: '▦', label: 'Tabla', hint: '| a | b |', keywords: 'tabla table', snippet: '| Columna 1 | Columna 2 |\n| --- | --- |\n| $0 |  |' },
  { id: 'divider', icon: '—', label: 'Divisor', hint: '---', keywords: 'divisor separador hr', snippet: '---\n$0' },
  { id: 'link', icon: '🔗', label: 'Enlace web', hint: '[texto](url)', keywords: 'enlace link url', snippet: '[$0](https://)' },
  { id: 'wikilink', icon: '◆', label: 'Vincular nota', hint: '[[Título]]', keywords: 'nota wikilink vincular', snippet: '[[$0]]' },
  { id: 'tag', icon: '#', label: 'Etiqueta', hint: '#etiqueta', keywords: 'tag etiqueta', snippet: '#$0' },
];

export interface CheatEntry { syntax: string; desc: string }
export interface CheatSection { title: string; entries: CheatEntry[] }

export const MD_CHEATSHEET: CheatSection[] = [
  {
    title: 'Formato de texto',
    entries: [
      { syntax: '**negrita**', desc: 'Texto en negrita' },
      { syntax: '*cursiva*', desc: 'Texto en cursiva' },
      { syntax: '~~tachado~~', desc: 'Texto tachado' },
      { syntax: '`código`', desc: 'Código en línea' },
    ],
  },
  {
    title: 'Bloques',
    entries: [
      { syntax: '# ## ###', desc: 'Encabezados de nivel 1 a 3' },
      { syntax: '- elemento', desc: 'Lista con viñetas' },
      { syntax: '1. elemento', desc: 'Lista numerada' },
      { syntax: '- [ ] tarea', desc: 'Casilla de tarea' },
      { syntax: '> cita', desc: 'Cita en bloque' },
      { syntax: '```', desc: 'Bloque de código (abre y cierra)' },
      { syntax: '| a | b |', desc: 'Tabla (separa cabecera con | --- |)' },
      { syntax: '---', desc: 'Línea divisoria' },
    ],
  },
  {
    title: 'Vínculos QuarryHQ',
    entries: [
      { syntax: '[[Título]]', desc: 'Enlaza otra nota (se crea si no existe)' },
      { syntax: '#etiqueta', desc: 'Etiqueta la nota; filtra desde la barra lateral' },
      { syntax: '[texto](url)', desc: 'Enlace web externo' },
    ],
  },
  {
    title: 'Atajos del editor',
    entries: [
      { syntax: '/', desc: 'Menú de comandos al inicio de línea' },
      { syntax: '[[', desc: 'Autocompletar títulos de notas' },
      { syntax: 'Ctrl B / I / E', desc: 'Negrita, cursiva, código' },
      { syntax: 'Ctrl K', desc: 'Búsqueda global' },
    ],
  },
];

// Menú contextual activo en el textarea
export interface EditorMenu {
  type: 'slash' | 'wiki';
  query: string;
  start: number; // índice donde empieza el disparador ("/" o "[[")
}

// Detecta si el texto antes del caret abre un menú de comandos o de wikilinks
export function detectMenu(text: string, caret: number): EditorMenu | null {
  const before = text.slice(0, caret);
  const wiki = before.match(/\[\[([^\[\]\n]*)$/);
  if (wiki) return { type: 'wiki', query: wiki[1], start: caret - wiki[1].length - 2 };
  const slash = before.match(/(?:^|\n)\/([\wáéíóúñ]*)$/i);
  if (slash) return { type: 'slash', query: slash[1], start: caret - slash[1].length - 1 };
  return null;
}

// Coordenadas del caret dentro del textarea (técnica del div espejo)
export function getCaretCoords(ta: HTMLTextAreaElement, pos: number): { top: number; left: number } {
  const mirror = document.createElement('div');
  const style = getComputedStyle(ta);
  for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderWidth', 'boxSizing'] as const) {
    mirror.style[prop] = style[prop];
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.width = ta.clientWidth + 'px';
  mirror.textContent = ta.value.slice(0, pos);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const coords = { top: marker.offsetTop - ta.scrollTop, left: marker.offsetLeft - ta.scrollLeft };
  document.body.removeChild(mirror);
  return coords;
}
