import { useEffect, useRef, useState } from 'react';
import { useWorkspaces, deleteWorkspace, type Workspace } from '../workspaces';

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Header dropdown: save the current set of files + searches as a named
 * workspace, or reopen / delete a saved one. */
export default function WorkspacesMenu({
  canSave,
  onSave,
  onOpen,
}: {
  canSave: boolean;
  onSave: (name: string) => void;
  onOpen: (ws: Workspace) => void;
}) {
  const workspaces = useWorkspaces();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const save = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setName('');
    setOpen(false);
  };

  return (
    <div className="relative self-center" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`mb-1.5 rounded-md px-2.5 py-1 text-sm ${
          open ? 'bg-surface-0 text-sky-300' : 'text-gray-400 hover:bg-surface-2 hover:text-gray-100'
        }`}
        title="Workspaces"
      >
        ▦ Workspaces
        {workspaces.length > 0 && <span className="ml-1 text-xs text-gray-500">{workspaces.length}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-edge bg-surface-2 shadow-2xl">
          <div className="flex items-center gap-1.5 border-b border-edge p-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              placeholder={canSave ? 'Save current as…' : 'Open a file first'}
              disabled={!canSave}
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-edge bg-surface-0 px-2 py-1 text-xs text-gray-200 placeholder:text-gray-600 focus:border-sky-700 focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={save}
              disabled={!canSave || name.trim() === ''}
              className="shrink-0 rounded bg-sky-700/70 px-2 py-1 text-xs font-medium text-sky-50 hover:bg-sky-600/70 disabled:cursor-default disabled:opacity-40"
            >
              Save
            </button>
          </div>

          <div className="max-h-[50vh] overflow-y-auto p-1">
            {workspaces.length === 0 ? (
              <div className="px-2 py-2 text-xs text-gray-600">
                No saved workspaces. Open some files, run your searches, then save them here.
              </div>
            ) : (
              workspaces.map((ws) => (
                <div key={ws.name} className="group flex items-center gap-2 rounded px-1 hover:bg-surface-3">
                  <button
                    onClick={() => {
                      onOpen(ws);
                      setOpen(false);
                    }}
                    className="min-w-0 flex-1 py-1 text-left"
                    title={ws.files.map((f) => baseName(f.path) + (f.query ? ` · ${f.query}` : '')).join('\n')}
                  >
                    <div className="truncate text-xs text-gray-200">{ws.name}</div>
                    <div className="truncate text-[10px] text-gray-500">
                      {ws.files.length} file{ws.files.length === 1 ? '' : 's'} · {ws.files.map((f) => baseName(f.path)).join(', ')}
                    </div>
                  </button>
                  <button
                    onClick={() => deleteWorkspace(ws.name)}
                    className="shrink-0 rounded px-1 text-gray-600 opacity-0 hover:text-red-300 group-hover:opacity-100"
                    title="Delete workspace"
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
