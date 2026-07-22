import { useState } from 'react';
import { patch, notifyPlanBlock } from '../api';
import type { User } from '../types';
import { THEME_PRESETS, BG_PRESETS } from '../theme';
import { btnGhost, btnSmall, inputBase, modalBackdrop, modalBox, modalClose, sectionTitle } from '../ui';
import { alertDialog } from '../dialog';
import { type ColorMode, getEffectiveMode, setColorMode } from '../colorMode';
import { useModalA11y } from '../useModalA11y';

const LOCK_MSG = 'La estética personalizada del escritorio es exclusiva de Premium.';

export default function AppearanceModal({ user, isPremium, onChanged, onClose }: {
  user: User;
  isPremium: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const containerRef = useModalA11y(onClose);
  const [busy, setBusy] = useState(false);
  const [customAccent, setCustomAccent] = useState(user.theme_accent ?? '#8b93f8');
  const [bgUrl, setBgUrl] = useState(user.theme_bg?.startsWith('https://') ? user.theme_bg : '');
  const [colorMode, setColorModeState] = useState<ColorMode>(getEffectiveMode());

  function pickColorMode(mode: ColorMode) {
    setColorMode(mode);
    setColorModeState(mode);
  }

  const currentPreset = user.theme_preset ?? 'default';
  const currentBg = user.theme_bg ?? 'default';
  const bgIsCustomUrl = currentBg.startsWith('https://');

  async function save(fields: { preset?: string; accent?: string; bg?: string }) {
    if (!isPremium) { notifyPlanBlock(LOCK_MSG); return; }
    setBusy(true);
    try {
      await patch('/api/me/theme', {
        preset: fields.preset ?? currentPreset,
        accent: fields.accent ?? (currentPreset === 'custom' ? customAccent : undefined),
        bg: fields.bg ?? currentBg,
      });
      onChanged();
    } catch (err: any) {
      alertDialog(err.message);
    } finally { setBusy(false); }
  }

  const swatchBase = 'flex flex-col items-center gap-1.5 rounded-xl border p-2.5 text-[11.5px] transition-colors';
  const swatchActive = (active: boolean) => `${swatchBase} ${active ? 'border-accent bg-accent/10' : 'border-edge bg-panel hover:border-accent/50'}`;

  return (
    <div ref={containerRef} className={modalBackdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${modalBox} max-w-[480px]`}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold">🎨 Apariencia{!isPremium && ' 🔒'}</h3>
          <button className={modalClose} aria-label="Cerrar" onClick={onClose}>✕</button>
        </div>
        <div>
          <h4 className={sectionTitle}>Modo de la interfaz</h4>
          <div className="flex gap-2" role="radiogroup" aria-label="Modo de la interfaz">
            <button className={swatchActive(colorMode === 'light')} style={{ flex: 1 }} role="radio"
              aria-checked={colorMode === 'light'} aria-pressed={colorMode === 'light'}
              onClick={() => pickColorMode('light')}>
              ☀️ Claro
            </button>
            <button className={swatchActive(colorMode === 'dark')} style={{ flex: 1 }} role="radio"
              aria-checked={colorMode === 'dark'} aria-pressed={colorMode === 'dark'}
              onClick={() => pickColorMode('dark')}>
              🌙 Oscuro
            </button>
          </div>
        </div>

        {!isPremium && (
          <p className="text-[13px] text-dim">Personalizar la paleta y el fondo del escritorio es exclusivo de Premium.</p>
        )}

        <div>
          <h4 className={sectionTitle}>Paleta de colores</h4>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" role="radiogroup" aria-label="Paleta de colores">
            {Object.entries(THEME_PRESETS).map(([key, p]) => (
              <button key={key} disabled={busy} className={swatchActive(currentPreset === key)} role="radio"
                aria-checked={currentPreset === key} aria-pressed={currentPreset === key}
                aria-label={`Paleta ${p.label}`}
                onClick={() => save({ preset: key })}>
                <span className="flex gap-1" aria-hidden>
                  <span className="h-3 w-3 rounded-full" style={{ background: p.accent }} />
                  <span className="h-3 w-3 rounded-full" style={{ background: p.board }} />
                  <span className="h-3 w-3 rounded-full" style={{ background: p.note }} />
                  <span className="h-3 w-3 rounded-full" style={{ background: p.chat }} />
                </span>
                {p.label}
              </button>
            ))}
            <button disabled={busy} className={swatchActive(currentPreset === 'custom')} role="radio"
              aria-checked={currentPreset === 'custom'} aria-pressed={currentPreset === 'custom'}
              onClick={() => save({ preset: 'custom', accent: customAccent })}>
              <span className="h-3 w-3 rounded-full border border-dim" style={{ background: customAccent }} aria-hidden />
              Personalizado
            </button>
          </div>
          {currentPreset === 'custom' && (
            <div className="mt-2.5 flex items-center gap-2">
              <label className="flex items-center gap-2 text-[12px] text-dim">
                <span className="sr-only">Color de acento personalizado</span>
                <input type="color" value={customAccent}
                  onChange={(e) => setCustomAccent(e.target.value)}
                  onBlur={() => save({ preset: 'custom', accent: customAccent })}
                  disabled={!isPremium || busy}
                  className="h-8 w-12 cursor-pointer rounded border border-edge bg-transparent" />
                Elegí tu color de acento
              </label>
            </div>
          )}
        </div>

        <div>
          <h4 className={sectionTitle}>Fondo de escritorio</h4>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Fondo de escritorio">
            {Object.entries(BG_PRESETS).map(([key, b]) => (
              <button key={key} disabled={busy} className={swatchActive(!bgIsCustomUrl && currentBg === key)} role="radio"
                aria-checked={!bgIsCustomUrl && currentBg === key} aria-pressed={!bgIsCustomUrl && currentBg === key}
                aria-label={`Fondo: ${b.label}`}
                onClick={() => save({ bg: key })}>
                <span className="h-8 w-full rounded-md border border-edge" style={{ backgroundImage: b.css, backgroundSize: 'cover' }} aria-hidden />
                {b.label}
              </button>
            ))}
          </div>
          <div className="mt-2.5 flex gap-2">
            <label className="sr-only" htmlFor="appearance-bg-url">URL de imagen de fondo personalizada</label>
            <input id="appearance-bg-url" value={bgUrl} onChange={(e) => setBgUrl(e.target.value)}
              placeholder="https://… imagen personalizada"
              className={`${inputBase} min-w-0 flex-1 py-1.5 text-[13px]`} />
            <button className={btnSmall} disabled={busy || !bgUrl.trim()}
              onClick={() => {
                const url = bgUrl.trim();
                if (!url.startsWith('https://')) { alertDialog('La imagen de fondo debe ser una URL https://'); return; }
                save({ bg: url });
              }}>
              Aplicar
            </button>
          </div>
        </div>

        <div className="flex justify-end">
          <button className={btnGhost} onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
