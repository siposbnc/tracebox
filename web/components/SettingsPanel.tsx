import {
  useOrder,
  setOrder,
  useTz,
  setTz,
  useWrap,
  setWrap,
  useContextLines,
  setContextLines,
  useHistogramDefault,
  setHistogramDefault,
  usePageJump,
  setPageJump,
  usePageJumpBig,
  setPageJumpBig,
  useTheme,
  setTheme,
  useFontSize,
  setFontSize,
} from '../settings';
import { tzAbbr } from '../api';
import { useEscapeKey } from '../escStack';

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-edge">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1 text-xs ${
            value === o.value ? 'bg-sky-700 text-white' : 'bg-surface-0 text-gray-400 hover:text-gray-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-gray-200">{label}</div>
        {hint && <div className="text-xs text-gray-500">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Display preferences and an entry point to the keyboard shortcuts editor. */
export default function SettingsPanel({
  onClose,
  onShowShortcuts,
  onManageCache,
  onManageParsers,
  onManageMcp,
  onManageRedaction,
}: {
  onClose: () => void;
  onShowShortcuts: () => void;
  onManageCache: () => void;
  onManageParsers: () => void;
  onManageMcp: () => void;
  onManageRedaction: () => void;
}) {
  const theme = useTheme();
  const fontSize = useFontSize();
  const order = useOrder();
  const tz = useTz();
  const wrap = useWrap();
  const contextLines = useContextLines();
  const histogramDefault = useHistogramDefault();
  const pageJump = usePageJump();
  const pageJumpBig = usePageJumpBig();

  useEscapeKey(onClose, 'modal');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[460px] max-w-[92vw] overflow-hidden rounded-lg border border-edge bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
          <h2 className="text-sm font-semibold text-gray-200">Settings</h2>
          <button onClick={onClose} className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200" title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="divide-y divide-edge/50 px-4 py-2">
          <Row label="Theme" hint="Color theme for the whole app">
            <Segmented
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
                { value: 'hc', label: 'High contrast' },
              ]}
            />
          </Row>

          <Row label="Font size" hint="Reading size for log rows and detail">
            <Segmented
              value={fontSize}
              onChange={setFontSize}
              options={[
                { value: 'sm', label: 'S' },
                { value: 'md', label: 'M' },
                { value: 'lg', label: 'L' },
                { value: 'xl', label: 'XL' },
              ]}
            />
          </Row>

          <Row label="Row order" hint="Order log rows by time">
            <Segmented
              value={order}
              onChange={setOrder}
              options={[
                { value: 'asc', label: 'Oldest first' },
                { value: 'desc', label: 'Newest first' },
              ]}
            />
          </Row>

          <Row label="Timestamps" hint={`Local time shows as ${tzAbbr(Date.now(), 'local')}`}>
            <Segmented
              value={tz}
              onChange={setTz}
              options={[
                { value: 'utc', label: 'UTC' },
                { value: 'local', label: 'Local' },
              ]}
            />
          </Row>

          <Row label="Word wrap" hint="Wrap long lines instead of truncating them">
            <button
              role="switch"
              aria-checked={wrap}
              onClick={() => setWrap(!wrap)}
              className={`relative h-5 w-9 rounded-full transition-colors ${wrap ? 'bg-sky-600' : 'bg-surface-3'}`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                  wrap ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </Row>

          <Row label="Context lines" hint="Lines shown before/after when peeking at a match">
            <input
              type="number"
              min={0}
              max={1000}
              value={contextLines}
              onChange={(e) => setContextLines(Number(e.target.value))}
              className="w-20 rounded border border-edge bg-surface-0 px-2 py-1 text-right font-mono text-sm text-gray-100 outline-none focus:border-sky-600"
            />
          </Row>

          <Row label="Page jump" hint="Rows moved by Page Up / Page Down">
            <input
              type="number"
              min={1}
              value={pageJump}
              onChange={(e) => setPageJump(Number(e.target.value))}
              className="w-20 rounded border border-edge bg-surface-0 px-2 py-1 text-right font-mono text-sm text-gray-100 outline-none focus:border-sky-600"
            />
          </Row>

          <Row label="Big page jump" hint="Rows moved by Ctrl/Cmd + Page Up / Down">
            <input
              type="number"
              min={1}
              value={pageJumpBig}
              onChange={(e) => setPageJumpBig(Number(e.target.value))}
              className="w-20 rounded border border-edge bg-surface-0 px-2 py-1 text-right font-mono text-sm text-gray-100 outline-none focus:border-sky-600"
            />
          </Row>

          <Row label="Histogram" hint="Show the time histogram when a file opens">
            <button
              role="switch"
              aria-checked={histogramDefault}
              onClick={() => setHistogramDefault(!histogramDefault)}
              className={`relative h-5 w-9 rounded-full transition-colors ${histogramDefault ? 'bg-sky-600' : 'bg-surface-3'}`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                  histogramDefault ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </Row>

          <Row label="Keyboard shortcuts" hint="View and rebind shortcuts">
            <button
              onClick={onShowShortcuts}
              className="rounded-md border border-edge bg-surface-2 px-3 py-1 text-xs text-gray-300 hover:text-gray-100"
            >
              Edit shortcuts
            </button>
          </Row>

          <Row label="Custom parsers" hint="Teach TraceBox a proprietary log format">
            <button
              onClick={onManageParsers}
              className="rounded-md border border-edge bg-surface-2 px-3 py-1 text-xs text-gray-300 hover:text-gray-100"
            >
              Manage parsers
            </button>
          </Row>

          <Row label="Redaction" hint="Mask emails, IPs, tokens… for sharing">
            <button
              onClick={onManageRedaction}
              className="rounded-md border border-edge bg-surface-2 px-3 py-1 text-xs text-gray-300 hover:text-gray-100"
            >
              Configure
            </button>
          </Row>

          <Row label="MCP server" hint="Let AI agents drive TraceBox (off by default)">
            <button
              onClick={onManageMcp}
              className="rounded-md border border-edge bg-surface-2 px-3 py-1 text-xs text-gray-300 hover:text-gray-100"
            >
              Configure
            </button>
          </Row>

          <Row label="Index cache" hint="On-disk indexes for fast reopen">
            <button
              onClick={onManageCache}
              className="rounded-md border border-edge bg-surface-2 px-3 py-1 text-xs text-gray-300 hover:text-gray-100"
            >
              Manage cache
            </button>
          </Row>
        </div>
      </div>
    </div>
  );
}
