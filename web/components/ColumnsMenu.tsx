import { useEffect, useMemo, useRef, useState } from 'react';
import { type Capture, validateCapture, extractValue } from '../captures';
import { BUILTIN_COLS, LINE_COL, TIME_COL, addColumn } from '../columns';

/** Friendly labels for the built-in (non-field) columns in the picker. */
const BUILTIN_LABEL: Record<string, string> = {
  [LINE_COL]: 'Line number',
  [TIME_COL]: 'Time',
};
const builtinLabel = (c: string): string => BUILTIN_LABEL[c] ?? 'Level';

/** The inline "+ Add capture" form. Validates name + regex and previews the value. */
function AddCaptureForm({
  sampleText,
  onAdd,
  onCancel,
}: {
  sampleText?: string;
  onAdd: (cap: Capture) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const cap = { name: name.trim(), pattern };
  const error = name.trim() === '' && pattern === '' ? null : validateCapture(cap);

  // live preview: what the capture would extract from a sample line
  const preview = useMemo(() => {
    if (error || pattern === '' || !sampleText) return undefined;
    try {
      return extractValue(new RegExp(pattern), cap.name, sampleText);
    } catch {
      return undefined;
    }
  }, [error, pattern, cap.name, sampleText]);

  const submit = (): void => {
    if (error || name.trim() === '' || pattern === '') return;
    onAdd(cap);
  };

  return (
    <div className="space-y-1.5 border-b border-edge p-1.5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="field name (e.g. dur)"
        spellCheck={false}
        autoFocus
        className="w-full rounded border border-edge bg-surface-0 px-2 py-1 font-mono text-xs text-gray-200 placeholder:font-sans placeholder:text-gray-600 focus:border-sky-700 focus:outline-none"
      />
      <input
        value={pattern}
        onChange={(e) => setPattern(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="regex, e.g. (?<dur>\d+)ms"
        spellCheck={false}
        className="w-full rounded border border-edge bg-surface-0 px-2 py-1 font-mono text-xs text-gray-200 placeholder:font-sans placeholder:text-gray-600 focus:border-sky-700 focus:outline-none"
      />
      {error ? (
        <div className="px-0.5 text-[11px] text-red-400">{error}</div>
      ) : (
        sampleText &&
        pattern !== '' && (
          <div className="truncate px-0.5 text-[11px] text-gray-500" title={sampleText}>
            {preview !== undefined ? (
              <>
                sample → <span className="font-mono text-emerald-400">{preview}</span>
              </>
            ) : (
              <span className="text-gray-600">no match on the first row</span>
            )}
          </div>
        )
      )}
      <div className="flex justify-end gap-1.5">
        <button onClick={onCancel} className="rounded px-2 py-0.5 text-xs text-gray-400 hover:text-gray-100">
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!!error || name.trim() === '' || pattern === ''}
          className="rounded bg-sky-700 px-2 py-0.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}

/** Toolbar dropdown for choosing grid columns and defining ad-hoc capture fields. */
export default function ColumnsMenu({
  fieldNames,
  columns,
  onChange,
  captures,
  onUpsertCapture,
  onRemoveCapture,
  sampleText,
}: {
  fieldNames: { key: string; count: number }[];
  columns: string[];
  onChange: (cols: string[]) => void;
  captures: Capture[];
  onUpsertCapture: (cap: Capture) => void;
  onRemoveCapture: (name: string) => void;
  sampleText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setAdding(false);
      return;
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selected = new Set(columns);
  const toggle = (key: string): void =>
    onChange(selected.has(key) ? columns.filter((c) => c !== key) : addColumn(columns, key));

  // sorted A→Z, then filtered by the search box
  const q = query.toLowerCase().trim();
  const shown = useMemo(
    () =>
      [...fieldNames]
        .sort((a, b) => a.key.localeCompare(b.key))
        .filter((f) => q === '' || f.key.toLowerCase().includes(q)),
    [fieldNames, q],
  );

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-sm ${
          open ? 'bg-surface-3 text-sky-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
        }`}
        title="Choose grid columns and define capture fields"
      >
        Columns {columns.length > 0 && <span className="text-xs">{columns.length}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-edge bg-surface-2 shadow-2xl">
          {/* Built-in columns: line number, time, level — hideable and (in the grid
              header) drag-reorderable like any data column */}
          <div className="border-b border-edge px-2 py-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Built-in columns</div>
            <div className="mt-1 space-y-0.5">
              {BUILTIN_COLS.map((c) => (
                <label key={c} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-3">
                  <input
                    type="checkbox"
                    checked={selected.has(c)}
                    onChange={() => toggle(c)}
                    className="accent-sky-600"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-gray-200">{builtinLabel(c)}</span>
                </label>
              ))}
            </div>
          </div>
          {/* Captures section */}
          <div className="border-b border-edge px-2 py-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Capture fields</span>
              {!adding && (
                <button onClick={() => setAdding(true)} className="text-xs text-sky-300 hover:text-sky-200">
                  + Add
                </button>
              )}
            </div>
            {captures.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {captures.map((c) => (
                  <div key={c.name} className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-3">
                    <input
                      type="checkbox"
                      checked={selected.has(c.name)}
                      onChange={() => toggle(c.name)}
                      className="accent-sky-600"
                      title="Show as a column"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-sky-300" title={c.pattern}>
                      {c.name}
                    </span>
                    <button
                      onClick={() => onRemoveCapture(c.name)}
                      className="shrink-0 text-gray-600 opacity-0 hover:text-red-400 group-hover:opacity-100"
                      title="Remove capture"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {captures.length === 0 && !adding && (
              <div className="mt-0.5 text-[11px] text-gray-600">
                Extract a value with a regex (e.g. <span className="font-mono">{'(?<dur>\\d+)ms'}</span>) to filter,
                facet, and column on it.
              </div>
            )}
          </div>
          {adding && (
            <AddCaptureForm
              sampleText={sampleText}
              onCancel={() => setAdding(false)}
              onAdd={(cap) => {
                onUpsertCapture(cap);
                if (!selected.has(cap.name)) onChange([...columns, cap.name]);
                setAdding(false);
              }}
            />
          )}

          {/* Detected fields */}
          {fieldNames.length === 0 ? (
            <div className="px-2 py-2 text-xs text-gray-600">No structured fields in this file.</div>
          ) : (
            <>
              <div className="border-b border-edge p-1.5">
                <div className="relative">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter fields…"
                    spellCheck={false}
                    className="w-full rounded border border-edge bg-surface-0 py-1 pl-2 pr-6 text-xs text-gray-200 placeholder:text-gray-600 focus:border-sky-700 focus:outline-none"
                  />
                  {query && (
                    <button
                      onClick={() => setQuery('')}
                      className="absolute inset-y-0 right-1 px-1 text-gray-500 hover:text-gray-300"
                      title="Clear"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
              <div className="max-h-[50vh] overflow-y-auto p-1">
                {shown.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-gray-600">No fields match.</div>
                ) : (
                  shown.map((f) => (
                    <label
                      key={f.key}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-surface-3"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(f.key)}
                        onChange={() => toggle(f.key)}
                        className="accent-sky-600"
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-200" title={f.key}>
                        {f.key}
                      </span>
                      <span className="shrink-0 text-[10px] text-gray-500">{f.count.toLocaleString()}</span>
                    </label>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
