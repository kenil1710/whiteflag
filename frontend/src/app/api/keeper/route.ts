/** GET /api/keeper: the keeper's latest checkpoint, from the keeper-state branch. */
export const dynamic = "force-dynamic";
export const STATE_URL = "https://raw.githubusercontent.com/kenil1710/whiteflag/keeper-state/keeper-state.json";
export async function GET() {
  const r = await fetch(STATE_URL, { cache: "no-store" });
  if (!r.ok) return Response.json({ error: "keeper state unreadable: GitHub " + r.status }, { status: 502 });
  return new Response(await r.text(), { headers: { "content-type": "application/json", "cache-control": "public, s-maxage=60" } });
}
