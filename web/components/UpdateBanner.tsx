import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../desktop';

/**
 * Shows update status (desktop app only). The user opts in to the download;
 * once it finishes they install it with one click — no manual re-download or
 * reinstall.
 */
export default function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    window.tracebox?.onUpdateStatus((s) => {
      setStatus(s);
      setDismissed(false);
    });
  }, []);

  if (!status || dismissed) return null;
  if (status.state === 'error') return null; // keep update errors out of the user's way

  if (status.state === 'ready') {
    return (
      <div className="flex items-center justify-between gap-3 border-b border-emerald-800 bg-emerald-950/70 px-4 py-2 text-sm text-emerald-200">
        <span>✓ TraceBox {status.version} is ready to install.</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.tracebox?.installUpdate()}
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500"
          >
            Restart &amp; update
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="rounded px-1.5 text-emerald-400 hover:text-emerald-200"
            title="Install later (on next quit)"
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  if (status.state === 'available') {
    return (
      <div className="flex items-center justify-between gap-3 border-b border-sky-900 bg-sky-950/60 px-4 py-2 text-sm text-sky-200">
        <span>A new version ({status.version}) of TraceBox is available.</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.tracebox?.downloadUpdate()}
            className="rounded-md bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500"
          >
            Download update
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="rounded px-1.5 text-sky-400 hover:text-sky-200"
            title="Not now"
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  // downloading
  return (
    <div className="flex items-center gap-3 border-b border-sky-900 bg-sky-950/60 px-4 py-2 text-sm text-sky-200">
      <span className="h-2 w-2 animate-pulse-subtle rounded-full bg-sky-400" />
      <span>Downloading update… {status.percent}%</span>
    </div>
  );
}
