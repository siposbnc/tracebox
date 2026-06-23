import { useState } from 'react';
import { ViewButton } from './ValueViewer';

/**
 * Collapsible, syntax-highlighted JSON viewer for the detail panel. Leaf paths
 * follow the backend's flattening convention (`a.b`, `a[0].b`) so the per-leaf
 * "+filter" produces clauses that match the indexed field names.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isContainer(v: Json): v is Json[] | { [k: string]: Json } {
  return v !== null && typeof v === 'object';
}

function Leaf({ value, redact }: { value: null | boolean | number | string; redact: (s: string) => string }) {
  if (value === null) return <span className="italic text-gray-500">null</span>;
  if (typeof value === 'string') return <span className="text-emerald-300">&quot;{redact(value)}&quot;</span>;
  if (typeof value === 'number') return <span className="text-amber-300">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="text-fuchsia-300">{String(value)}</span>;
  return <span className="text-gray-300">{String(value)}</span>;
}

function JsonNode({
  name,
  value,
  path,
  depth,
  onFilter,
  onView,
  redact,
}: {
  /** Key (object) or index label like `[0]` (array); absent for the root. */
  name?: string;
  value: Json;
  path: string;
  depth: number;
  onFilter?: (path: string, value: string) => void;
  onView?: (label: string, value: string) => void;
  redact: (s: string) => string;
}) {
  const [open, setOpen] = useState(depth < 2);

  const key =
    name !== undefined ? (
      <span className={name.startsWith('[') ? 'text-gray-500' : 'text-sky-400'}>{name}</span>
    ) : null;

  if (!isContainer(value)) {
    return (
      <div className="group flex items-start gap-1 leading-5">
        {key}
        {key && <span className="text-gray-600">:</span>}
        <span className="break-all">
          <Leaf value={value} redact={redact} />
        </span>
        {onView && typeof value === 'string' && value.length > 0 && (
          <ViewButton onClick={() => onView(path || name || 'value', value)} />
        )}
        {onFilter && path && (
          <button
            className="ml-1 rounded bg-surface-2 px-1 text-[10px] text-gray-500 opacity-0 transition-opacity hover:text-sky-300 group-hover:opacity-100"
            title={`Filter: ${path}:${value}`}
            onClick={() => onFilter(path, String(value))}
          >
            +filter
          </button>
        )}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string, Json][] = isArray
    ? (value as Json[]).map((v, i) => [`[${i}]`, v])
    : Object.entries(value as { [k: string]: Json });
  const childPath = (label: string): string => (isArray ? `${path}${label}` : path ? `${path}.${label}` : label);
  const [open0, close0] = isArray ? ['[', ']'] : ['{', '}'];

  return (
    <div className="leading-5">
      <div className="flex items-center gap-1">
        <button
          onClick={() => setOpen((o) => !o)}
          className="-ml-3 w-3 shrink-0 text-gray-500 hover:text-gray-300"
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? '▾' : '▸'}
        </button>
        {key}
        {key && <span className="text-gray-600">:</span>}
        <span className="text-gray-600">{open0}</span>
        {!open && (
          <button onClick={() => setOpen(true)} className="text-gray-500 hover:text-gray-300">
            <span className="text-gray-600">…{close0}</span>
            <span className="ml-1 text-[10px] text-gray-600">{entries.length}</span>
          </button>
        )}
      </div>
      {open && (
        <>
          <div className="border-l border-edge/40 pl-4">
            {entries.map(([label, v]) => (
              <JsonNode
                key={label}
                name={label}
                value={v}
                path={childPath(label)}
                depth={depth + 1}
                onFilter={onFilter}
                onView={onView}
                redact={redact}
              />
            ))}
          </div>
          <div className="text-gray-600">{close0}</div>
        </>
      )}
    </div>
  );
}

/** Parse `text` as a JSON object/array, or null if it isn't one. */
export function tryParseJson(text: string): Json | null {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try {
    const v = JSON.parse(t) as Json;
    return isContainer(v) ? v : null;
  } catch {
    return null;
  }
}

export default function JsonTree({
  value,
  onFilter,
  onView,
  redact = (s) => s,
}: {
  value: Json;
  onFilter?: (path: string, value: string) => void;
  onView?: (label: string, value: string) => void;
  /** Masks string leaf values when redaction is on. */
  redact?: (s: string) => string;
}) {
  return (
    <div className="p-2 pl-4 font-mono text-xs text-gray-300">
      <JsonNode value={value} path="" depth={0} onFilter={onFilter} onView={onView} redact={redact} />
    </div>
  );
}
