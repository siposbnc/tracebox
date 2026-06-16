import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { SessionStatus } from './types';
import LogView from './components/LogView';
import OpenFileDialog from './components/OpenFileDialog';
import CommandDialog from './components/CommandDialog';
import WelcomeScreen from './components/WelcomeScreen';
import UpdateBanner from './components/UpdateBanner';
import WhatsNew from './components/WhatsNew';
import MergedView from './components/MergedView';
import WorkspacesMenu from './components/WorkspacesMenu';
import { Logo } from './components/Logo';
import { saveWorkspace, useWorkspaces, type ViewState, type Workspace } from './workspaces';
import { clientStore } from './clientStore';
import { patchNotes } from './patchnotes';
import { compareVersions } from './version';
import { matchCommand } from './keybindings';

const LAST_SEEN_VERSION_KEY = 'tracebox.lastSeenVersion';

export default function App() {
  const [sessions, setSessions] = useState<SessionStatus[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // a freshly-opened lone file that has rotated siblings — offer to open them as one stream
  const [rotationOffer, setRotationOffer] = useState<{ path: string; count: number; sessionId: string } | null>(null);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  // pending jump from the merged timeline: open a file's tab at a specific line
  const [jumpTarget, setJumpTarget] = useState<{ id: string; lineNo: number; nonce: number } | null>(null);
  // the newest version the user had seen before this launch (for "New" badges)
  const [sinceVersion] = useState<string | null>(() => clientStore.getItem(LAST_SEEN_VERSION_KEY));
  // last-known search state per session, for saving workspaces (sessions report it up)
  const viewStateRef = useRef<Map<string, ViewState>>(new Map());
  const captureViewState = useCallback((id: string, vs: ViewState) => {
    viewStateRef.current.set(id, vs);
  }, []);
  const workspaces = useWorkspaces();

  useEffect(() => {
    void api.sessions().then((list) => {
      setSessions(list);
      if (list.length > 0) setActiveId(list[0].id);
      setLoaded(true);
    });
  }, []);

  // Auto-open "What's new" once, only on the first launch of a newer version
  // (i.e. after an update) — never on a clean install or on later launches.
  useEffect(() => {
    const current = patchNotes[0]?.version;
    if (!current) return;
    const lastSeen = clientStore.getItem(LAST_SEEN_VERSION_KEY);
    if (lastSeen && compareVersions(current, lastSeen) > 0) setWhatsNewOpen(true);
    clientStore.setItem(LAST_SEEN_VERSION_KEY, current);
  }, []);

  // cycle through open file tabs (Ctrl+Tab / Ctrl+Shift+Tab, rebindable)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const cmd = matchCommand(e);
      if (cmd !== 'nextTab' && cmd !== 'prevTab') return;
      e.preventDefault();
      if (sessions.length < 2) return;
      setActiveId((cur) => {
        const idx = Math.max(0, sessions.findIndex((s) => s.id === cur));
        const n = sessions.length;
        const next = cmd === 'nextTab' ? (idx + 1) % n : (idx - 1 + n) % n;
        return sessions[next].id;
      });
      setWhatsNewOpen(false);
      setTimelineOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessions]);

  const openFile = useCallback(async (path: string) => {
    setRotationOffer(null);
    const status = await api.openFile(path);
    setSessions((prev) => (prev.some((s) => s.id === status.id) ? prev : [...prev, status]));
    setActiveId(status.id);
    setDialogOpen(false);
    // if this lone file is part of a rotation set, offer to open the whole group
    if (status.sourceCount === 1) {
      void api
        .rotation(path)
        .then((r) => {
          if (r.members.length > 1) setRotationOffer({ path, count: r.members.length, sessionId: status.id });
        })
        .catch(() => {});
    }
  }, []);

  // Run a command (or shell pipeline) and follow its output as a live source.
  const openCommand = useCallback(async (command: string, mergeStderr: boolean) => {
    const status = await api.runCommand(command, mergeStderr);
    setSessions((prev) => (prev.some((s) => s.id === status.id) ? prev : [...prev, status]));
    setActiveId(status.id);
    setCommandOpen(false);
  }, []);

  // Re-open the offered file as its full rotation group, replacing the single-file tab.
  const openRotationGroup = useCallback(async () => {
    const offer = rotationOffer;
    if (!offer) return;
    setRotationOffer(null);
    try {
      const status = await api.openFile(offer.path, true);
      setSessions((prev) => {
        const next = prev.some((s) => s.id === status.id) ? prev : [...prev, status];
        return next.filter((s) => s.id === status.id || s.id !== offer.sessionId);
      });
      setActiveId(status.id);
      if (status.id !== offer.sessionId) await api.closeSession(offer.sessionId);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    }
  }, [rotationOffer]);

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
      setTimelineOpen(false); // the merged timeline references open sessions
      setRotationOffer((o) => (o?.sessionId === id ? null : o));
      await api.closeSession(id);
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        setActiveId((cur) => (cur === id ? (next[0]?.id ?? null) : cur));
        return next;
      });
    },
    [],
  );

  const active = sessions.find((s) => s.id === activeId) ?? null;

  // snapshot the open files + their searches as a named workspace
  const saveCurrentWorkspace = useCallback(
    (name: string) => {
      const files = sessions.map((s) => {
        const vs = viewStateRef.current.get(s.id);
        return {
          path: s.file,
          query: vs?.query ?? s.search?.query ?? '',
          regex: vs?.regex ?? false,
          grouped: vs?.grouped ?? true,
        };
      });
      saveWorkspace({ name, savedAt: Date.now(), activePath: active?.file ?? null, files });
    },
    [sessions, active],
  );

  // reopen a saved workspace: open each file and re-apply its search on the backend,
  // so the (re)mounted LogView reflects it
  const openWorkspace = useCallback(async (ws: Workspace) => {
    setOpenError(null);
    setWhatsNewOpen(false);
    setTimelineOpen(false);
    let targetId: string | null = null;
    const opened: SessionStatus[] = [];
    try {
      for (const f of ws.files) {
        const status = await api.openFile(f.path);
        let st = status;
        if (f.query.trim() !== '') {
          await api.search(status.id, f.query, f.grouped, null, f.regex);
          st = await api.session(status.id);
        }
        opened.push(st);
        if (f.path === ws.activePath) targetId = st.id;
      }
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    }
    if (opened.length === 0) return;
    setSessions((prev) => {
      const merged = [...prev];
      for (const s of opened) {
        const i = merged.findIndex((m) => m.id === s.id);
        if (i >= 0) merged[i] = s;
        else merged.push(s);
      }
      return merged;
    });
    setActiveId(targetId ?? opened[0].id);
  }, []);

  if (!loaded) return null;

  return (
    <div className="flex h-full flex-col">
      <UpdateBanner />
      {(sessions.length > 0 || whatsNewOpen || workspaces.length > 0) && (
        <div className="flex items-stretch gap-1 border-b border-edge bg-surface-1 px-2 pt-1.5">
          <div className="mr-1 flex items-center gap-2 px-2 pb-1.5">
            <Logo className="h-5 w-5" />
            <span className="text-sm font-semibold tracking-wide text-sky-300">TraceBox</span>
          </div>
          {sessions.map((s) => {
            const name =
              s.kind === 'command' ? `▸ ${s.command ?? 'command'}` : s.file.split(/[\\/]/).pop();
            const isActive = s.id === activeId && !whatsNewOpen && !timelineOpen;
            return (
              <div
                key={s.id}
                role="tab"
                onClick={() => {
                  setActiveId(s.id);
                  setWhatsNewOpen(false);
                  setTimelineOpen(false);
                }}
                className={`group flex max-w-64 cursor-pointer items-center gap-2 rounded-t-md border border-b-0 px-3 py-1.5 text-sm ${
                  isActive
                    ? 'border-edge bg-surface-0 text-gray-100'
                    : 'border-transparent bg-surface-2/50 text-gray-400 hover:bg-surface-2'
                }`}
                title={
                  s.kind === 'command'
                    ? (s.command ?? 'command')
                    : s.sourceCount > 1
                      ? `${s.file} (+${s.sourceCount - 1} rotated)`
                      : s.file
                }
              >
                <span className="truncate">{name}</span>
                {s.sourceCount > 1 && (
                  <span
                    className="rounded bg-surface-2 px-1 text-[10px] font-medium text-sky-300"
                    title={`${s.sourceCount} rotated files opened as one stream`}
                  >
                    +{s.sourceCount - 1}
                  </span>
                )}
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
          <button
            onClick={() => setCommandOpen(true)}
            className="mb-1.5 self-center rounded-md px-2.5 py-1 text-sm text-gray-400 hover:bg-surface-2 hover:text-gray-100"
            title="Run a command and follow its output"
          >
            ▸ Run command
          </button>
          {sessions.length >= 2 && (
            <button
              onClick={() => setTimelineOpen(true)}
              className={`mb-1.5 ml-auto self-center rounded-md px-2.5 py-1 text-sm ${
                timelineOpen ? 'bg-surface-0 text-sky-300' : 'text-gray-400 hover:bg-surface-2 hover:text-gray-100'
              }`}
              title="Merged timeline across all open files"
            >
              ⇋ Timeline
            </button>
          )}
          <div className={`flex items-stretch gap-1 ${sessions.length >= 2 ? 'ml-1' : 'ml-auto'}`}>
            <WorkspacesMenu canSave={sessions.length > 0} onSave={saveCurrentWorkspace} onOpen={(ws) => void openWorkspace(ws)} />
            <button
              onClick={() => setWhatsNewOpen(true)}
              className={`mb-1.5 self-center rounded-md px-2.5 py-1 text-sm ${
                whatsNewOpen
                  ? 'bg-surface-0 text-sky-300'
                  : 'text-gray-400 hover:bg-surface-2 hover:text-gray-100'
              }`}
              title="What's new"
            >
              ✨ What's new
            </button>
          </div>
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

      {rotationOffer && (
        <div className="flex items-center justify-between gap-3 border-b border-sky-900 bg-sky-950/50 px-4 py-1.5 text-sm text-sky-200">
          <span>
            Found {rotationOffer.count - 1} rotated {rotationOffer.count - 1 === 1 ? 'file' : 'files'} alongside this
            log.
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void openRotationGroup()}
              className="rounded bg-sky-700/60 px-2 py-0.5 font-medium text-sky-100 hover:bg-sky-600/60"
            >
              Open all {rotationOffer.count} as one stream
            </button>
            <button
              onClick={() => setRotationOffer(null)}
              className="rounded px-1.5 text-sky-400 hover:text-sky-200"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {timelineOpen ? (
          <MergedView
            files={sessions.map((s) => ({ id: s.id, file: s.file }))}
            onJump={(sessionId, lineNo) => {
              setActiveId(sessionId);
              setTimelineOpen(false);
              setJumpTarget({ id: sessionId, lineNo, nonce: Date.now() });
            }}
          />
        ) : whatsNewOpen ? (
          <WhatsNew onClose={() => setWhatsNewOpen(false)} sinceVersion={sinceVersion} />
        ) : active ? (
          <LogView
            key={active.id}
            initial={active}
            onOpenFile={requestOpenFile}
            onViewState={captureViewState}
            jumpTo={jumpTarget && jumpTarget.id === active.id ? jumpTarget : null}
          />
        ) : (
          <WelcomeScreen
            onOpen={requestOpenFile}
            onOpenPath={openFile}
            onRunCommand={() => setCommandOpen(true)}
            onWhatsNew={() => setWhatsNewOpen(true)}
          />
        )}
      </div>

      {dialogOpen && <OpenFileDialog onClose={() => setDialogOpen(false)} onOpen={openFile} />}
      {commandOpen && <CommandDialog onClose={() => setCommandOpen(false)} onRun={openCommand} />}
    </div>
  );
}
