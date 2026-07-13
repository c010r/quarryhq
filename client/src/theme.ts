import type { User } from './types';

export interface ThemePreset { label: string; accent: string; board: string; note: string; chat: string }

export const THEME_PRESETS: Record<string, ThemePreset> = {
  default: { label: 'QuarryHQ', accent: '#8b93f8', board: '#e9a23b', note: '#b18cfa', chat: '#3ecfb2' },
  ocean: { label: 'Océano', accent: '#38bdf8', board: '#22d3ee', note: '#60a5fa', chat: '#2dd4bf' },
  sunset: { label: 'Atardecer', accent: '#fb923c', board: '#f97316', note: '#fb7185', chat: '#fbbf24' },
  forest: { label: 'Bosque', accent: '#4ade80', board: '#a3e635', note: '#34d399', chat: '#22c55e' },
  rose: { label: 'Rosa', accent: '#f472b6', board: '#fb7185', note: '#e879f9', chat: '#f9a8d4' },
};

export interface BgPreset { label: string; css: string }

// Fotos reales de Unsplash (unsplash.com/license: uso libre, sin necesidad de
// atribución). Serví siempre vía su CDN con w/q recortados para no pesar.
const unsplash = (id: string) => `url("https://images.unsplash.com/${id}?auto=format&fit=crop&w=1600&q=60")`;

export const BG_PRESETS: Record<string, BgPreset> = {
  default: { label: 'Ninguno', css: 'none' },
  mono: { label: 'Monocromo', css: 'radial-gradient(ellipse at top, #1c1c22 0%, #0c0f16 62%)' },
  mountains: { label: 'Montañas', css: unsplash('photo-1506905925346-21bda4d32df4') },
  forest: { label: 'Sendero', css: unsplash('photo-1441974231531-c6227db76b6e') },
  aurora: { label: 'Aurora', css: unsplash('photo-1519681393784-d120267933ba') },
  nebula: { label: 'Nebulosa', css: unsplash('photo-1502134249126-9f3755a50d78') },
  earth: { label: 'Tierra', css: unsplash('photo-1451187580459-43490279c0fa') },
};

// Aplica la estética guardada del usuario pisando las custom properties en
// :root; si no es Premium (o no hay usuario), todo vuelve al look por defecto.
export function applyTheme(user: User | null) {
  const root = document.documentElement.style;
  const isPremium = user?.plan === 'premium';
  const presetKey = isPremium ? (user?.theme_preset ?? 'default') : 'default';
  const preset = THEME_PRESETS[presetKey] ?? THEME_PRESETS.default;
  const accent = isPremium && presetKey === 'custom' && user?.theme_accent ? user.theme_accent : preset.accent;

  root.setProperty('--color-accent', accent);
  root.setProperty('--color-board', preset.board);
  root.setProperty('--color-note', preset.note);
  root.setProperty('--color-chat', preset.chat);

  const bg = isPremium ? user?.theme_bg : null;
  let bgCss = 'none';
  if (bg) {
    bgCss = bg.startsWith('https://') ? `url("${bg.replace(/["\\]/g, '')}")` : (BG_PRESETS[bg]?.css ?? 'none');
  }
  root.setProperty('--bg-image', bgCss);
}
