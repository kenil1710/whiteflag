# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }
import genlayer as gl
from genlayer import *
from dataclasses import dataclass
import json
import typing

# SafeHarborGate - what a consumer contract asks before it treats an incident
# as resolved (re-enable a market, release an insurance payout, unpause).
#
# It reads one offer of its WhiteFlagRegistry and answers with a structured
# state: NO_OFFER, OPEN, SETTLED_FULL, SETTLED_PARTIAL, SETTLED_NONE (or
# UNREADABLE), the returned fraction, and the bounty owed, paid and refunded.
# `favorable` is true only for SETTLED_FULL, or SETTLED_PARTIAL at or above
# the gate's threshold, read from a registry answer that is complete and
# self-consistent. A missing offer, a failed read, a malformed answer or an
# open offer is never favorable and never reported as settled or recovered.
#
# attest(offer_id) stores the state with the time it was read, so a consumer
# can point at one on-chain record. Anyone may attest; it only reads.

VERSION = "1.0.0"
STATES = ("NO_OFFER", "OPEN", "SETTLED_FULL", "SETTLED_PARTIAL", "SETTLED_NONE", "UNREADABLE")
PAGE_MAX = 50

# ==== shared helpers: contracts/shared/common.py, inlined by tools/build.py; edit there ====
# The runner rejects the str replace method; slice around find() instead.

# chain -> (chain id, (RPC A, RPC B)). A proof is read from BOTH RPCs of its
# chain and refused unless they answer identically. The two are run by
# different operators and serve old transactions, receipts, JSON-RPC batches
# and the "finalized" tag (docs/FEASIBILITY.md). tools/lib/chains.mjs holds the
# same table.
CHAINS = {
    "ethereum": (1, ("https://eth-pokt.nodies.app", "https://rpc.mevblocker.io")),
    "arbitrum": (42161, ("https://arb-pokt.nodies.app", "https://arbitrum-one.public.blastapi.io")),
}
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
RPC_TRIES = 4
ZERO = "0x" + "0" * 40


def _as_int(v: typing.Any, default: int = -1) -> int:
    if isinstance(v, bool):
        return default
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        t = v.strip()
        if t != "" and t.isdigit() and len(t) <= 78:
            return int(t)
    return default


def _is_hex(s: typing.Any, n: int = -1) -> bool:
    if not isinstance(s, str) or (n >= 0 and len(s) != n):
        return False
    for ch in s:
        if ch not in "0123456789abcdef":
            return False
    return True


def _addr(v: typing.Any) -> str:
    """A lowercase 0x address, or "" if v is not one."""
    t = str(v).strip().lower()
    if len(t) != 42 or not t.startswith("0x"):
        return ""
    return t if _is_hex(t[2:], 40) else ""


def _hash32(v: typing.Any) -> str:
    t = str(v).strip().lower()
    if len(t) != 66 or not t.startswith("0x") or not _is_hex(t[2:], 64):
        return ""
    return t


def _hex_int(v: typing.Any) -> int:
    """0x-prefixed hex quantity -> int, or -1."""
    if not isinstance(v, str):
        return -1
    t = v.strip().lower()
    if not t.startswith("0x") or len(t) < 3 or len(t) > 66 or not _is_hex(t[2:]):
        return -1
    return int(t[2:], 16)


