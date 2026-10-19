/** The white flag: a staff and a pennant, the pennant in signal orange. */
export function Mark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 34 34" aria-hidden="true">
      <rect x="7" y="3" width="2.2" height="28" fill="var(--ink)" />
      <path d="M9.2 4.5 C 15 2.5, 19 7.5, 28 5 L 28 18 C 19 20.5, 15 15.5, 9.2 17.5 Z" fill="var(--flag)" />
      <path d="M9.2 4.5 C 15 2.5, 19 7.5, 28 5" fill="none" stroke="var(--ink)" strokeWidth="0.8" />
    </svg>
  );
}
