"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Mark } from "./Mark";

const NAV = [
  ["/", "Board"], ["/create", "Open an offer"], ["/prove", "Prove a return"], ["/claim", "Claim"],
  ["/gate", "Gate"], ["/keeper", "Keeper"], ["/verify", "Verify"], ["/docs", "Rules"],
] as const;

function Inner() {
  const path = usePathname();
  const sp = useSearchParams();
  const demo = sp.get("r") === "demo";
  const q = demo ? "?r=demo" : "";
  return (
    <header className="masthead">
      <div className="wrap">
        <div className="masthead-top">
          <Link href={"/" + q} className="brand" aria-label="WhiteFlag, the board">
            <Mark />
            <span>
              <span className="brand-name">WhiteFlag</span>
              <br />
              <span className="brand-sub">Whitehat bounties, paid for what came back</span>
            </span>
          </Link>
          <nav className="reg-toggle" aria-label="Registry">
            <Link href={path} aria-current={!demo ? "true" : undefined}>Canonical</Link>
            <Link href={path + "?r=demo"} aria-current={demo ? "true" : undefined}>Demo</Link>
          </nav>
        </div>
        <nav className="nav" aria-label="Sections">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href + q} aria-current={(href === "/" ? path === "/" || path.startsWith("/incident") : path.startsWith(href)) ? "page" : undefined}>{label}</Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

export function Masthead() {
  return <Suspense fallback={<header className="masthead"><div className="wrap" style={{ height: 120 }} /></header>}><Inner /></Suspense>;
}
