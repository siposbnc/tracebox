import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useEscapeKey } from '../escStack';

interface McpInfo {
  execPath: string;
  script: string;
  sqliteArgs: string[];
}

/** Quote a path for a shell command if it contains spaces. */
function q(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

/** The `claude mcp add` one-liner for the bundled, opt-in stdio server. */
function claudeAddCommand(info: McpInfo | null): string {
  if (!info) {
    // dev / plain-web fallback: run from a source checkout
    return 'claude mcp add tracebox -- node /path/to/tracebox/server/mcp-main.ts --allow';
  }
  const args = [...info.sqliteArgs, info.script].map(q).join(' ');
  return `claude mcp add tracebox -e ELECTRON_RUN_AS_NODE=1 -- ${q(info.execPath)} ${args}`;
}

/**
 * Opt-in control for the MCP server (lets AI agents drive TraceBox). The server
 * ships disabled; enabling it flips the persisted `mcpEnabled` flag the stdio
 * entry enforces, and reveals the command to register it with an MCP client.
 */
export default function McpPanel({ onClose }: { onClose: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api.config().then((c) => {
      setEnabled(c.config.mcpEnabled);
      setLoaded(true);
    });
    void window.tracebox?.mcpInfo?.().then(setInfo).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEscapeKey(onClose, 'modal');

  const toggle = (): void => {
    const next = !enabled;
    setBusy(true);
    setEnabled(next); // optimistic
    void api
      .setConfig({ mcpEnabled: next })
      .then((c) => setEnabled(c.config.mcpEnabled))
      .catch(() => setEnabled(!next))
      .finally(() => setBusy(false));
  };

  const command = claudeAddCommand(info);
  const copy = (): void => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-edge bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
          <h2 className="text-sm font-semibold text-gray-200">MCP server</h2>
          <button onClick={onClose} className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200" title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="border-b border-edge px-4 py-1.5 text-[11px] text-gray-500">
          Let an AI agent (Claude Code, Claude Desktop, …) drive TraceBox over the Model Context Protocol — open and search
          logs, pull aggregates, define parsers. It runs locally on stdio, opens no network sockets, and is <b>off by default</b>.
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="flex items-center justify-between gap-4 py-1">
            <div className="min-w-0">
              <div className="text-sm text-gray-200">Enable the MCP server</div>
              <div className="text-xs text-gray-500">
                {enabled ? 'Agents may drive TraceBox once registered below.' : 'Agents cannot start the server while this is off.'}
              </div>
            </div>
            <button
              role="switch"
              aria-checked={enabled}
              disabled={!loaded || busy}
              onClick={toggle}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${enabled ? 'bg-sky-600' : 'bg-surface-3'}`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                  enabled ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {enabled && (
            <div className="mt-3 space-y-2 border-t border-edge/60 pt-3">
              <div className="text-xs text-gray-400">
                Register it with your MCP client. For Claude Code, run:
              </div>
              <div className="relative rounded border border-edge bg-surface-0 p-2 pr-16">
                <code className="block whitespace-pre-wrap break-all font-mono text-[11px] text-sky-200">{command}</code>
                <button
                  onClick={copy}
                  className="absolute right-1.5 top-1.5 rounded border border-edge bg-surface-2 px-2 py-0.5 text-[11px] text-gray-300 hover:text-gray-100"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              {!info && (
                <div className="text-[11px] text-gray-600">
                  Showing the source-checkout command (the desktop launcher isn’t available outside the packaged app).
                </div>
              )}
              <div className="text-[11px] text-gray-600">
                Other clients: launch{' '}
                {info ? (
                  <code className="font-mono text-gray-400">{q(info.execPath)} … {q(info.script)}</code>
                ) : (
                  <code className="font-mono text-gray-400">node server/mcp-main.ts --allow</code>
                )}{' '}
                as a stdio server{info ? ' with ELECTRON_RUN_AS_NODE=1' : ''}.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
