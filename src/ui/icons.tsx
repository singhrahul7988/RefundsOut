// Inline stroke icons used across the app (18px grid unless noted).
type P = { className?: string; size?: number };
const base = (size = 18) => ({ width: size, height: size, viewBox: "0 0 18 18", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true });

export const IconImport = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><path d="M9 11.5 V3 M5.5 6.5 L9 3 L12.5 6.5 M3 11.5 V14 a1.5 1.5 0 0 0 1.5 1.5 H13.5 A1.5 1.5 0 0 0 15 14 V11.5" /></svg>
);
export const IconPolicy = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><rect x="3.5" y="2.5" width="11" height="13" rx="1.5" /><path d="M6.5 6.5 H11.5 M6.5 9.5 H11.5 M6.5 12.5 H9.5" /></svg>
);
export const IconReview = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><rect x="2.5" y="3.5" width="13" height="11" rx="1.5" /><path d="M2.5 7.5 H15.5 M2.5 11 H15.5 M7 7.5 V14.5" /></svg>
);
export const IconRun = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><circle cx="9" cy="9" r="6.5" /><path d="M7.5 6.5 L11.5 9 L7.5 11.5 Z" /></svg>
);
export const IconReconcile = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><path d="M3 5 H15 M3 9 H11 M3 13 H7.5 M10.5 13 L12.5 15 L15.5 11" /></svg>
);
export const IconMail = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><rect x="2.5" y="4" width="13" height="10" rx="1.5" /><path d="M3 5 L9 9.5 L15 5" /></svg>
);
export const IconClock = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><circle cx="9" cy="9" r="6.5" /><path d="M9 5.5 V9 L11.5 10.5" /></svg>
);
export const IconLink = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><path d="M7.5 10.5 L10.5 7.5 M8 5.5 L9.5 4 a2.8 2.8 0 0 1 4 4 L12 9.5 M10 12.5 L8.5 14 a2.8 2.8 0 0 1 -4 -4 L6 8.5" /></svg>
);
export const IconLock = ({ className, size = 14 }: P) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} className={className} aria-hidden>
    <rect x="2.5" y="6" width="9" height="6.5" rx="1.2" /><path d="M4.5 6 V4.5 a2.5 2.5 0 0 1 5 0 V6" />
  </svg>
);
export const IconCheckCircle = ({ className, size = 16 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden>
    <circle cx="8" cy="8" r="7" fill="currentColor" /><path d="M5 8.2 L7.1 10.2 L11 6" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const IconXCircle = ({ className, size = 16 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden>
    <circle cx="8" cy="8" r="7" fill="currentColor" /><path d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
export const IconTrash = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><path d="M3 5 H15 M7 5 V3.5 A1 1 0 0 1 8 2.5 H10 A1 1 0 0 1 11 3.5 V5 M4.5 5 L5.3 14.6 A1.5 1.5 0 0 0 6.8 16 H11.2 A1.5 1.5 0 0 0 12.7 14.6 L13.5 5 M7.5 8 V13 M10.5 8 V13" /></svg>
);
export const IconChevronLeft =({ className, size }: P) => (
  <svg {...base(size)} className={className}><path d="M11 4 L6 9 L11 14" /></svg>
);
export const IconSwap = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><path d="M3.5 6 H14 M11 3 L14 6 L11 9 M14.5 12 H4 M7 9 L4 12 L7 15" /></svg>
);
export const IconChevronUpDown = ({ className }: P) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M5 6 L8 3.5 L11 6 M5 10 L8 12.5 L11 10" />
  </svg>
);
export const IconShield = ({ className, size = 20 }: P) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M10 2.5 L16 5 V9.5 C16 13.5 13.5 16.2 10 17.5 C6.5 16.2 4 13.5 4 9.5 V5 Z" /><path d="M7.5 10 L9.3 11.8 L12.8 8.3" />
  </svg>
);
export const IconSparkle = ({ className, size = 16 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
    <path d="M8 1.5 L9.4 6.1 L14 7.5 L9.4 8.9 L8 13.5 L6.6 8.9 L2 7.5 L6.6 6.1 Z" />
  </svg>
);

export function Logo({ className }: { className?: string }) {
  return (
    <svg width="26" height="26" viewBox="0 0 28 28" className={className} aria-hidden>
      <rect x="1" y="1" width="26" height="26" rx="7" fill="#0B6E55" />
      <path d="M9 19 L19 9 M12 9 H19 V16" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
