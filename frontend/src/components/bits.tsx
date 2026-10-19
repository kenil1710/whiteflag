import { STATUS_LABEL } from "@/lib/format";

export function Stamp({ status }: { status: string }) {
  const cls = status === "OPEN" ? "stamp-open" : status === "SETTLED_FULL" ? "stamp-full" : status === "SETTLED_PARTIAL" ? "stamp-partial" : status === "REJECTED" ? "stamp-reject" : "stamp-none";
  return <span className={`stamp ${cls}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Bar({ ppm, large = false, label }: { ppm: number; large?: boolean; label?: string }) {
  const w = Math.max(0, Math.min(100, ppm / 10_000));
  return (
    <div className={`bar${large ? " bar-lg" : ""}`} role="img" aria-label={label ?? `${w.toFixed(2)}% returned`}>
      <span style={{ width: `${w}%` }} />
    </div>
  );
}

export function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}
