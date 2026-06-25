import { useState } from 'react';
import type { AggregateSpec, ChartType, MetricFn, Panel } from '../types';

/**
 * Modal editor for a single dashboard panel: chart type, scoping query, the
 * group-by dimension, the metric, and an optional series split. The form keeps
 * the spec coherent with the chosen chart (e.g. line charts group by time,
 * single-stat doesn't group).
 */

const CHARTS: { value: ChartType; label: string }[] = [
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'bar', label: 'Bar' },
  { value: 'pie', label: 'Pie' },
  { value: 'table', label: 'Table' },
  { value: 'stat', label: 'Single stat' },
];

type GroupType = 'time' | 'field' | 'none';

/** Which group-by dimensions each chart type supports (first is its default). */
function allowedGroups(chart: ChartType): GroupType[] {
  switch (chart) {
    case 'line':
    case 'area':
      return ['time'];
    case 'pie':
      return ['field'];
    case 'stat':
      return ['none'];
    case 'bar':
      return ['field', 'time'];
    case 'table':
      return ['field', 'time', 'none'];
  }
}

/** Charts that render multiple series (so the split control is shown). */
function canSplitChart(chart: ChartType): boolean {
  return chart !== 'pie' && chart !== 'stat';
}

const METRICS: { value: string; label: string }[] = [
  { value: 'count', label: 'Count' },
  { value: 'unique', label: 'Unique count' },
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'p50', label: 'Median (p50)' },
  { value: 'p95', label: 'p95' },
];

const NUMERIC_FNS = new Set<MetricFn>(['sum', 'avg', 'min', 'max', 'p50', 'p95']);

const labelCls = 'block text-[11px] font-medium uppercase tracking-wide text-gray-500';
const inputCls =
  'mt-1 w-full rounded border border-edge bg-surface-2 px-2 py-1 text-sm text-gray-200 outline-none focus:border-sky-600';

