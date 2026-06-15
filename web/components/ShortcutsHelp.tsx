import { useEffect, useState } from 'react';
import {
  COMMANDS,
  FIXED_SHORTCUTS,
  formatChord,
  getChord,
  setChord,
  resetChord,
  resetAllChords,
  eventToChord,
  useBindings,
} from '../keybindings';

/**
 * Keyboard shortcuts reference and editor. Lists every command with its current
 * chord; click a chord to capture a new one (Esc cancels, Backspace unbinds).
 */
export default function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const bindings = useBindings();
  const [capturing, setCapturing] = useState<string | null>(null);

  // close on Esc only when not capturing (Esc cancels capture instead)
  useEffect(() => {
    if (capturing) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [capturing, onClose]);

  // while capturing, intercept the next chord in the capture phase so it doesn't
  // trigger any other shortcut handler
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setCapturing(null);
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setChord(capturing, '');
        setCapturing(null);
        return;
      }
      const chord = eventToChord(e);
      if (!chord) return; // a lone modifier — keep waiting
      e.preventDefault();
      e.stopImmediatePropagation();
      setChord(capturing, chord);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="max-h-[80vh] w-[480px] max-w-[92vw] overflow-hidden rounded-lg border border-edge bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
          <h2 className="text-sm font-semibold text-gray-200">Keyboard shortcuts</h2>
          <button onClick={onClose} className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200" title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {COMMANDS.map((cmd) => {
            const chord = bindings[cmd.id] ?? '';
            const overridden = chord !== cmd.defaultChord;
            const isCapturing = capturing === cmd.id;
            return (
              <div key={cmd.id} className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-2">
                <span className="min-w-0 flex-1 truncate text-sm text-gray-300">{cmd.label}</span>
                {overridden && !isCapturing && (
                  <button
                    onClick={() => resetChord(cmd.id)}
                    className="shrink-0 rounded px-1 text-xs text-gray-600 opacity-0 hover:text-sky-300 group-hover:opacity-100"
                    title={`Reset to ${formatChord(cmd.defaultChord) || 'unbound'}`}
                  >
                    ↺
                  </button>
                )}
                <button
                  onClick={() => setCapturing(cmd.id)}
                  className={`shrink-0 rounded border px-2 py-0.5 font-mono text-xs ${
                    isCapturing
                      ? 'animate-pulse-subtle border-sky-500 bg-sky-950 text-sky-300'
                      : 'border-edge bg-surface-0 text-gray-300 hover:border-sky-600'
                  }`}
                  title="Click, then press the new shortcut (Esc cancels · Backspace unbinds)"
                >
                  {isCapturing ? 'Press keys…' : formatChord(chord) || 'Unbound'}
                </button>
              </div>
            );
          })}

          <div className="mt-2 border-t border-edge/60 px-2 pt-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Fixed</div>
            {FIXED_SHORTCUTS.map((s) => (
              <div key={s.label} className="flex items-center gap-2 px-0 py-1 text-sm text-gray-400">
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                <span className="shrink-0 rounded border border-edge bg-surface-0 px-2 py-0.5 font-mono text-xs text-gray-500">
                  {s.keys}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-edge px-4 py-2 text-xs text-gray-500">
          <span>Click a shortcut to rebind it.</span>
          <button onClick={resetAllChords} className="rounded px-1.5 py-0.5 hover:text-gray-300">
            Reset all
          </button>
        </div>
      </div>
    </div>
  );
}
