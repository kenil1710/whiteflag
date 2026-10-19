"use client";
import { useState } from "react";
import Link from "next/link";
import { useWallet } from "@/components/WalletProvider";
import { Progress, WalletBar, useReg } from "@/components/client";
import { send, viewOf } from "@/lib/contract";
import type { TxProgress } from "@/lib/types";

const EX = `[{"chain": "ethereum", "address": "0x..."}]`;
const TOK = `[{"chain": "ethereum", "token": "native", "symbol": "ETH", "decimals": 18, "stolen": "1000000000000000000000", "weight": "300000"}]`;

function parse(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }

export function CreateForm() {
  const { reg, q } = useReg();
  const w = useWallet();
  const [f, setF] = useState({ incident: "", name: "", chains: "ethereum", exploiters: EX, recoveries: EX, tokens: TOK, share: "10", start: "", deadline: "", rule: "EXPLOITER_OR_NAMED", bounty: "1", source: "" });
  const [p, setP] = useState<TxProgress | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const epoch = (s: string) => Math.floor(Date.parse(s.endsWith("Z") ? s : s + "Z") / 1000);
  const problems: string[] = [];
  for (const k of ["exploiters", "recoveries", "tokens"] as const) if (!Array.isArray(parse(f[k]))) problems.push(`${k} is not a JSON list`);
  if (!f.incident || !f.name) problems.push("incident id and name are required");
  if (!(epoch(f.start) > 0) || !(epoch(f.deadline) > epoch(f.start))) problems.push("start and a later deadline are required (UTC)");
  if (!(Number(f.bounty) >= 0.001)) problems.push("the bounty is at least 0.001 GEN");

  async function submit() {
    if (!w.account) return;
    const before = await viewOf<{ offers: number }>(reg, "get_stats");
    const bounty = BigInt(Math.round(Number(f.bounty) * 1e6)) * 10n ** 12n;
    const r = await send(w.account, reg, "create_offer", [f.incident, f.name, JSON.stringify(f.chains.split(",").map((s) => s.trim()).filter(Boolean)), f.exploiters, f.recoveries, f.tokens,
      Math.round(Number(f.share) * 100), epoch(f.start), epoch(f.deadline), f.rule, JSON.stringify(f.source ? { source: f.source } : {})], bounty,
      { onProgress: setP, confirm: async () => (await viewOf<{ offers: number }>(reg, "get_stats")).offers > before.offers });
    if (r.kind === "ok") setDone((await viewOf<{ offers: number }>(reg, "get_stats")).offers);
  }

  return (
    <div className="form">
      <div className="field"><label htmlFor="incident">Incident id</label><input id="incident" value={f.incident} onChange={set("incident")} placeholder="protocol-name-2026" /></div>
      <div className="field"><label htmlFor="name">Name</label><input id="name" value={f.name} onChange={set("name")} placeholder="Protocol V2 pools" /></div>
      <div className="field"><label htmlFor="chains">Chains (comma separated: ethereum, arbitrum)</label><input id="chains" value={f.chains} onChange={set("chains")} /></div>
      <div className="field"><label htmlFor="ex">Exploiter addresses (JSON)</label><textarea id="ex" value={f.exploiters} onChange={set("exploiters")} /><div className="hint">A return counts only if a listed exploiter address sends it.</div></div>
      <div className="field"><label htmlFor="rec">Recovery addresses (JSON)</label><textarea id="rec" value={f.recoveries} onChange={set("recoveries")} /></div>
      <div className="field"><label htmlFor="tok">Stolen tokens (JSON)</label><textarea id="tok" value={f.tokens} onChange={set("tokens")} /><div className="hint">token: &quot;native&quot; or the ERC-20 address that emits Transfer events (the proxy). stolen: base units. weight: your value per whole token, frozen.</div></div>
      <div className="grid-2" style={{ gap: 18 }}>
        <div className="field"><label htmlFor="start">Return window start (UTC)</label><input id="start" type="datetime-local" value={f.start} onChange={set("start")} /></div>
        <div className="field"><label htmlFor="deadline">Deadline (UTC)</label><input id="deadline" type="datetime-local" value={f.deadline} onChange={set("deadline")} /></div>
        <div className="field"><label htmlFor="share">Public bounty share (%)</label><input id="share" value={f.share} onChange={set("share")} /></div>
        <div className="field"><label htmlFor="bounty">Bounty locked (GEN)</label><input id="bounty" value={f.bounty} onChange={set("bounty")} /></div>
        <div className="field"><label htmlFor="rule">Payout rule</label><select id="rule" value={f.rule} onChange={set("rule")}><option>EXPLOITER_OR_NAMED</option><option>EXPLOITER_ONLY</option></select></div>
        <div className="field"><label htmlFor="src">Source link (post-mortem, optional)</label><input id="src" value={f.source} onChange={set("source")} /></div>
      </div>
      {problems.length > 0 && <ul className="small bad">{problems.map((x) => <li key={x}>{x}</li>)}</ul>}
      <WalletBar />
      <div className="row"><button className="btn btn-flag" disabled={!w.account || problems.length > 0 || (p !== null && !["failed", "rejected", "accepted", "finalized"].includes(p.phase))} onClick={() => void submit()}>Lock the bounty and open the offer</button></div>
      <Progress p={p} />
      {done && <p className="note note-flag">Offer opened. <Link href={`/incident/${done}${q}`}>Open its case file</Link>.</p>}
    </div>
  );
}
