import { useEffect, useRef, useState } from 'react';

/** Toolbar dropdown for choosing which fields appear as columns in the grid view. */
export default function ColumnsMenu({
  fieldNames,
  columns,
  onChange,
}: {
  fieldNames: { key: string; count: number }[];
  columns: string[];
  onChange: (cols: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selected = new Set(columns);
  const toggle = (key: string): void =>
    onChange(selected.has(key) ? columns.filter((c) => c !== key) : [...columns, key]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-sm ${
          open ? 'bg-surface-3 text-sky-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
        }`}
        title="Choose grid columns"
      >
        Columns {columns.length > 0 && <span className="text-xs">{columns.length}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-edge bg-surface-2 shadow-2xl">
          <div className="max-h-[60vh] overflow-y-auto p-1">
            {fieldNames.length === 0 ? (
              <div className="px-2 py-2 text-xs text-gray-600">No structured fields in this file.</div>
            ) : (
              fieldNames.map((f) => (
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
        </div>
      )}
    </div>
  );
}
