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

export const BG_PRESETS: Record<string, BgPreset> = {
  default: { label: 'Ninguno', css: 'none' },
  aurora: { label: 'Aurora', css: 'radial-gradient(ellipse at top, #1a1f3a 0%, #0c0f16 62%)' },
  nebula: {
    label: 'Nebulosa',
    css: 'radial-gradient(ellipse at 20% 20%, #2a1a3a 0%, transparent 55%), radial-gradient(ellipse at 80% 85%, #142a35 0%, #0c0f16 60%)',
  },
  sunrise: { label: 'Amanecer', css: 'radial-gradient(ellipse at bottom, #3a2415 0%, #0c0f16 65%)' },
  mono: { label: 'Monocromo', css: 'radial-gradient(ellipse at top, #1c1c22 0%, #0c0f16 62%)' },
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
