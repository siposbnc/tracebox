import type { ReactNode } from 'react';
import { patchNotes } from '../patchnotes';
import { compareVersions } from '../version';
import { Logo } from './Logo';

const CATEGORY_COLOR: Record<string, string> = {
  Added: 'text-emerald-300',
  Changed: 'text-sky-300',
  Deprecated: 'text-gray-400',
  Removed: 'text-red-300',
  Fixed: 'text-amber-300',
  Security: 'text-fuchsia-300',
};

/** Render inline `code` spans from a changelog bullet; everything else is plain text. */
function renderInline(text: string): ReactNode {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith('`') && part.endsWith('`') ? (
      <code key={i} className="rounded bg-surface-0 px-1 py-0.5 font-mono text-[0.85em] text-sky-300">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

export default function WhatsNew({
  onClose,
  sinceVersion,
}: {
  onClose: () => void;
  /** The newest version the user had already seen; versions above it are flagged "New". */
  sinceVersion: string | null;
}) {
  return (
    <div className="h-full overflow-y-auto bg-surface-0">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <div className="mb-6 flex items-center gap-3">
          <Logo className="h-8 w-8" />
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight text-gray-100">What's new</h1>
            <p className="text-sm text-gray-500">Changes and fixes in TraceBox</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-edge bg-surface-2 px-3 py-1.5 text-sm text-gray-400 hover:text-gray-100"
          >
            Close
          </button>
        </div>

        {patchNotes.length === 0 && (
          <p className="text-sm text-gray-500">No release notes available.</p>
        )}

        {patchNotes.map((note) => {
          const isNew = sinceVersion !== null && compareVersions(note.version, sinceVersion) > 0;
          return (
            <section key={note.version} className="mb-8">
              <div className="mb-3 flex items-baseline gap-3 border-b border-edge pb-1.5">
                <h2 className="text-lg font-semibold text-gray-100">Version {note.version}</h2>
                {note.date && <span className="text-xs text-gray-500">{note.date}</span>}
                {isNew && (
                  <span className="rounded bg-sky-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                    New
                  </span>
                )}
              </div>

              {note.sections.map((section) => (
                <div key={section.title} className="mb-4">
                  <h3
                    className={`mb-1.5 text-xs font-semibold uppercase tracking-wider ${
                      CATEGORY_COLOR[section.title] ?? 'text-gray-400'
                    }`}
                  >
                    {section.title}
                  </h3>
                  <ul className="space-y-1.5">
                    {section.items.map((item, i) => (
                      <li key={i} className="flex gap-2 text-sm leading-6 text-gray-300">
                        <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-gray-600" />
                        <span>{renderInline(item)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
