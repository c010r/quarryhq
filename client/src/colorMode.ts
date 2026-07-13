// Modo claro/oscuro: preferencia de dispositivo (no de cuenta), guardada en
// localStorage. Si el usuario nunca lo tocó, seguimos prefers-color-scheme.
export type ColorMode = 'light' | 'dark';

const KEY = 'qhq_color_mode';

export function getStoredMode(): ColorMode | null {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

export function getSystemMode(): ColorMode {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function getEffectiveMode(): ColorMode {
  return getStoredMode() ?? getSystemMode();
}

function applyMode(mode: ColorMode) {
  document.documentElement.setAttribute('data-theme', mode);
}

// mode = null vuelve a seguir la preferencia del sistema.
export function setColorMode(mode: ColorMode | null) {
  if (mode) localStorage.setItem(KEY, mode);
  else localStorage.removeItem(KEY);
  applyMode(mode ?? getSystemMode());
}

// Si el usuario no fijó una preferencia explícita, seguimos los cambios en
// vivo del sistema operativo (p. ej. modo oscuro automático al anochecer).
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (!getStoredMode()) applyMode(getSystemMode());
});
