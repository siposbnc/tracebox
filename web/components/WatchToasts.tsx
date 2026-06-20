import { useEffect } from 'react';
import type { WatchTrigger } from '../types';

export interface Toast {
  /** Unique per toast instance. */
  key: number;
  sessionId: string;
  /** Display label for the source file/command. */
  source: string;
  trigger: WatchTrigger;
}

/**
 * Bottom-right stack of watch-rule alerts. Each toast auto-dismisses; clicking
 * one switches to its file and jumps to the matching line.
 */
export default function WatchToasts({
  toasts,
  onDismiss,
  onOpen,
}: {
  toasts: Toast[];
  onDismiss: (key: number) => void;
  onOpen: (sessionId: string, lineNo: number | null) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.key} toast={t} onDismiss={onDismiss} onOpen={onOpen} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
  onOpen,
}: {
  toast: Toast;
  onDismiss: (key: number) => void;
  onOpen: (sessionId: string, lineNo: number | null) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.key), 8000);
    return () => clearTimeout(timer);
  }, [toast.key, onDismiss]);

  const { trigger } = toast;
  return (
    <div
      role="alert"
      onClick={() => onOpen(toast.sessionId, trigger.sample?.lineNo ?? null)}
      className="pointer-events-auto cursor-pointer overflow-hidden rounded-lg border border-amber-700/70 bg-surface-2 shadow-2xl animate-toast-in"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <span className="mt-0.5 text-amber-400">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-semibold text-amber-300">{trigger.ruleName}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(toast.key);
              }}
              className="shrink-0 rounded px-1 text-gray-500 hover:text-gray-200"
              title="Dismiss"
            >
              ×
            </button>
          </div>
          <div className="truncate text-[11px] text-gray-500">{toast.source}</div>
          <div className="mt-0.5 text-xs text-gray-400">
            {trigger.kind === 'rate'
              ? `${trigger.count} matches in ${trigger.windowSec}s (≥ ${trigger.threshold})`
              : `${trigger.count} new ${trigger.count === 1 ? 'match' : 'matches'}`}
          </div>
          {trigger.sample && (
            <div className="mt-1 truncate rounded bg-surface-0 px-1.5 py-1 font-mono text-[11px] text-gray-400">
              {trigger.sample.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
