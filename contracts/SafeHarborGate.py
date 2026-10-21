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
# Anyone can open an offer under any incident name, so the gate never answers
# about an offer id alone: every question names the PROTOCOL address that must
# have created the offer and the INCIDENT it was opened under.
# check_for(protocol, incident) asks the registry for the latest offer that
# `protocol` itself created under `incident` (an offer copied by another
# address under the same name is never found), re-checks that the answer
# carries that creator and incident, and returns a structured state:
# NO_OFFER, OPEN, SETTLED_FULL, SETTLED_PARTIAL, SETTLED_NONE (or UNREADABLE),
# the returned fraction, and the bounty owed, paid and refunded.
# `favorable` is true only for SETTLED_FULL, or SETTLED_PARTIAL at or above
# the gate's threshold, read from a registry answer that is complete and
# self-consistent. A missing offer, a failed read, a malformed answer or an
# open offer is never favorable and never reported as settled or recovered.
#
# attest(protocol, incident) stores the state with the time it was read, so a
# consumer can point at one on-chain record. Anyone may attest; it only reads.

VERSION = "1.0.0"
STATES = ("NO_OFFER", "OPEN", "SETTLED_FULL", "SETTLED_PARTIAL", "SETTLED_NONE", "UNREADABLE")
PAGE_MAX = 50
MAX_NAME = 80

# INLINE:common


def _num(v: typing.Any) -> int:
    """A non-negative integer from a registry field (int or decimal string), or -1."""
    if isinstance(v, bool):
        return -1
    if isinstance(v, int):
        return v if v >= 0 else -1
    return _as_int(v, -1)


def gate_state(raw: typing.Any, protocol: str, incident: str, min_ppm: int) -> dict:
    """The registry's get_offer_by(protocol, incident) answer -> the gate's
    structured state. Pure: tests call it on every malformed shape. The answer
    must be an offer created by `protocol` under `incident`, or nothing is
    believed."""
    base = {"offer_id": 0, "state": "UNREADABLE", "favorable": False, "fraction_ppm": 0,
            "bounty": "0", "owed": "0", "paid": "0", "refunded": "0", "claim_deadline": 0, "protocol": protocol,
            "incident": incident, "why": ""}
    if protocol == "" or protocol == ZERO:
        base["why"] = "bad protocol address"
        return base
    if incident == "":
        base["why"] = "no incident"
        return base
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
    oid = _num(raw.get("offer_id"))
    if raw.get("found") is not True or oid <= 0:
        base["why"] = "registry answer is not an offer"
        return base
    if _addr(raw.get("protocol", "")) != protocol or not isinstance(raw.get("incident"), str) \
            or raw.get("incident") != incident:
        base["why"] = "registry answer is not an offer of this protocol and incident"
        return base
    base["offer_id"] = oid
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
    return {"offer_id": oid, "state": st, "favorable": fav, "fraction_ppm": ppm, "bounty": str(bounty),
            "owed": str(owed), "paid": str(claimed), "refunded": str(back1 + back2), "claim_deadline": cd,
            "protocol": protocol, "incident": incident,
            "why": "settled by the registry" + ("" if fav else "; below the gate's threshold" if st == "SETTLED_PARTIAL" else "")}


@gl.storage.allow
@dataclass
class Attestation:
    protocol: str
    incident: str
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
    latest: gl.storage.TreeMap[str, u64]

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

    def _read(self, protocol: typing.Any, incident: typing.Any) -> dict:
        want = _addr(protocol)
        inc = clean_text(incident, MAX_NAME)
        if want == "" or want == ZERO or inc == "":
            return gate_state(None, want, inc, int(self.min_fraction_ppm))
        try:
            raw = gl.contract.get_at(self.registry).view().get_offer_by(want, inc)
        except Exception:
            raw = None
        return gate_state(raw, want, inc, int(self.min_fraction_ppm))

    @gl.public.view
    def check_for(self, protocol: str, incident: str) -> typing.Any:
        """The state of the latest offer `protocol` itself opened under
        `incident`. Never favorable on missing data or for an offer anyone
        else opened."""
        return self._read(protocol, incident)

    @gl.public.view
    def is_favorable_for(self, protocol: str, incident: str) -> bool:
        return self._read(protocol, incident)["favorable"] is True

    @gl.public.write
    def attest(self, protocol: str, incident: str) -> typing.Any:
        now = _epoch_from_iso(gl.message.raw.get("datetime", ""))
        if now <= 0:
            raise gl.vm.UserError("REFUSED: NO_CLOCK")
        s = self._read(protocol, incident)
        # --- writes
        aid = int(self.n_attest) + 1
        self.attestations[u64(aid)] = Attestation(
            protocol=s["protocol"], incident=s["incident"], offer_id=u64(int(s["offer_id"])), state=s["state"],
            favorable=bool(s["favorable"]), fraction_ppm=u64(int(s["fraction_ppm"])), state_json=_canon(s),
            attested_at=u64(now), attested_by=gl.message.sender_address.as_hex.lower())
        self.n_attest = u64(aid)
        if s["protocol"] != "" and s["incident"] != "":
            self.latest[s["protocol"] + "|" + s["incident"]] = u64(aid)
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
    def get_latest(self, protocol: str, incident: str) -> typing.Any:
        """The latest attestation for (protocol, incident); NO attestation is not a state."""
        k = _addr(protocol) + "|" + clean_text(incident, MAX_NAME)
        aid = self.latest.get(k)
        if aid is None or int(aid) == 0:
            return {"found": False, "protocol": _addr(protocol), "incident": clean_text(incident, MAX_NAME)}
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
