"use client";
import { useEffect, useState } from "react";
import { short, studioAddr } from "@/lib/format";

type Row = { name: string; address: string; file: string; commit: string; source_url: string; chain_sha256?: string; file_sha256?: string; recorded_sha256?: string; bytes?: number; identical: boolean; error?: string };

export function VerifyTable() {
  const [d, setD] = useState<{ checked_at: string; all_identical: boolean; contracts: Row[] } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { fetch("/api/verify").then((r) => r.json()).then(setD).catch((e) => setErr(String(e))); }, []);
  if (err) return <p className="note note-flag">{err}</p>;
  if (!d) return <p className="mono muted">Reading four contracts from Studio Dev and four files from GitHub…</p>;
  return (
    <div>
      <div className="figure-md" style={{ marginBottom: 18 }}>{d.all_identical ? <span className="green">All identical.</span> : <span className="flag-text">Mismatch.</span>}</div>
      <div className="table-wrap"><table className="ledger">
        <thead><tr><th>Contract</th><th>Address</th><th>File at commit</th><th className="num">Bytes</th><th>sha256 on chain</th><th>sha256 of file</th><th>Result</th></tr></thead>
        <tbody>{d.contracts.map((c) => (
          <tr key={c.name}><td>{c.name}</td><td className="mono small"><a href={studioAddr(c.address)}>{short(c.address)}</a></td>
            <td className="mono small"><a href={c.source_url}>{c.file}@{c.commit.slice(0, 7)}</a></td><td className="num mono">{c.bytes ?? "—"}</td>
            <td className="mono small">{c.chain_sha256?.slice(0, 16) ?? "—"}</td><td className="mono small">{c.file_sha256?.slice(0, 16) ?? "—"}</td>
            <td className={`mono small ${c.identical ? "ok" : "bad"}`}>{c.identical ? "identical" : c.error ?? "differs"}</td></tr>))}</tbody>
      </table></div>
      <p className="mono small muted" style={{ marginTop: 10 }}>checked {d.checked_at}</p>
    </div>
  );
}
