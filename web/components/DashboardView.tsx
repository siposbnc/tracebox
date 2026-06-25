import { useEffect, useRef, useState } from 'react';
import { clientStore } from '../clientStore';
import {
  deleteDashboard,
  newDashboard,
  newPanel,
  saveDashboard,
  useDashboards,
} from '../dashboards';
import type { Dashboard, Panel } from '../types';
import { metricLabel } from './charts/util';
import ChartPanel from './charts/ChartPanel';
import PanelEditor from './PanelEditor';

const DRAFT_KEY = 'tracebox.dashboard.draft';

/** One-line description of what a panel charts, for the card subheader. */
function specSummary(panel: Panel): string {
  const { groupBy, splitBy, metric } = panel.spec;
  const by =
    groupBy.type === 'time' ? 'over time' : groupBy.type === 'field' ? `by ${groupBy.field}` : '';
  const split = splitBy ? ` · split ${splitBy.type === 'level' ? 'by level' : `by ${splitBy.field}`}` : '';
  const scope = panel.query ? ` · ${panel.query}` : '';
  return `${metricLabel(metric)} ${by}${split}${scope}`.trim();
}

function loadDraft(): Dashboard {
  try {
    const raw = clientStore.getItem(DRAFT_KEY);
    if (raw) return JSON.parse(raw) as Dashboard;
  } catch {
    /* fall through */
  }
  return newDashboard('Untitled dashboard');
}

/**
 * The dashboard view: a grid of user-configured chart panels over the active
 * file. Working state is held here (persisted as a draft so toggling the view
 * keeps it) and can be saved as a named, reusable dashboard.
 */
export default function DashboardView({ sessionId, fields }: { sessionId: string; fields: string[] }) {
  const saved = useDashboards();
  const [dash, setDash] = useState<Dashboard>(loadDraft);
  const [editing, setEditing] = useState<Panel | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const firstRender = useRef(true);

  // persist the working draft so leaving and re-entering the view keeps it
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    clientStore.setItem(DRAFT_KEY, JSON.stringify(dash));
  }, [dash]);

  const isSaved = saved.some((d) => d.id === dash.id);

  const upsertPanel = (panel: Panel): void => {
    setDash((d) => {
      const exists = d.panels.some((p) => p.id === panel.id);
      return { ...d, panels: exists ? d.panels.map((p) => (p.id === panel.id ? panel : p)) : [...d.panels, panel] };
    });
    setEditing(null);
  };

  const removePanel = (id: string): void => setDash((d) => ({ ...d, panels: d.panels.filter((p) => p.id !== id) }));

  const openSaved = (id: string): void => {
    const found = saved.find((d) => d.id === id);
    if (found) setDash(structuredClone(found));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface-0">
      {/* dashboard bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-edge bg-surface-1 px-3 py-1.5">
        <input
          className="w-48 rounded border border-edge bg-surface-2 px-2 py-1 text-sm font-medium text-gray-200 outline-none focus:border-sky-600"
          value={dash.name}
          onChange={(e) => setDash((d) => ({ ...d, name: e.target.value }))}
          placeholder="Dashboard name"
        />
        {saved.length > 0 && (
          <select
            className="rounded border border-edge bg-surface-2 px-2 py-1 text-sm text-gray-300 outline-none"
            value={isSaved ? dash.id : ''}
            onChange={(e) => e.target.value && openSaved(e.target.value)}
            title="Open a saved dashboard"
          >
            <option value="">Open…</option>
            {saved.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => setDash(newDashboard('Untitled dashboard'))}
            className="rounded px-2 py-1 text-sm text-gray-400 hover:bg-surface-2 hover:text-gray-200"
          >
            New
          </button>
          <button
            onClick={() => saveDashboard(dash)}
            className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-white hover:bg-sky-500"
            title="Save this dashboard by name (re-runnable on any file)"
          >
            Save
          </button>
          {isSaved && (
            <button
              onClick={() => {
                deleteDashboard(dash.id);
                setDash(newDashboard('Untitled dashboard'));
              }}
              className="rounded px-2 py-1 text-sm text-gray-400 hover:bg-surface-2 hover:text-red-400"
            >
              Delete
            </button>
          )}
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="rounded px-2 py-1 text-sm text-gray-400 hover:bg-surface-2 hover:text-gray-200"
            title="Re-run all panels"
          >
            ↻
          </button>
          <button
            onClick={() => setEditing(newPanel())}
            className="rounded border border-edge px-3 py-1 text-sm font-medium text-gray-200 hover:bg-surface-2"
          >
            + Add panel
          </button>
        </div>
      </div>

      {/* panel grid */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {dash.panels.length === 0 ? (
          <div className="grid h-full place-items-center text-center text-sm text-gray-500">
            <div>
              <p>No panels yet.</p>
              <button
                onClick={() => setEditing(newPanel())}
                className="mt-2 rounded border border-edge px-3 py-1 text-gray-300 hover:bg-surface-2"
              >
                + Add your first panel
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {dash.panels.map((panel) => (
              <div
                key={panel.id}
                className={`flex flex-col rounded-lg border border-edge bg-surface-1 ${panel.w === 2 ? 'lg:col-span-2' : ''}`}
              >
                <div className="flex items-start justify-between gap-2 border-b border-edge px-3 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-gray-200">{panel.title}</div>
                    <div className="truncate text-[11px] text-gray-500">{specSummary(panel)}</div>
                  </div>
                  <div className="flex shrink-0 gap-1 text-gray-500">
                    <button onClick={() => setEditing(panel)} className="hover:text-gray-200" title="Edit panel">
                      ✎
                    </button>
                    <button onClick={() => removePanel(panel.id)} className="hover:text-red-400" title="Remove panel">
                      ✕
                    </button>
                  </div>
                </div>
                <div className="h-[260px] p-2">
                  <ChartPanel sessionId={sessionId} panel={panel} refreshKey={refreshKey} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <PanelEditor panel={editing} fields={fields} onSave={upsertPanel} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
