import { useEffect, useRef, useState } from 'react';
import { useEscapeKey } from '../escStack';

/** Compact "go to line N" prompt, opened with Ctrl/Cmd+G. */
export default function GoToLine({
  lineCount,
  onGo,
  onClose,
}: {
  lineCount: number;
  onGo: (lineNo: number) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEscapeKey(onClose, 'modal');

  const submit = (): void => {
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && n >= 1) onGo(Math.min(n, lineCount) - 1);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center" onClick={onClose}>
      <div
        className="mt-24 w-72 rounded-lg border border-edge bg-surface-2 p-3 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <label className="mb-1 block text-xs text-gray-400">
          Go to line <span className="text-gray-600">(1–{lineCount.toLocaleString()})</span>
        </label>
        <input
          ref={inputRef}
          value={value}
          inputMode="numeric"
          autoComplete="off"
          onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="line number"
          className="w-full rounded border border-edge bg-surface-0 px-2 py-1 font-mono text-sm text-gray-100 outline-none focus:border-sky-600"
        />
      </div>
    </div>
  );
}
