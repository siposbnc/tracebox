import { useCallback, useEffect, useRef, useState } from 'react';

const EXAMPLES = ['docker logs -f web', 'journalctl -f', 'kubectl logs -f pod/api', 'adb logcat'];

/**
 * Run a command (or any shell pipeline) and follow its output as a live source.
 * Reachable from the welcome screen and the tab bar, so it works in the desktop
 * app (which uses the native file picker and never shows the file dialog).
 */
export default function CommandDialog({
  onClose,
  onRun,
}: {
  onClose: () => void;
  onRun: (command: string, mergeStderr: boolean) => Promise<void>;
}) {
  const [command, setCommand] = useState('');
  const [mergeStderr, setMergeStderr] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = useCallback(async () => {
    const c = command.trim();
    if (!c) return;
    setRunning(true);
    setError(null);
    try {
      await onRun(c, mergeStderr);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  }, [command, mergeStderr, onRun]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-6 pt-[18vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[640px] max-w-[95vw] overflow-hidden rounded-xl border border-edge bg-surface-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-200">Run a command</h2>
          <button onClick={onClose} className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200">
            ×
          </button>
        </div>

        <div className="px-4 py-4">
          <p className="mb-3 text-xs leading-5 text-gray-500">
            TraceBox runs this through your shell and follows the output as a live log — indexed and
            searchable while it streams. Stop it any time from the status bar.
          </p>

          <div className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-sm text-gray-600">▸</span>
            <input
              ref={inputRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run();
              }}
              disabled={running}
              placeholder="e.g. docker logs -f web"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-edge bg-surface-0 px-2.5 py-1.5 font-mono text-sm text-gray-200 outline-none focus:border-sky-600 disabled:opacity-60"
            />
            <button
              onClick={() => void run()}
              disabled={running || command.trim() === ''}
              className="shrink-0 rounded-md bg-sky-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-40"
            >
              {running ? 'Running…' : 'Run'}
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-gray-600">Try:</span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => setCommand(ex)}
                disabled={running}
                className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-gray-400 hover:text-gray-100 disabled:opacity-40"
              >
                {ex}
              </button>
            ))}
          </div>

          <label className="mt-3 flex w-fit items-center gap-2 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={mergeStderr}
              onChange={(e) => setMergeStderr(e.target.checked)}
              disabled={running}
              className="accent-sky-600"
            />
            Capture stderr too (many tools log there)
          </label>

          {error && <div className="mt-3 text-sm text-red-400">⚠ {error}</div>}
        </div>
      </div>
    </div>
  );
}