def _canon(obj: typing.Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _days_from_civil(y: int, m: int, d: int) -> int:
    y -= 1 if m <= 2 else 0
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def _civil_from_days(z: int) -> tuple:
    z += 719468
    era = (z if z >= 0 else z - 146096) // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + 3 if mp < 10 else mp - 9
    return (y + (1 if m <= 2 else 0), m, d)


def _epoch_from_iso(value: typing.Any) -> int:
    """Seconds since the epoch from gl.message.raw["datetime"]
    ("2026-10-07T12:00:00Z" or with fractional seconds), identical on every
    validator. 0 if unreadable."""
    if not isinstance(value, str) or len(value) < 19:
        return 0
    try:
        year = int(value[0:4])
        month = int(value[5:7])
        day = int(value[8:10])
        hour = int(value[11:13])
        minute = int(value[14:16])
        second = int(value[17:19])
    except Exception:
        return 0
    if month < 1 or month > 12 or day < 1 or day > 31 or hour > 23 or minute > 59 or second > 60:
        return 0
    return _days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second


def clean_text(text: typing.Any, n: int) -> str:
    """Printable ASCII only, no markup characters, whitespace collapsed, at most n chars."""
    out = ""
    for ch in str(text):
        if " " <= ch <= "~" and ch not in "<>\"'`\\":
            out += ch
    return " ".join(out.split())[:n]
# ==== end shared ====


def _num(v: typing.Any) -> int:
    """A non-negative integer from a registry field (int or decimal string), or -1."""
    if isinstance(v, bool):
        return -1
    if isinstance(v, int):
        return v if v >= 0 else -1
    return _as_int(v, -1)


def gate_state(raw: typing.Any, offer_id: int, min_ppm: int) -> dict:
    """The registry's get_offer answer -> the gate's structured state. Pure:
    tests call it on every malformed shape."""
    base = {"offer_id": offer_id, "state": "UNREADABLE", "favorable": False, "fraction_ppm": 0,
            "bounty": "0", "owed": "0", "paid": "0", "refunded": "0", "claim_deadline": 0, "why": ""}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            base["why"] = "registry answer is not JSON"
            return base
    if not isinstance(raw, dict):
        base["why"] = "registry answer is not an object"
        return base
    if raw.get("found") is False:
        base["state"] = "NO_OFFER"
        base["why"] = "the registry has no such offer"
        return base
    if raw.get("found") is not True or _num(raw.get("offer_id")) != offer_id:
        base["why"] = "registry answer is not this offer"
        return base
    st = raw.get("status")
    bounty = _num(raw.get("bounty"))
    owed = _num(raw.get("owed"))
    claimed = _num(raw.get("claimed"))
    back1 = _num(raw.get("refunded_at_settle"))
    back2 = _num(raw.get("unclaimed_refunded"))
    ppm = _num(raw.get("fraction_ppm"))
    cd = _num(raw.get("claim_deadline"))
    if st not in ("OPEN", "SETTLED_FULL", "SETTLED_PARTIAL", "SETTLED_NONE") or min(bounty, owed, claimed, back1, back2, ppm, cd) < 0 \
            or ppm > 1000000:
        base["why"] = "registry answer is incomplete"
        return base
    if st == "OPEN":
        base["state"] = "OPEN"
        base["bounty"] = str(bounty)
        base["fraction_ppm"] = ppm
        base["why"] = "the offer is open; nothing is settled"
        return base
    # settled: the numbers must add up, or nothing is believed
    if owed + back1 != bounty or claimed + back2 > owed:
        base["why"] = "registry numbers do not add up"
        return base
    if (st == "SETTLED_FULL" and (ppm != 1000000 or owed != bounty)) or (st == "SETTLED_NONE" and (ppm != 0 or owed != 0)) \
            or (st == "SETTLED_PARTIAL" and ppm >= 1000000):
        base["why"] = "registry status contradicts its fraction"
        return base
    fav = st == "SETTLED_FULL" or (st == "SETTLED_PARTIAL" and ppm >= min_ppm)
    return {"offer_id": offer_id, "state": st, "favorable": fav, "fraction_ppm": ppm, "bounty": str(bounty),
            "owed": str(owed), "paid": str(claimed), "refunded": str(back1 + back2), "claim_deadline": cd,
            "why": "settled by the registry" + ("" if fav else "; below the gate's threshold" if st == "SETTLED_PARTIAL" else "")}


@gl.storage.allow
@dataclass
class Attestation:
    offer_id: u64
    state: str
    favorable: bool
    fraction_ppm: u64
    state_json: str
    attested_at: u64
    attested_by: str


class SafeHarborGate(gl.contract.Contract):
    registry: Address
    min_fraction_ppm: u64
    n_attest: u64
    attestations: gl.storage.TreeMap[u64, Attestation]
    latest: gl.storage.TreeMap[u64, u64]

    def __init__(self, registry: str, min_fraction_ppm: int) -> None:
        r = _addr(registry)
        if r == "" or r == ZERO:
            raise gl.vm.UserError("registry must be a 0x address")
        m = _as_int(min_fraction_ppm, -1)
        if m < 1 or m > 1000000:
            raise gl.vm.UserError("min_fraction_ppm must be 1..1000000")
        self.registry = Address(r)
        self.min_fraction_ppm = u64(m)
        self.n_attest = u64(0)

    def _read(self, oid: int) -> dict:
        if oid <= 0:
            return gate_state({"found": False}, oid, int(self.min_fraction_ppm))
        try:
            raw = gl.contract.get_at(self.registry).view().get_offer(oid)
        except Exception:
            raw = None
        return gate_state(raw, oid, int(self.min_fraction_ppm))

    @gl.public.view
    def check(self, offer_id: int) -> typing.Any:
        """The offer's state as read now. Never favorable on missing data."""
        return self._read(_as_int(offer_id, 0))

    @gl.public.view
    def is_favorable(self, offer_id: int) -> bool:
        return self._read(_as_int(offer_id, 0))["favorable"] is True

    @gl.public.write
    def attest(self, offer_id: int) -> typing.Any:
        now = _epoch_from_iso(gl.message.raw.get("datetime", ""))
        if now <= 0:
            raise gl.vm.UserError("REFUSED: NO_CLOCK")
        oid = _as_int(offer_id, 0)
        s = self._read(oid)
        # --- writes
        aid = int(self.n_attest) + 1
        self.attestations[u64(aid)] = Attestation(
            offer_id=u64(max(oid, 0)), state=s["state"], favorable=bool(s["favorable"]),
            fraction_ppm=u64(int(s["fraction_ppm"])), state_json=_canon(s), attested_at=u64(now),
            attested_by=gl.message.sender_address.as_hex.lower())
        self.n_attest = u64(aid)
        if oid > 0:
            self.latest[u64(oid)] = u64(aid)
        out = dict(s)
        out["attestation_id"] = aid
        out["attested_at"] = now
        return out

    def _att_view(self, a: Attestation, aid: int) -> dict:
        out = json.loads(a.state_json)
        out["attestation_id"] = aid
        out["attested_at"] = int(a.attested_at)
        out["attested_by"] = a.attested_by
        return out

    @gl.public.view
    def get_attestation(self, attestation_id: int) -> typing.Any:
        aid = _as_int(attestation_id, 0)
        a = self.attestations.get(u64(max(aid, 0)))
        if a is None:
            return {"found": False}
        out = self._att_view(a, aid)
        out["found"] = True
        return out

    @gl.public.view
    def get_latest(self, offer_id: int) -> typing.Any:
        """The latest attestation of an offer; NO attestation is not a state."""
        oid = _as_int(offer_id, 0)
        aid = self.latest.get(u64(max(oid, 0)))
        if aid is None or int(aid) == 0:
            return {"found": False, "offer_id": oid}
        out = self._att_view(self.attestations[aid], int(aid))
        out["found"] = True
        return out

    @gl.public.view
    def get_attestations(self, offset: int, limit: int) -> typing.Any:
        off = max(_as_int(offset, 0), 0)
        lim = min(max(_as_int(limit, PAGE_MAX), 1), PAGE_MAX)
        n = int(self.n_attest)
        items = []
        i = off + 1
        while i <= n and len(items) < lim:
            a = self.attestations.get(u64(i))
            if a is not None:
                items.append(self._att_view(a, i))
            i += 1
        return {"total": n, "offset": off, "limit": lim, "items": items,
                "next_offset": off + len(items) if off + len(items) < n else -1}

    @gl.public.view
    def get_config(self) -> typing.Any:
        return {"version": VERSION, "contract": "SafeHarborGate", "registry": self.registry.as_hex.lower(),
                "min_fraction_ppm": int(self.min_fraction_ppm), "states": list(STATES),
                "attestations": int(self.n_attest)}
