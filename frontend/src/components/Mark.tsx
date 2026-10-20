/** The logo (public/logo.svg): a white flag on a straight pole whose lower and trailing edges are a check mark. */
export function Mark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <g transform="translate(-1.5 0)">
        <path d="M19 12 H52 L30.5 40 L19 33 Z" fill="#fff" stroke="var(--ink)" strokeWidth="3" strokeLinejoin="round" />
        <path d="M19 33 L30.5 40 L52 12" fill="none" stroke="var(--flag)" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M17 9 V55" stroke="var(--ink)" strokeWidth="4.4" strokeLinecap="round" />
      </g>
    </svg>
  );
}
