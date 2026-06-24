import { seriesColor, seriesLabel } from './util';
import { ALL_SERIES } from '../../types';

/** A compact series legend; hidden when there's only the no-split sentinel series. */
export default function Legend({ series }: { series: string[] }) {
  if (series.length <= 1 && series[0] === ALL_SERIES) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 pt-1 text-[10px] text-gray-400">
      {series.map((s, i) => (
        <span key={s} className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: seriesColor(s, i) }} />
          {seriesLabel(s)}
        </span>
      ))}
    </div>
  );
}
