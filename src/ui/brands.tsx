// Brand marks for the "Built with" footer.
// PayPal and Gemini: Simple Icons (CC0). AG Grid: the mark from the logo shipped in the ag-grid-enterprise package.
type P = { className?: string; size?: number };

export const PayPalMark = ({ className, size = 16 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
    <path fill="#002991" d="M7.016 19.198h-4.2a.562.562 0 0 1-.555-.65L5.093.584A.692.692 0 0 1 5.776 0h7.222c3.417 0 5.904 2.488 5.846 5.5-.006.25-.027.5-.066.747A6.794 6.794 0 0 1 12.071 12H8.743a.69.69 0 0 0-.682.583l-.325 2.056-.013.083-.692 4.39-.015.087z" />
    <path fill="#0070E0" d="M19.79 6.142c-.01.087-.01.175-.023.261a7.76 7.76 0 0 1-7.695 6.598H9.007l-.283 1.795-.013.083-.692 4.39-.134.843-.014.088H6.86l-.497 3.15a.562.562 0 0 0 .555.65h3.612c.34 0 .63-.249.683-.585l.952-6.031a.692.692 0 0 1 .683-.584h2.126a6.793 6.793 0 0 0 6.707-5.752c.306-1.95-.466-3.744-1.89-4.906z" />
  </svg>
);

export const GeminiMark = ({ className, size = 16 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
    <defs>
      <linearGradient id="ro-gemini-grad" x1="0" y1="24" x2="24" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#1C7DFF" />
        <stop offset="0.52" stopColor="#1C69FF" />
        <stop offset="1" stopColor="#B07CFF" />
      </linearGradient>
    </defs>
    <path fill="url(#ro-gemini-grad)" d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
  </svg>
);

export const AgGridMark = ({ className, size = 16 }: P) => (
  <svg width={size * (52 / 36)} height={size} viewBox="157 0 52 36" className={className} aria-hidden>
    <path fill="#14171C" d="M192.993 23.658v-7.946h-13.541l-7.947 7.946zM208.25 3.95h-16.974l-8.01 7.947h24.984zM163.622 31.605l4.069-4.069h13.732v7.947h-17.801zM166.61 19.78h8.773l8.01-7.946H166.61zM157.011 31.605h6.611l7.883-7.947h-14.494zM191.276 3.95l-4.068 4.07H161.27V.072h30.006z" />
  </svg>
);

export const Heart = ({ className, size = 14 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
    <path fill="currentColor" d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.08C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.54z" />
  </svg>
);
