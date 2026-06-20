import { formatTs, tzAbbr } from '../api';
import { useTz } from '../settings';
import {
  addWatchRule,
  newWatchRule,
  removeWatchRule,
  updateWatchRule,
  useWatchRules,
} from '../watchRules';
import type { WatchRule, WatchTrigger } from '../types';

/**
 * Watch-rules sidebar: define alerts that fire on newly-tailed lines — a
 * `match` rule on a query, or a `rate` rule (matches per time window). Rules are
 * persisted per file and evaluated by the backend while the file is tailing.
 * The lower half lists this file's recent alerts; clicking one jumps to the
 * matching line.
 */
export default function WatchPanel({
  file,
  tailing,
  triggers,
  onJumpToLine,
  onClose,
}: {
  file: string;
  tailing: boolean;
  /** This session's recent triggers, newest first. */
  triggers: WatchTrigger[];
  onJumpToLine: (lineNo: number) => void;
  onClose: () => void;
}) {
  const rules = useWatchRules(file);
  const tz = useTz();

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-edge bg-surface-1">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <div className="text-sm font-semibold text-gray-200">
          Watch rules
          {rules.length > 0 && <span className="ml-1 text-xs font-normal text-gray-500">· {rules.length}</span>}
        </div>
        <button
          onClick={onClose}
          className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200"
          title="Close watch rules"
        >
          ×
        </button>
      </div>

      {!tailing && (
        <div className="border-b border-edge bg-amber-950/40 px-3 py-1.5 text-[11px] text-amber-300/90">
          Rules only fire while tailing — turn on <span className="font-medium">Tail</span> to start monitoring.
        </div>
      )}

      <div className="flex items-center gap-1.5 border-b border-edge px-2 py-1.5">
        <button
          onClick={() => addWatchRule(file, newWatchRule('match'))}
          className="rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
          title="Alert when a line matches a query"
        >
          + Match rule
        </button>
        <button
          onClick={() => addWatchRule(file, newWatchRule('rate'))}
          className="rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
          title="Alert when matches exceed a rate"
        >
          + Rate rule
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rules.length === 0 ? (
          <div className="px-3 py-3 text-xs leading-relaxed text-gray-500">
            No watch rules yet. Add one to be alerted when matching lines arrive — e.g. a{' '}
            <span className="font-mono text-gray-400">level:error</span> match rule, or a rate rule that fires when
            errors exceed a threshold per minute.
          </div>
        ) : (
          <ul className="divide-y divide-edge/60">
            {rules.map((rule) => (
              <RuleEditor key={rule.id} file={file} rule={rule} />
            ))}
          </ul>
        )}

        {triggers.length > 0 && (
          <div className="border-t border-edge">
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Recent alerts
            </div>
            <ul className="pb-2">
              {triggers.slice(0, 50).map((t, i) => (
                <li key={`${t.ruleId}-${t.at}-${i}`}>
                  <button
                    onClick={() => t.sample && onJumpToLine(t.sample.lineNo)}
                    disabled={!t.sample}
                    className="block w-full px-3 py-1.5 text-left hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
                    title={t.sample ? 'Jump to the matching line' : undefined}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs font-medium text-amber-300">{t.ruleName}</span>
                      <span className="shrink-0 font-mono text-[10px] text-gray-500">
                        {formatTs(t.at, tz).slice(11, 19)}
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-500">
                      {t.kind === 'rate'
                        ? `${t.count} matches in ${t.windowSec}s (≥ ${t.threshold})`
                        : `${t.count} new ${t.count === 1 ? 'match' : 'matches'}`}
                    </div>
                    {t.sample && (
                      <div className="truncate font-mono text-[11px] text-gray-400">{t.sample.text}</div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="border-t border-edge px-3 py-1 text-right text-[10px] text-gray-600">
        times in {tzAbbr(Date.now(), tz)}
      </div>
    </aside>
  );
}

/** One rule's inline editor. */
function RuleEditor({ file, rule }: { file: string; rule: WatchRule }) {
  const set = (patch: Partial<WatchRule>): void => updateWatchRule(file, rule.id, patch);
  const inputCls =
    'w-full rounded border border-edge bg-surface-0 px-2 py-1 text-xs text-gray-100 outline-none focus:border-sky-600';

  return (
    <li className={`px-3 py-2 ${rule.enabled ? '' : 'opacity-50'}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <button
          onClick={() => set({ enabled: !rule.enabled })}
          className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${rule.enabled ? 'bg-emerald-600' : 'bg-surface-3'}`}
          title={rule.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${rule.enabled ? 'left-3.5' : 'left-0.5'}`}
          />
        </button>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${rule.kind === 'rate' ? 'bg-purple-950 text-purple-300' : 'bg-sky-950 text-sky-300'}`}>
          {rule.kind}
        </span>
        <input
          value={rule.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Name (optional)"
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-gray-200 outline-none placeholder:text-gray-600 hover:border-edge focus:border-sky-600"
        />
        <button
          onClick={() => removeWatchRule(file, rule.id)}
          className="shrink-0 rounded px-1 text-gray-600 hover:text-red-300"
          title="Delete rule"
        >
          ×
        </button>
      </div>

      <input
        value={rule.query}
        onChange={(e) => set({ query: e.target.value })}
        placeholder="Query…  e.g.  level:error"
        spellCheck={false}
        autoComplete="off"
        className={`${inputCls} font-mono placeholder:font-sans placeholder:text-gray-600`}
      />

      {rule.kind === 'rate' && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-gray-400">
          <span>fire at</span>
          <input
            type="number"
            min={1}
            value={rule.threshold}
            onChange={(e) => set({ threshold: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })}
            className="w-14 rounded border border-edge bg-surface-0 px-1.5 py-0.5 text-xs text-gray-100 outline-none focus:border-sky-600"
          />
          <span>matches per</span>
          <input
            type="number"
            min={1}
            value={rule.windowSec}
            onChange={(e) => set({ windowSec: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })}
            className="w-16 rounded border border-edge bg-surface-0 px-1.5 py-0.5 text-xs text-gray-100 outline-none focus:border-sky-600"
          />
          <span>sec</span>
        </div>
      )}

      <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-gray-500">
        <input
          type="checkbox"
          checked={rule.desktop}
          onChange={(e) => set({ desktop: e.target.checked })}
          className="h-3 w-3 accent-sky-600"
        />
        Also send a desktop notification
      </label>
    </li>
  );
}
