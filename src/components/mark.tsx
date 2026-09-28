export function Mark({ className = "", size = 26 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" className={className} aria-hidden>
      <rect x="1" y="1" width="24" height="24" rx="6.5" fill="#0071e3" />
      <path d="M6 15.5 L11 9.5 L15 13.5 L20 8" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 18.5 H20" stroke="#cfe4ff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
