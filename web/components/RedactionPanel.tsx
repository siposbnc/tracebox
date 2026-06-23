import { useMemo, useState } from 'react';
import { useEscapeKey } from '../escStack';
import {
  CATEGORIES,
  type CustomPattern,
  getCustomPatterns,
  getRedactor,
  isCategoryEnabled,
  setCategoryEnabled,
  setCustomPatterns,
  setRedactOn,
  useRedactionVersion,
  useRedactOn,
  validateCustomPattern,
} from '../redaction';

const SAMPLE = 'user alice@example.com from 10.0.0.5 token=eyJ.aaa.bbb card 4111 1111 1111 1111';

function newId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Configure redaction: the master switch, per-category toggles for the built-in
 * patterns, and user-defined custom patterns. A preview box shows the combined
 * masking applied to a sample line.
 */
export default function RedactionPanel({ onClose }: { onClose: () => void }) {
  useEscapeKey(onClose, 'modal');
  const on = useRedactOn();
  useRedactionVersion(); // re-render on any category/custom change

  const customs = getCustomPatterns();
  const [label, setLabel] = useState('');
  const [pattern, setPattern] = useState('');
  const [sample, setSample] = useState(SAMPLE);

  const addError = label === '' && pattern === '' ? null : validateCustomPattern(label, pattern);
  const preview = useMemo(() => getRedactor()(sample), [sample, on, customs]);

  const addCustom = (): void => {
    if (addError || pattern === '') return;
    setCustomPatterns([...customs, { id: newId(), label: label.trim(), pattern, enabled: true }]);
    setLabel('');
    setPattern('');
  };
  const updateCustom = (id: string, patch: Partial<CustomPattern>): void =>
    setCustomPatterns(customs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const removeCustom = (id: string): void => setCustomPatterns(customs.filter((c) => c.id !== id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-edge bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
          <h2 className="text-sm font-semibold text-gray-200">Redaction</h2>
          <button onClick={onClose} className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200" title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-3 text-xs text-gray-500">
            Mask sensitive values in the view, screenshots, reports, and exports. Search and all
            analysis keep running on the real data — only what's shown or exported is masked.
          </p>

          <label className="mb-3 flex items-center justify-between rounded-md border border-edge bg-surface-0 px-3 py-2">
            <span className="text-sm text-gray-200">Enable redaction</span>
            <button
              role="switch"
              aria-checked={on}
              onClick={() => setRedactOn(!on)}
              className={`relative h-5 w-9 rounded-full transition-colors ${on ? 'bg-sky-600' : 'bg-surface-3'}`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : 'translate-x-0'}`}
              />
            </button>
          </label>

          {/* Built-in categories */}
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Built-in patterns</h3>
          <div className={`mb-4 space-y-0.5 ${on ? '' : 'pointer-events-none opacity-50'}`}>
            {CATEGORIES.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1 hover:bg-surface-2">
                <input
                  type="checkbox"
                  checked={isCategoryEnabled(c.id)}
                  onChange={(e) => setCategoryEnabled(c.id, e.target.checked)}
                  className="accent-sky-600"
                />
                <span className="w-28 shrink-0 text-sm text-gray-200">{c.label}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-gray-500" title={c.hint}>
                  {c.hint}
                </span>
              </label>
            ))}
          </div>

          {/* Custom patterns */}
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Custom patterns</h3>
          <div className={`space-y-1 ${on ? '' : 'pointer-events-none opacity-50'}`}>
            {customs.map((c) => (
              <div key={c.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-2">
                <input
                  type="checkbox"
                  checked={c.enabled}
                  onChange={(e) => updateCustom(c.id, { enabled: e.target.checked })}
                  className="accent-sky-600"
                />
                <span className="w-28 shrink-0 truncate text-sm text-gray-200" title={c.label}>
                  {c.label || <span className="text-gray-500">redacted</span>}
                </span>
                <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-sky-300" title={c.pattern}>
                  {c.pattern}
                </code>
                <button
                  onClick={() => removeCustom(c.id)}
                  className="shrink-0 rounded px-1 text-gray-500 hover:text-red-300"
                  title="Remove pattern"
                >
                  ×
                </button>
              </div>
            ))}
            {/* add row */}
            <div className="mt-1 flex items-start gap-2 rounded-md border border-edge bg-surface-0 p-2">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex gap-2">
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="label (e.g. userid)"
                    spellCheck={false}
                    className="w-32 shrink-0 rounded border border-edge bg-surface-1 px-2 py-1 text-xs text-gray-200 placeholder:text-gray-600 focus:border-sky-700 focus:outline-none"
                  />
                  <input
                    value={pattern}
                    onChange={(e) => setPattern(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addCustom()}
                    placeholder="regex, e.g. cust_[0-9]+"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded border border-edge bg-surface-1 px-2 py-1 font-mono text-xs text-gray-200 placeholder:font-sans placeholder:text-gray-600 focus:border-sky-700 focus:outline-none"
                  />
                </div>
                {addError && <div className="px-0.5 text-[11px] text-red-400">{addError}</div>}
              </div>
              <button
                onClick={addCustom}
                disabled={!!addError || pattern === ''}
                className="shrink-0 rounded bg-sky-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-40"
              >
                Add
              </button>
            </div>
          </div>

          {/* Preview */}
          <h3 className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Preview</h3>
          <input
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            spellCheck={false}
            className="w-full rounded border border-edge bg-surface-0 px-2 py-1 font-mono text-xs text-gray-300 focus:border-sky-700 focus:outline-none"
          />
          <div className="mt-1 break-all rounded border border-edge bg-surface-0 px-2 py-1 font-mono text-xs text-emerald-300">
            {on ? preview : <span className="text-gray-500">redaction is off</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
