import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { SessionStatus } from './types';
import LogView from './components/LogView';
import OpenFileDialog from './components/OpenFileDialog';
import WelcomeScreen from './components/WelcomeScreen';
import { Logo } from './components/Logo';

export default function App() {
  const [sessions, setSessions] = useState<SessionStatus[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    void api.sessions().then((list) => {
      setSessions(list);
      if (list.length > 0) setActiveId(list[0].id);
      setLoaded(true);
    });
  }, []);

  const openFile = useCallback(async (path: string) => {
    const status = await api.openFile(path);
    setSessions((prev) => (prev.some((s) => s.id === status.id) ? prev : [...prev, status]));
    setActiveId(status.id);
    setDialogOpen(false);
  }, []);

  const openFileSafe = useCallback(
    (path: string) => {
      setOpenError(null);
      void openFile(path).catch((err: unknown) =>
        setOpenError(err instanceof Error ? err.message : String(err)),
      );
    },
    [openFile],
  );

  // Desktop shell integration: native file dialog instead of the web browser
  // dialog, plus files arriving from the OS ("Open with TraceBox", CLI args).
  const requestOpenFile = useCallback(() => {
    if (window.tracebox) {
      void window.tracebox.openFileDialog().then((path) => {
        if (path) openFileSafe(path);
      });
    } else {
      setDialogOpen(true);
    }
  }, [openFileSafe]);

  useEffect(() => {
    window.tracebox?.onOpenPath((path) => openFileSafe(path));
  }, [openFileSafe]);

  // Drag & drop a file onto the window (real paths are desktop-only)
  useEffect(() => {
    if (!window.tracebox) return;
    const onDragOver = (e: DragEvent): void => e.preventDefault();
    const onDrop = (e: DragEvent): void => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      try {
        openFileSafe(window.tracebox!.getPathForFile(file));
      } catch {
        // not a filesystem file (e.g. dragged text)
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [openFileSafe]);

  const closeSession = useCallback(
    async (id: string) => {
      await api.closeSession(id);
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        setActiveId((cur) => (cur === id ? (next[0]?.id ?? null) : cur));
        return next;
      });
    },
    [],
  );

  if (!loaded) return null;

  const active = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <div className="flex h-full flex-col">
      {sessions.length > 0 && (
        <div className="flex items-stretch gap-1 border-b border-edge bg-surface-1 px-2 pt-1.5">
          <div className="mr-1 flex items-center gap-2 px-2 pb-1.5">
            <Logo className="h-5 w-5" />
            <span className="text-sm font-semibold tracking-wide text-sky-300">TraceBox</span>
          </div>
          {sessions.map((s) => {
            const name = s.file.split(/[\\/]/).pop();
            const isActive = s.id === activeId;
            return (
              <div
                key={s.id}
                role="tab"
                onClick={() => setActiveId(s.id)}
                className={`group flex max-w-64 cursor-pointer items-center gap-2 rounded-t-md border border-b-0 px-3 py-1.5 text-sm ${
                  isActive
                    ? 'border-edge bg-surface-0 text-gray-100'
                    : 'border-transparent bg-surface-2/50 text-gray-400 hover:bg-surface-2'
                }`}
                title={s.file}
              >
                <span className="truncate">{name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeSession(s.id);
                  }}
                  className="rounded px-1 leading-none text-gray-500 opacity-0 transition-opacity hover:bg-surface-3 hover:text-gray-200 group-hover:opacity-100"
                  title="Close file"
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            onClick={requestOpenFile}
            className="mb-1.5 ml-1 self-center rounded-md px-2.5 py-1 text-sm text-gray-400 hover:bg-surface-2 hover:text-gray-100"
            title="Open another file"
          >
            +
          </button>
        </div>
      )}

      {openError && (
        <div className="flex items-center justify-between border-b border-red-900 bg-red-950/60 px-4 py-1.5 text-sm text-red-300">
          <span>⚠ {openError}</span>
          <button onClick={() => setOpenError(null)} className="rounded px-1.5 text-red-400 hover:text-red-200">
            ×
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {active ? (
          <LogView key={active.id} initial={active} onOpenFile={requestOpenFile} />
        ) : (
          <WelcomeScreen onOpen={requestOpenFile} onOpenPath={openFile} />
        )}
      </div>

      {dialogOpen && <OpenFileDialog onClose={() => setDialogOpen(false)} onOpen={openFile} />}
    </div>
  );
}
