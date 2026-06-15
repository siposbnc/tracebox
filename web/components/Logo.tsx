export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="2" y="2" width="28" height="28" rx="7" fill="#0ea5e9" />
      <path
        d="M8 11h16M8 16h10M8 21h13"
        stroke="#082f49"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
