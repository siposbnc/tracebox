import { formatTs } from '../../api';
import { useTz } from '../../settings';
import type { AggregateResult } from '../../types';
import { ALL_SERIES } from '../../types';
import { formatMetricFull, seriesColor, seriesLabel } from './util';

/**
 * Tabular view of an {@link AggregateResult}: one row per group, a column per
 * series, plus a total. The fallback that shows the exact numbers behind a chart.
 */
export default function DataTable({ data }: { data: AggregateResult }) {
  const tz = useTz();
  const { rows, series } = data;
  if (rows.length === 0) return <div className="grid h-full place-items-center text-xs text-gray-500">No data</div>;
  const showSeries = series.length > 1 || series[0] !== ALL_SERIES;
  const keyHeader = data.groupKind === 'time' ? 'time' : data.groupKind === 'none' ? '' : 'group';

  const label = (key: string | number): string =>
    data.groupKind === 'time' ? formatTs(Number(key), tz) : String(key);

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead className="sticky top-0 bg-surface-1 text-left text-gray-500">
          <tr className="border-b border-edge">
            {keyHeader !== '' && <th className="px-2 py-1 font-medium">{keyHeader}</th>}
            {showSeries &&
              series.map((s, i) => (
                <th key={s} className="px-2 py-1 text-right font-medium">
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm" style={{ background: seriesColor(s, i) }} />
                    {seriesLabel(s)}
                  </span>
                </th>
              ))}
            <th className="px-2 py-1 text-right font-medium">total</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums text-gray-300">
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-edge/40 hover:bg-surface-2/50">
              {keyHeader !== '' && <td className="max-w-[260px] truncate px-2 py-1 font-sans">{label(r.key)}</td>}
              {showSeries &&
                series.map((s) => (
                  <td key={s} className="px-2 py-1 text-right">
                    {r.values[s] != null ? formatMetricFull(r.values[s]) : '—'}
                  </td>
                ))}
              <td className="px-2 py-1 text-right font-semibold">{formatMetricFull(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
