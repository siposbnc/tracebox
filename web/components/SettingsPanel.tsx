import {
  useOrder,
  setOrder,
  useTz,
  setTz,
  useWrap,
  setWrap,
  useLevelBars,
  setLevelBars,
  useDeltaColumn,
  setDeltaColumn,
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

// ---- building blocks -------------------------------------------------------

/** A segmented choice control (theme, font size, order, timezone). */
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
          className={`px-3 py-1 text-xs transition-colors ${
            value === o.value ? 'bg-sky-700 text-white' : 'bg-surface-0 text-gray-400 hover:text-gray-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** An on/off switch. */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-sky-600' : 'bg-surface-3'}`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

/** A small numeric input (context lines, page jumps). */
function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max?: number;
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-20 rounded-md border border-edge bg-surface-0 px-2 py-1 text-right font-mono text-sm text-gray-100 outline-none focus:border-sky-600"
    />
  );
}

/** An inline setting: label + hint on the left, its control on the right. */
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-gray-200">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-gray-500">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A navigational row that opens another panel — the whole row is the target. */
function NavRow({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center justify-between gap-4 px-3 py-2.5 text-left transition-colors hover:bg-surface-3/40"
    >
      <div className="min-w-0">
        <div className="text-sm text-gray-200 group-hover:text-gray-100">{label}</div>
        <div className="mt-0.5 text-xs text-gray-500">{hint}</div>
      </div>
      <span className="shrink-0 text-base text-gray-600 transition-all group-hover:translate-x-0.5 group-hover:text-sky-300">›</span>
    </button>
  );
}

/** A titled group of rows in a card. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{title}</h3>
      <div className="divide-y divide-edge/50 overflow-hidden rounded-lg border border-edge bg-surface-2/40">
        {children}
      </div>
    </section>
  );
}

// ---- panel -----------------------------------------------------------------

/** Display preferences, grouped, plus entry points to the sub-panels. */
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
  const levelBars = useLevelBars();
  const deltaColumn = useDeltaColumn();
  const contextLines = useContextLines();
  const histogramDefault = useHistogramDefault();
  const pageJump = usePageJump();
  const pageJumpBig = usePageJumpBig();

  useEscapeKey(onClose, 'modal');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[480px] max-w-[94vw] animate-toast-in flex-col overflow-hidden rounded-lg border border-edge bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-100">
            <svg className="h-4 w-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </h2>
          <button onClick={onClose} className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200" title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <Section title="Appearance">
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
            <Row label="Level accent bars" hint="Color bar on warning/error rows; off aligns every row">
              <Toggle checked={levelBars} onChange={setLevelBars} label="Level accent bars" />
            </Row>
          </Section>

          <Section title="Log display">
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
              <Toggle checked={wrap} onChange={setWrap} label="Word wrap" />
            </Row>
            <Row label="Histogram on open" hint="Show the time histogram when a file opens">
              <Toggle checked={histogramDefault} onChange={setHistogramDefault} label="Histogram on open" />
            </Row>
            <Row label="Δt column" hint="Show the time gap to the previous row">
              <Toggle checked={deltaColumn} onChange={setDeltaColumn} label="Delta time column" />
            </Row>
          </Section>

          <Section title="Navigation">
            <Row label="Context lines" hint="Lines shown before/after when peeking at a match">
              <NumberInput value={contextLines} onChange={setContextLines} min={0} max={1000} />
            </Row>
            <Row label="Page jump" hint="Rows moved by Page Up / Page Down">
              <NumberInput value={pageJump} onChange={setPageJump} min={1} />
            </Row>
            <Row label="Big page jump" hint="Rows moved by Ctrl/Cmd + Page Up / Down">
              <NumberInput value={pageJumpBig} onChange={setPageJumpBig} min={1} />
            </Row>
          </Section>

          <Section title="Manage">
            <NavRow label="Keyboard shortcuts" hint="View and rebind shortcuts" onClick={onShowShortcuts} />
            <NavRow label="Custom parsers" hint="Teach TraceBox a proprietary log format" onClick={onManageParsers} />
            <NavRow label="Redaction" hint="Mask emails, IPs, tokens… for sharing" onClick={onManageRedaction} />
            <NavRow label="MCP server" hint="Let AI agents drive TraceBox (off by default)" onClick={onManageMcp} />
            <NavRow label="Index cache" hint="On-disk indexes for fast reopen" onClick={onManageCache} />
          </Section>
        </div>
      </div>
    </div>
  );
}
