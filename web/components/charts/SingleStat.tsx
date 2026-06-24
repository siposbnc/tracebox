import { formatMetricFull, metricLabel, seriesColor, seriesLabel } from './util';
import type { AggregateResult, AggregateSpec } from '../../types';
import { ALL_SERIES } from '../../types';

/**
 * One big number — the metric over the whole scoped query (groupBy: none). When
 * split into series, shows each series beneath the (summed) headline.
 */
export default function SingleStat({ data, spec }: { data: AggregateResult; spec: AggregateSpec }) {
  const row = data.rows[0];
  if (!row) return <div className="grid h-full place-items-center text-xs text-gray-500">No data</div>;
  const split = data.series.length > 1 || data.series[0] !== ALL_SERIES;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-1">
      <div className="text-4xl font-semibold tabular-nums text-gray-100">{formatMetricFull(row.total)}</div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{metricLabel(spec.metric)}</div>
      {split && (
        <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[11px] text-gray-400">
          {data.series.map((s, i) => (
            <span key={s} className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: seriesColor(s, i) }} />
              {seriesLabel(s)}
              <span className="font-semibold text-gray-300">{formatMetricFull(row.values[s] ?? 0)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
