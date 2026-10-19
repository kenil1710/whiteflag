"use client";
import { useSearchParams } from "next/navigation";
import { useWallet } from "./WalletProvider";
import { asReg, regAddr, gateAddr, type Reg } from "@/lib/deployments";
import { gen, short, studioTx } from "@/lib/format";
import type { TxProgress } from "@/lib/types";

export function useReg(): { r: Reg; reg: string; gate: string; q: string } {
  const sp = useSearchParams();
  const r = asReg(sp.get("r"));
  return { r, reg: regAddr(r), gate: gateAddr(r), q: r === "demo" ? "?r=demo" : "" };
}

export function WalletBar() {
  const w = useWallet();
  if (!w.hasWallet) return <p className="note">No browser wallet found. Install MetaMask (or any EIP-1193 wallet) to sign; reading needs nothing.</p>;
  if (!w.account) return <div className="row"><button className="btn btn-flag" onClick={() => void w.connect()} disabled={w.connecting}>{w.connecting ? "Connecting…" : "Connect wallet"}</button>{w.error && <span className="small bad">{w.error}</span>}</div>;
  return (
    <div className="row mono small">
      <span>Signed in as <strong>{short(w.account)}</strong></span>
      <span className="muted">{w.balance !== null ? `${gen(w.balance, 3)} GEN` : ""}</span>
      {w.onWrongNetwork && <button className="btn" onClick={() => void w.switchNetwork()}>Switch to Studio Dev</button>}
      <button className="btn" onClick={w.disconnect}>Disconnect</button>
    </div>
  );
}

export function Progress({ p }: { p: TxProgress | null }) {
  if (!p) return null;
  const cls = p.phase === "failed" || p.phase === "rejected" ? "bad" : p.phase === "finalized" || p.phase === "accepted" ? "ok" : "";
  return (
    <div className="progress" role="status" aria-live="polite">
      <span className={cls}>{p.phase.toUpperCase()}</span> · {p.message}
      {p.hash && <> · <a href={studioTx(p.hash)} target="_blank" rel="noreferrer">{short(p.hash, 8)}</a></>}
    </div>
  );
}