export default function PanelEditor({
  panel,
  fields,
  onSave,
  onClose,
}: {
  panel: Panel;
  fields: string[];
  onSave: (panel: Panel) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Panel>(panel);

  const setSpec = (spec: AggregateSpec): void => setDraft((d) => ({ ...d, spec }));
  const groupType: GroupType = draft.spec.groupBy.type;
  const metricType =
    draft.spec.metric.type === 'numeric' ? draft.spec.metric.fn : draft.spec.metric.type;
  const splitType = !draft.spec.splitBy ? 'none' : draft.spec.splitBy.type;

  const changeChart = (chart: ChartType): void => {
    const allowed = allowedGroups(chart);
    let groupBy = draft.spec.groupBy;
    if (!allowed.includes(groupBy.type)) {
      const t = allowed[0];
      groupBy =
        t === 'time'
          ? { type: 'time', buckets: 60 }
          : t === 'field'
            ? { type: 'field', field: firstField(), limit: 12 }
            : { type: 'none' };
    }
    // pie/single-stat don't show the series control — drop any hidden split so it
    // doesn't silently affect the result (e.g. a summed single-stat headline).
    const splitBy = canSplitChart(chart) ? draft.spec.splitBy : undefined;
    setDraft((d) => ({ ...d, chart, spec: { ...d.spec, groupBy, splitBy } }));
  };

  const firstField = (): string => fields[0] ?? '';

  const changeGroupType = (t: GroupType): void => {
    const groupBy =
      t === 'time'
        ? { type: 'time' as const, buckets: 60 }
        : t === 'field'
          ? { type: 'field' as const, field: firstField(), limit: 12 }
          : { type: 'none' as const };
    setSpec({ ...draft.spec, groupBy });
  };

  const changeMetric = (m: string): void => {
    if (m === 'count') setSpec({ ...draft.spec, metric: { type: 'count' } });
    else if (m === 'unique') setSpec({ ...draft.spec, metric: { type: 'unique', field: metricField() } });
    else setSpec({ ...draft.spec, metric: { type: 'numeric', field: metricField(), fn: m as MetricFn } });
  };

  const metricField = (): string => {
    const m = draft.spec.metric;
    return m.type === 'count' ? firstField() : m.field;
  };

  const changeSplit = (t: 'none' | 'level' | 'field'): void => {
    const splitBy = t === 'none' ? undefined : t === 'level' ? { type: 'level' as const } : { type: 'field' as const, field: firstField(), limit: 8 };
    setSpec({ ...draft.spec, splitBy });
  };

  const needsMetricField = draft.spec.metric.type !== 'count';
  const allowed = allowedGroups(draft.chart);
  const canSplit = canSplitChart(draft.chart);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border border-edge bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-2">
          <h2 className="text-sm font-semibold text-gray-200">{panel.title ? 'Edit panel' : 'New panel'}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300" title="Close">
            ✕
          </button>
        </div>

        <div className="grid max-h-[70vh] grid-cols-2 gap-3 overflow-auto p-4">
          <label className="col-span-2">
            <span className={labelCls}>Title</span>
            <input
              className={inputCls}
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              placeholder="Panel title"
            />
          </label>

          <label>
            <span className={labelCls}>Chart</span>
            <select className={inputCls} value={draft.chart} onChange={(e) => changeChart(e.target.value as ChartType)}>
              {CHARTS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className={labelCls}>Width</span>
            <select
              className={inputCls}
              value={draft.w ?? 1}
              onChange={(e) => setDraft((d) => ({ ...d, w: Number(e.target.value) as 1 | 2 }))}
            >
              <option value={1}>Half</option>
              <option value={2}>Full</option>
            </select>
          </label>

          <label className="col-span-2">
            <span className={labelCls}>Scoping query</span>
            <input
              className={`${inputCls} font-mono`}
              value={draft.query}
              onChange={(e) => setDraft((d) => ({ ...d, query: e.target.value }))}
              placeholder="(whole file) — e.g. level:error AND status:>=500"
            />
          </label>

          <label>
            <span className={labelCls}>Group by</span>
            <select
              className={inputCls}
              value={groupType}
              disabled={allowed.length === 1}
              onChange={(e) => changeGroupType(e.target.value as GroupType)}
            >
              {allowed.map((t) => (
                <option key={t} value={t}>
                  {t === 'time' ? 'Time' : t === 'field' ? 'Field value' : 'Nothing (single value)'}
                </option>
              ))}
            </select>
          </label>

          {groupType === 'time' && (
            <label>
              <span className={labelCls}>Time buckets</span>
              <input
                type="number"
                min={10}
                max={1000}
                className={inputCls}
                value={draft.spec.groupBy.type === 'time' ? draft.spec.groupBy.buckets ?? 60 : 60}
                onChange={(e) => setSpec({ ...draft.spec, groupBy: { type: 'time', buckets: Number(e.target.value) } })}
              />
            </label>
          )}

          {groupType === 'field' && (
            <label>
              <span className={labelCls}>Field</span>
              <FieldSelect
                fields={fields}
                value={draft.spec.groupBy.type === 'field' ? draft.spec.groupBy.field : ''}
                onChange={(field) => setSpec({ ...draft.spec, groupBy: { type: 'field', field, limit: 12 } })}
              />
            </label>
          )}

          <label>
            <span className={labelCls}>Metric</span>
            <select className={inputCls} value={metricType} onChange={(e) => changeMetric(e.target.value)}>
              {METRICS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          {needsMetricField && (
            <label>
              <span className={labelCls}>{NUMERIC_FNS.has(metricType as MetricFn) ? 'Numeric field' : 'Field'}</span>
              <FieldSelect
                fields={fields}
                value={draft.spec.metric.type !== 'count' ? draft.spec.metric.field : ''}
                onChange={(field) =>
                  setSpec({
                    ...draft.spec,
                    metric:
                      draft.spec.metric.type === 'unique'
                        ? { type: 'unique', field }
                        : { type: 'numeric', field, fn: metricType as MetricFn },
                  })
                }
              />
            </label>
          )}

          {canSplit && (
            <>
              <label>
                <span className={labelCls}>Split into series</span>
                <select
                  className={inputCls}
                  value={splitType}
                  onChange={(e) => changeSplit(e.target.value as 'none' | 'level' | 'field')}
                >
                  <option value="none">None</option>
                  <option value="level">By level</option>
                  <option value="field">By field</option>
                </select>
              </label>
              {splitType === 'field' && (
                <label>
                  <span className={labelCls}>Series field</span>
                  <FieldSelect
                    fields={fields}
                    value={draft.spec.splitBy?.type === 'field' ? draft.spec.splitBy.field : ''}
                    onChange={(field) => setSpec({ ...draft.spec, splitBy: { type: 'field', field, limit: 8 } })}
                  />
                </label>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-edge px-4 py-2">
          <button onClick={onClose} className="rounded px-3 py-1 text-sm text-gray-400 hover:text-gray-200">
            Cancel
          </button>
          <button
            onClick={() => onSave({ ...draft, title: draft.title.trim() || 'Untitled' })}
            className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-white hover:bg-sky-500"
          >
            Save panel
          </button>
        </div>
      </div>
    </div>
  );
}

/** A field picker that also accepts a free-typed field name (datalist). */
function FieldSelect({
  fields,
  value,
  onChange,
}: {
  fields: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [listId] = useState(() => `fields-${Math.random().toString(36).slice(2, 8)}`);
  return (
    <>
      <input
        className={inputCls}
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="field name"
      />
      <datalist id={listId}>
        {fields.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </>
  );
}
