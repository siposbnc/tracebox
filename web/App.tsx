import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { SessionStatus, WatchEvent } from './types';
import LogView from './components/LogView';
import OpenFileDialog from './components/OpenFileDialog';
import CommandDialog from './components/CommandDialog';
import WelcomeScreen from './components/WelcomeScreen';
import UpdateBanner from './components/UpdateBanner';
import WhatsNew from './components/WhatsNew';
import MergedView from './components/MergedView';
import WatchToasts, { type Toast } from './components/WatchToasts';
import WorkspacesMenu from './components/WorkspacesMenu';
import SettingsPanel from './components/SettingsPanel';
import ShortcutsHelp from './components/ShortcutsHelp';
import CachePanel from './components/CachePanel';
import ParsersPanel from './components/ParsersPanel';
import { Logo } from './components/Logo';
import { saveWorkspace, useWorkspaces, type ViewState, type Workspace } from './workspaces';
import { clientStore } from './clientStore';
import { getWatchRules, useWatchRulesVersion } from './watchRules';
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
  // a file/command open in flight (the request before its session exists), so the
  // UI can show "opening…" instead of sitting silent while a big/.gz file spins up
  const [opening, setOpening] = useState<string | null>(null);
  // a freshly-opened lone file that has rotated siblings — offer to open them as one stream
  const [rotationOffer, setRotationOffer] = useState<{ path: string; count: number; sessionId: string; siblings: string[] } | null>(null);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  // Settings (and the dialogs it links to) live at the app level so they're
  // reachable without a file open — from the welcome screen or the top bar.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [cacheOpen, setCacheOpen] = useState(false);
  const [parsersOpen, setParsersOpen] = useState(false);
  // pending jump from the merged timeline: open a file's tab at a specific line
  const [jumpTarget, setJumpTarget] = useState<{ id: string; lineNo: number; nonce: number } | null>(null);
  // watch-rule alerts: a flat log across all sessions, per-session unseen counts,
  // and a transient toast stack
  const [watchEvents, setWatchEvents] = useState<WatchEvent[]>([]);
  const [watchUnseen, setWatchUnseen] = useState<Record<string, number>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  // the newest version the user had seen before this launch (for "New" badges)
  const [sinceVersion] = useState<string | null>(() => clientStore.getItem(LAST_SEEN_VERSION_KEY));
  // last-known search state per session, for saving workspaces (sessions report it up)
  const viewStateRef = useRef<Map<string, ViewState>>(new Map());
  const captureViewState = useCallback((id: string, vs: ViewState) => {
    viewStateRef.current.set(id, vs);
  }, []);
  // keep the tab's live-tailing indicator in sync with the active view
  const handleTailChange = useCallback((id: string, tail: boolean) => {
    setSessions((prev) => prev.map((s) => (s.id === id && s.tail !== tail ? { ...s, tail } : s)));
  }, []);
  const workspaces = useWorkspaces();
  const watchRulesVersion = useWatchRulesVersion();
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Short label for a session (file name or command), used in alert toasts.
  const sourceLabel = useCallback((id: string): string => {
    const s = sessionsRef.current.find((x) => x.id === id);
    if (!s) return '';
    return s.kind === 'command' ? `▸ ${s.command ?? 'command'}` : (s.file.split(/[\\/]/).pop() ?? s.file);
  }, []);

  // Switch to a file's tab and (optionally) jump to a line — from a toast or a
  // clicked desktop notification.
  const openAt = useCallback((sessionId: string, lineNo: number | null) => {
    setActiveId(sessionId);
    setWhatsNewOpen(false);
    setTimelineOpen(false);
    if (lineNo !== null) setJumpTarget({ id: sessionId, lineNo, nonce: Date.now() });
  }, []);

  // Subscribe once to the app-wide watch-alert stream. Triggers replayed on
  // connect (older than mount) populate the panel silently; only genuinely live
  // ones raise a toast / desktop notification and bump the unseen badge.
  useEffect(() => {
    const mountedAt = Date.now();
    const seen = new Set<string>();
    let toastKey = 0;
    return api.watchEvents((e) => {
      const key = `${e.sessionId}:${e.trigger.ruleId}:${e.trigger.at}:${e.trigger.sample?.lineNo ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      setWatchEvents((prev) => [...prev, e].slice(-300));
      if (e.trigger.at < mountedAt - 2000) return; // historical replay — list only
      setWatchUnseen((u) => ({ ...u, [e.sessionId]: (u[e.sessionId] ?? 0) + 1 }));
      setToasts((prev) =>
        [...prev, { key: ++toastKey, sessionId: e.sessionId, source: sourceLabel(e.sessionId), trigger: e.trigger }].slice(-4),
      );
      if (e.trigger.desktop) {
        window.tracebox?.notify?.({
          title: e.trigger.ruleName,
          body: e.trigger.sample?.text ?? `${e.trigger.count} matches`,
          sessionId: e.sessionId,
          lineNo: e.trigger.sample?.lineNo ?? null,
        });
      }
    });
  }, [sourceLabel]);

  // Push each open session's persisted watch rules to the backend whenever the
  // sessions or the rules change, so background tabs are monitored too.
  const pushedRules = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const s of sessions) {
      const rules = getWatchRules(s.file);
      const serial = JSON.stringify(rules);
      if (pushedRules.current.get(s.id) === serial) continue;
      pushedRules.current.set(s.id, serial);
      void api.setWatchRules(s.id, rules).catch(() => {});
    }
    for (const id of [...pushedRules.current.keys()]) {
      if (!sessions.some((s) => s.id === id)) pushedRules.current.delete(id);
    }
  }, [sessions, watchRulesVersion]);

  // A clicked desktop notification jumps to its source line.
  useEffect(() => {
    window.tracebox?.onNotifyClick?.(({ sessionId, lineNo }) => openAt(sessionId, lineNo));
  }, [openAt]);

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
    setOpenError(null);
    // close the picker right away and show a pending tab, so the user gets
    // immediate feedback instead of staring at a frozen dialog / empty tab bar
    // while the (possibly multi-second) index spin-up happens
    setDialogOpen(false);
    setOpening(path.split(/[\\/]/).pop() ?? path);
    let status;
    try {
      status = await api.openFile(path);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
      return;
    } finally {
      setOpening(null);
    }
    setSessions((prev) => (prev.some((s) => s.id === status.id) ? prev : [...prev, status]));
    setActiveId(status.id);
    // if this lone file is part of a rotation set, offer to open the whole group
    if (status.sourceCount === 1) {
      void api
        .rotation(path)
        .then((r) => {
          if (r.members.length > 1) {
            const base = (p: string): string => p.split(/[\\/]/).pop() ?? p;
            const openedBase = base(path);
            const siblings = r.members.map((m) => base(m.path)).filter((n) => n !== openedBase);
            setRotationOffer({ path, count: r.members.length, sessionId: status.id, siblings });
          }
        })
        .catch(() => {});
    }
  }, []);

  // Run a command (or shell pipeline) and follow its output as a live source.
  const openCommand = useCallback(async (command: string, mergeStderr: boolean) => {
    setOpenError(null);
    setCommandOpen(false);
    setOpening(`▸ ${command}`);
    let status;
    try {
      status = await api.runCommand(command, mergeStderr);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
      return;
    } finally {
      setOpening(null);
    }
    setSessions((prev) => (prev.some((s) => s.id === status.id) ? prev : [...prev, status]));
    setActiveId(status.id);
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
      // drop the closed file's alerts and badge
      setWatchEvents((prev) => prev.filter((e) => e.sessionId !== id));
      setWatchUnseen((u) => {
        if (!(id in u)) return u;
        const { [id]: _drop, ...rest } = u;
        return rest;
      });
      setToasts((prev) => prev.filter((t) => t.sessionId !== id));
    },
    [],
  );

  const active = sessions.find((s) => s.id === activeId) ?? null;

  // the active file's alerts, newest first, for its watch panel
  const activeTriggers = useMemo(
    () => watchEvents.filter((e) => e.sessionId === activeId).map((e) => e.trigger).reverse(),
    [watchEvents, activeId],
  );
  const clearUnseen = useCallback((id: string) => {
    setWatchUnseen((u) => (u[id] ? { ...u, [id]: 0 } : u));
  }, []);

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
                {s.tail && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 animate-tail-blink"
                    title="Tailing — following new lines live"
                  />
                )}
                {(watchUnseen[s.id] ?? 0) > 0 && (
                  <span
                    className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-gray-950"
                    title={`${watchUnseen[s.id]} watch-rule ${watchUnseen[s.id] === 1 ? 'alert' : 'alerts'}`}
                  >
                    {watchUnseen[s.id] > 99 ? '99+' : watchUnseen[s.id]}
                  </span>
                )}
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
          {opening && (
            <div
              role="tab"
              className="flex max-w-64 items-center gap-2 rounded-t-md border border-b-0 border-edge bg-surface-0 px-3 py-1.5 text-sm text-gray-200"
              title={`Opening ${opening}`}
            >
              <svg className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.22-8.56" />
              </svg>
              <span className="truncate">{opening}</span>
            </div>
          )}
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
            <button
              onClick={() => setSettingsOpen(true)}
              className="mb-1.5 self-center rounded-md px-2 py-1 text-gray-400 hover:bg-surface-2 hover:text-gray-100"
              title="Settings"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
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
          <span className="min-w-0">
            Found {rotationOffer.count - 1} rotated {rotationOffer.count - 1 === 1 ? 'file' : 'files'} alongside this
            log:{' '}
            <span className="font-mono text-sky-100" title={rotationOffer.siblings.join('\n')}>
              {rotationOffer.siblings.slice(0, 5).join(', ')}
              {rotationOffer.siblings.length > 5 ? `, +${rotationOffer.siblings.length - 5} more` : ''}
            </span>
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
            onTailChange={handleTailChange}
            jumpTo={jumpTarget && jumpTarget.id === active.id ? jumpTarget : null}
            watchTriggers={activeTriggers}
            watchUnseen={watchUnseen[active.id] ?? 0}
            onWatchSeen={() => clearUnseen(active.id)}
          />
        ) : opening ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 bg-surface-0 text-gray-400">
            <svg className="h-7 w-7 animate-spin text-sky-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 12a9 9 0 1 1-6.22-8.56" />
            </svg>
            <div className="text-center">
              <div className="text-sm font-medium text-gray-200">Opening {opening}</div>
              <div className="mt-1 text-xs text-gray-500">Preparing the file — this can take a moment for large or compressed logs.</div>
            </div>
          </div>
        ) : (
          <WelcomeScreen
            onOpen={requestOpenFile}
            onOpenPath={openFile}
            onRunCommand={() => setCommandOpen(true)}
            onWhatsNew={() => setWhatsNewOpen(true)}
            onSettings={() => setSettingsOpen(true)}
          />
        )}
      </div>

      {dialogOpen && <OpenFileDialog onClose={() => setDialogOpen(false)} onOpen={openFile} />}
      {commandOpen && <CommandDialog onClose={() => setCommandOpen(false)} onRun={openCommand} />}

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onShowShortcuts={() => {
            setSettingsOpen(false);
            setShortcutsOpen(true);
          }}
          onManageCache={() => {
            setSettingsOpen(false);
            setCacheOpen(true);
          }}
          onManageParsers={() => {
            setSettingsOpen(false);
            setParsersOpen(true);
          }}
        />
      )}
      {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />}
      {cacheOpen && <CachePanel onClose={() => setCacheOpen(false)} />}
      {parsersOpen && <ParsersPanel onClose={() => setParsersOpen(false)} sessionId={activeId} />}

      <WatchToasts
        toasts={toasts}
        onDismiss={(key) => setToasts((prev) => prev.filter((t) => t.key !== key))}
        onOpen={(sessionId, lineNo) => {
          openAt(sessionId, lineNo);
          setToasts([]);
        }}
      />
    </div>
  );
}
