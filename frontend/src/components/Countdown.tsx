"use client";
import { useEffect, useState } from "react";
import { dur } from "@/lib/format";

/** Time until `at` (epoch seconds), ticking; "passed" once it is. */
export function Countdown({ at, passed = "due now" }: { at: number; passed?: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return <span className="mono">…</span>;
  return <span className="mono">{at > now ? dur(at - now) : passed}</span>;
}
