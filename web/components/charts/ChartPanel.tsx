import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { AggregateResult, Panel } from '../../types';
import LineChart from './LineChart';
import BarChart from './BarChart';
import PieChart from './PieChart';
import SingleStat from './SingleStat';
import DataTable from './DataTable';

/**
 * Runs a panel's aggregation against a session and renders the chart for its
 * type. Re-fetches when the panel's query/spec change or `refreshKey` bumps.
 */
export default function ChartPanel({
  sessionId,
  panel,
  refreshKey = 0,
}: {
  sessionId: string;
  panel: Panel;
  refreshKey?: number;
}) {
  const [data, setData] = useState<AggregateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const specKey = JSON.stringify(panel.spec);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .aggregate(sessionId, panel.query, panel.spec)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, panel.query, specKey, refreshKey]);

  if (error)
    return (
      <div className="grid h-full place-items-center px-3 text-center text-[11px] text-red-400">{error}</div>
    );
  if (loading && !data)
    return <div className="grid h-full place-items-center text-xs text-gray-500">Loading…</div>;
  if (!data) return null;

  switch (panel.chart) {
    case 'line':
      return <LineChart data={data} />;
    case 'area':
      return <LineChart data={data} area />;
    case 'bar':
      return <BarChart data={data} />;
    case 'pie':
      return <PieChart data={data} />;
    case 'stat':
      return <SingleStat data={data} spec={panel.spec} />;
    case 'table':
      return <DataTable data={data} />;
    default:
      return null;
  }
}
