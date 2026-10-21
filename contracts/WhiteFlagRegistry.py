# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }
import genlayer as gl
from genlayer import *
from dataclasses import dataclass
import json
import typing

# WhiteFlagRegistry - a whitehat bounty that pays only for funds that came back.
#
# A protocol that was hacked opens an OFFER and locks a bounty in GEN. The
# offer freezes: the incident, its chains, the exploiter addresses, the
# recovery addresses, the stolen tokens (chain, token, amount, value weight),
# the public bounty share, the return window [start, deadline], the claim
# window and the payout rule. There is no cancel: the protocol may only extend
# the deadline (in total at most MAX_EXTEND_S past the original) or add
# recovery addresses, and only before the deadline minus the amendment lock
# (24 h canonical) - never in the final day, never after. Every amendment is
# kept in the offer's amendment history with its time and sequence number.
#
# Anyone may submit RETURN PROOFS (transaction hashes on any listed chain).
# Validators read each transaction, its receipt, its block header and the
# finalized head from TWO RPCs per chain; the projected answers must be
# identical. A proof counts only if: the transaction succeeded, its block is
# finalized on both RPCs, the block time is within [start, deadline], the
# sender is a listed exploiter address, and it moved a listed token from an
# exploiter address to a recovery address (the native value of the
# transaction, or an ERC-20 Transfer log emitted by the listed token
# contract). Each (chain, tx, log index) counts once per offer.
#
# Every proof ends COUNTED, REJECTED or PENDING. REJECTED is permanent: the
# facts are wrong (failed transaction, wrong sender, recipient, token or
# window, unknown hash). PENDING is transient: an RPC error, the two RPCs
# disagreeing, or a block not final yet. Submissions close at the offer's
# settle time; a RECOVERY WINDOW (24 h canonical) follows, in which anyone may
# retry PENDING proofs. Settlement waits for the recovery window only while
# PENDING proofs remain; after it, settle always succeeds and leftover
# PENDING proofs are EXPIRED. Nothing extends the window.
#
#   fraction = sum(min(returned, stolen) * weight) / sum(stolen * weight)
#   owed     = bounty * fraction            (integer math, rounded down)
#
# SETTLE (anyone): once the offer's settle time has passed - the later of
# deadline + finality grace and created + minimum open time - or at once when
# the fraction reaches 100%. OPEN -> SETTLED_FULL / SETTLED_PARTIAL /
# SETTLED_NONE. The remainder (bounty - owed) goes back to the protocol in the
# same transaction. Every counted transfer is attributed to the exploiter
# address that sent it, and the owed bounty is split by each address's own
# weighted returns. CLAIM: each listed exploiter address claims only its own
# share, paid to itself or (if the payout rule allows) to a beneficiary it
# committed on chain from that address beforehand - nobody else can set or
# change it. After the claim window anyone may refund the unclaimed shares to
# the protocol. No model is asked anything; no owner can intervene.
#
# RULES
#   1. create_offer is the only payable method and never raises: a refusal
#      credits the value back to the sender (withdraw_refund) and returns
#      {"ok": false, "reason": ...}. Studio keeps the value of a call that
#      fails, so raising there would strand it.
#   2. Every check runs before the first write; counters move only after.
#   3. GEN leaves only through _send: one external value message per call,
#      posted in the call that marks the payout done. The caller funds it.
#   4. Ledger: received = held + paid + refunded + credits_paid, where held =
#      open bounties + owed unclaimed + credits owed. Anything above held in
#      the balance arrived outside create_offer and can only be swept to the
#      deployer (sweep_stray).

VERSION = "1.0.0"

ST_OPEN = "OPEN"
ST_FULL = "SETTLED_FULL"
ST_PARTIAL = "SETTLED_PARTIAL"
ST_NONE = "SETTLED_NONE"

P_COUNTED = "COUNTED"
P_REJECTED = "REJECTED"
P_PENDING = "PENDING"
P_EXPIRED = "EXPIRED"     # shown for a proof still PENDING when its offer settled

RULE_OR_NAMED = "EXPLOITER_OR_NAMED"
RULE_ONLY = "EXPLOITER_ONLY"
PAYOUT_RULES = (RULE_OR_NAMED, RULE_ONLY)

REASONS = ("UNSUPPORTED_CHAIN", "RPC_UNREADABLE", "RPC_DISAGREE", "WRONG_CHAIN_ID", "TX_NOT_FOUND", "TX_PENDING",
           "TX_FAILED", "NOT_FINALIZED", "BEFORE_OFFER_START", "AFTER_DEADLINE", "SENDER_NOT_EXPLOITER",
           "NO_RETURN_TO_RECOVERY", "ALREADY_COUNTED")
# transient: the facts could not be read yet, a retry may count them
TRANSIENT = ("RPC_UNREADABLE", "RPC_DISAGREE", "WRONG_CHAIN_ID", "TX_PENDING", "NOT_FINALIZED")
COUNT_KEYS = ("offers", "create_refused", "extensions", "recoveries_added", "proofs_counted", "proofs_rejected",
              "settled", "settled:" + ST_FULL, "settled:" + ST_PARTIAL, "settled:" + ST_NONE, "claims", "beneficiaries",
              "unclaimed_refunds", "credit_withdrawals", "sweeps", "proofs_pending", "retries", "proofs_expired") \
    + tuple("reject:" + r for r in REASONS)

# mode -> (claim_window_s, min_open_s, rate_n, rate_window_s, sweep_delay_s, finality_grace_s, recovery_s,
#          amend_lock_s, max_extend_s)
#   claim_window_s  how long the owed bounty stays claimable after settlement
#   min_open_s      an offer can be settled no earlier than created + this
#                   (unless 100% returned), so an offer opened after its
#                   deadline - a historic incident - still takes proofs
#   rate_n/window   proof submissions per (offer, sender) per window
#   sweep_delay_s   sweep_stray waits this long after the registry's last
#                   send, so a send posted but not yet finalized (the balance
#                   still holds it) is never mistaken for stray value
#   finality_grace_s settle waits this long after the deadline, so a return
#                   made just before it can finalize (Arbitrum's finalized
#                   head trails by up to about an hour) and be proved
#   recovery_s      after submissions close, PENDING proofs may be retried
#                   this long; settle waits for it only while any remain
#   amend_lock_s    amendments (deadline extension, new recovery address)
#                   close this long before the current deadline
#   max_extend_s    the deadline may move at most this far past the original
MODES = {
    "CANONICAL": (3600, 10800, 20, 3600, 172800, 7200, 86400, 86400, 180 * 86400),
    "DEMO": (180, 60, 20, 600, 3600, 60, 300, 120, 3600),
}

MAX_ITEMS = 5               # proofs per submission
MAX_EXPLOITERS = 24
MAX_RECOVERIES = 24
MAX_TOKENS = 12
MAX_SPAN_S = 3653 * 86400   # deadline - start (ten years: historic incidents open late)
MAX_EXTEND_S = MODES["CANONICAL"][8]   # canonical cap on deadline extensions, in total
MAX_NAME = 80
MAX_META = 800
MIN_BOUNTY = 10 ** 15       # 0.001 GEN
MAX_AMOUNT = 10 ** 30
MAX_WEIGHT = 10 ** 18
MAX_STOLEN = 10 ** 40
PAGE_MAX = 50

# INLINE:common
# INLINE:rpc


def _parse_pairs(raw: typing.Any, chains: list, cap: int) -> typing.Any:
    """[{chain, address}] -> sorted unique list, or a reason string."""
    try:
        v = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return "BAD_JSON"
    if not isinstance(v, list) or len(v) == 0:
        return "EMPTY"
    if len(v) > cap:
        return "TOO_MANY"
    seen = {}
    for it in v:
        if not isinstance(it, dict):
            return "BAD_ENTRY"
        ch = str(it.get("chain", "")).strip().lower()
        a = _addr(it.get("address", ""))
        if ch not in chains:
            return "CHAIN_NOT_IN_OFFER"
        if a == "" or a == ZERO:
            return "BAD_ADDRESS"
        seen[ch + "|" + a] = {"chain": ch, "address": a}
    return [seen[k] for k in sorted(seen.keys())]


def _parse_tokens(raw: typing.Any, chains: list) -> typing.Any:
    try:
        v = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return "BAD_JSON"
    if not isinstance(v, list) or len(v) == 0:
        return "EMPTY"
    if len(v) > MAX_TOKENS:
        return "TOO_MANY"
    out = {}
    for it in v:
        if not isinstance(it, dict):
            return "BAD_ENTRY"
        ch = str(it.get("chain", "")).strip().lower()
        if ch not in chains:
            return "CHAIN_NOT_IN_OFFER"
        tk = str(it.get("token", "")).strip().lower()
        if tk != "native":
            tk = _addr(tk)
            if tk == "" or tk == ZERO:
                return "BAD_TOKEN"
        dec = _as_int(it.get("decimals"), -1)
        stolen = _as_int(it.get("stolen"), -1)
        weight = _as_int(it.get("weight"), -1)
        if dec < 0 or dec > 18:
            return "BAD_DECIMALS"
        if stolen <= 0 or stolen > MAX_STOLEN:
            return "BAD_STOLEN"
        if weight <= 0 or weight > MAX_WEIGHT:
            return "BAD_WEIGHT"
        key = ch + ":" + tk
        if key in out:
            return "DUPLICATE_TOKEN"
        out[key] = {"chain": ch, "token": tk, "symbol": clean_text(it.get("symbol", ""), 12),
                    "decimals": dec, "stolen": str(stolen), "weight": str(weight)}
    return [out[k] for k in sorted(out.keys())]


def fraction_parts(tokens: list, returned: dict) -> list:
    """[num, den] of the returned fraction: sum(min(returned, stolen) * weight)
    over sum(stolen * weight), every amount scaled to 18 decimals first."""
    num = 0
    den = 0
    for t in tokens:
        scale = 10 ** (18 - int(t["decimals"]))
        stolen = int(t["stolen"]) * scale
        got = int(returned.get(t["chain"] + ":" + t["token"], "0")) * scale
        w = int(t["weight"])
        num += (got if got < stolen else stolen) * w
        den += stolen * w
    return [num, den]


def shares_of(tokens: list, returned: dict, returned_by: dict, bounty: int) -> dict:
    """{exploiter address: owed} for a settlement. Each token's counted value,
    min(returned, stolen) * weight, is split between the addresses that sent
    it in proportion to what each sent; an address's share is bounty times its
    part of the fraction. The rounding remainder (bounty * num // den minus the
    floored shares) goes to the largest contributor (lowest address on a tie),
    so the shares add up to exactly the owed amount. An address that returned
    nothing gets no entry."""
    parts = fraction_parts(tokens, returned)
    num = parts[0]
    den = parts[1]
    if den <= 0 or num <= 0:
        return {}
    owed = (bounty * num) // den
    if owed > bounty:
        owed = bounty
    nums = {}
    for t in tokens:
        k = t["chain"] + ":" + t["token"]
        scale = 10 ** (18 - int(t["decimals"]))
        stolen = int(t["stolen"]) * scale
        total = int(returned.get(k, "0")) * scale
        if total <= 0:
            continue
        counted = (total if total < stolen else stolen) * int(t["weight"])
        for a in sorted(returned_by.keys()):
            mine = int(returned_by[a].get(k, "0")) * scale
            if mine > 0:
                nums[a] = nums.get(a, 0) + (counted * mine) // total
    out = {}
    given = 0
    top = ""
    for a in sorted(nums.keys()):
        out[a] = (bounty * nums[a]) // den
        given += out[a]
        if top == "" or nums[a] > nums[top]:
            top = a
    if top != "" and owed > given:
        out[top] = out[top] + (owed - given)
    return {a: out[a] for a in out if out[a] > 0}


def judge(offer: dict, chain: str, h: str, r: dict, used: dict) -> dict:
    """The rule, on one consensus-agreed read. used: keys already counted
    (this offer, plus earlier items of the same submission). ->
    {"reason": ...} or {"credits": [...]} (only credits not yet used)."""
    if "reason" in r:
        return {"reason": str(r["reason"])}
    p = r["read"]
    if int(p["status"]) != 1:
        return {"reason": "TX_FAILED"}
    if not r["final"]:
        return {"reason": "NOT_FINALIZED"}
    if int(p["time"]) < int(offer["start"]):
        return {"reason": "BEFORE_OFFER_START"}
    if int(p["time"]) > int(offer["deadline"]):
        return {"reason": "AFTER_DEADLINE"}
    ex = {}
    for e in offer["exploiters"]:
        if e["chain"] == chain:
            ex[e["address"]] = True
    rec = {}
    for e in offer["recoveries"]:
        if e["chain"] == chain:
            rec[e["address"]] = True
    toks = {}
    for t in offer["tokens"]:
        if t["chain"] == chain:
            toks[t["token"]] = True
    if not ex.get(p["from"], False):
        return {"reason": "SENDER_NOT_EXPLOITER"}
    credits = []
    if toks.get("native", False) and int(p["value"]) > 0 and rec.get(p["to"], False):
        credits.append({"key": chain + ":" + h + ":native", "token": "native", "amount": str(p["value"]),
                        "from": p["from"], "to": p["to"], "log": -1})
    for lg in p["logs"]:
        if toks.get(lg["address"], False) and ex.get(lg["from"], False) and rec.get(lg["to"], False) \
                and int(lg["amount"]) > 0:
            credits.append({"key": chain + ":" + h + ":" + str(lg["i"]), "token": lg["address"],
                            "amount": str(lg["amount"]), "from": lg["from"], "to": lg["to"], "log": int(lg["i"])})
    if len(credits) == 0:
        return {"reason": "NO_RETURN_TO_RECOVERY"}
    fresh = []
    for c in credits:
        if not used.get(c["key"], False):
            fresh.append(c)
    if len(fresh) == 0:
        return {"reason": "ALREADY_COUNTED"}
    return {"credits": fresh}


# =============================================================================
# storage
# =============================================================================

@gl.storage.allow
@dataclass
class Offer:
    offer_id: u64
    incident: str
    name: str
    meta_json: str
    protocol: str
    created_at: u64
    start: u64
    deadline: u64
    original_deadline: u64
    bounty: u256
    bounty_share_bps: u64
    payout_rule: str
    claim_window_s: u64
    chains_json: str
    exploiters_json: str
    recoveries_json: str
    tokens_json: str
    returned_json: str
    returned_by_json: str
    shares_json: str
    claims_json: str
    amendments_json: str
    n_proofs: u64
    n_counted: u64
    n_rejected: u64
    n_pending: u64
    n_expired: u64
    status: str
    num: str
    den: str
    owed: u256
    settled_at: u64
    settled_by: str
    refunded_at_settle: u256
    claim_deadline: u64
    claimed: u256
    unclaimed_refunded: u256
    refunded_at: u64


@gl.storage.allow
@dataclass
class Proof:
    proof_id: u64
    offer_id: u64
    chain: str
    tx_hash: str
    submitter: str
    submitted_at: u64
    status: str
    reason: str
    detail: str
    credits_json: str
    block: u64
    block_time: u64
    tx_from: str
    tx_to: str
    attempts: u64
    updated_at: u64


class WhiteFlagRegistry(gl.contract.Contract):
    mode: str
    deployer: str
    claim_window_s: u64
    min_open_s: u64
    rate_n: u64
    rate_window_s: u64
    sweep_delay_s: u64
    finality_grace_s: u64
    recovery_s: u64
    amend_lock_s: u64
    max_extend_s: u64
    n_amendments: u64
    last_send_at: u64
    n_offers: u64
    n_proofs: u64
    offers: gl.storage.TreeMap[u64, Offer]
    proofs: gl.storage.TreeMap[u64, Proof]
    offer_proofs: gl.storage.TreeMap[str, u64]
    used: gl.storage.TreeMap[str, u64]
    counted_tx: gl.storage.TreeMap[str, u64]
    pending_tx: gl.storage.TreeMap[str, u64]
    by_incident: gl.storage.TreeMap[str, u64]
    rate: gl.storage.TreeMap[str, str]
    credits: gl.storage.TreeMap[str, u256]
    beneficiaries: gl.storage.TreeMap[str, str]
    counts: gl.storage.TreeMap[str, u64]
    received_total: u256
    open_total: u256
    owed_total: u256
    paid_total: u256
    refunded_total: u256
    credit_owed_total: u256
    credit_paid_total: u256
    stray_swept_total: u256

    def __init__(self, mode: str) -> None:
        m = str(mode).strip().upper()
        if m not in MODES:
            raise gl.vm.UserError("mode must be CANONICAL or DEMO")
        p = MODES[m]
        self.mode = m
        self.deployer = gl.message.sender_address.as_hex.lower()
        self.claim_window_s = u64(p[0])
        self.min_open_s = u64(p[1])
        self.rate_n = u64(p[2])
        self.rate_window_s = u64(p[3])
        self.sweep_delay_s = u64(p[4])
        self.finality_grace_s = u64(p[5])
        self.recovery_s = u64(p[6])
        self.amend_lock_s = u64(p[7])
        self.max_extend_s = u64(p[8])
        self.n_offers = u64(0)
        self.n_proofs = u64(0)

    # --- helpers --------------------------------------------------------------

    def _now(self) -> int:
        return _epoch_from_iso(gl.message.raw.get("datetime", ""))

    def _sender(self) -> str:
        return gl.message.sender_address.as_hex.lower()

    def _bump(self, key: str, n: int = 1) -> None:
        self.counts[key] = u64(int(self.counts.get(key, u64(0))) + n)

    def _offer(self, offer_id: typing.Any) -> typing.Any:
        oid = _as_int(offer_id, 0)
        if oid <= 0:
            return None
        return self.offers.get(u64(oid))

    def _offer_dict(self, o: Offer) -> dict:
        return {"start": int(o.start), "deadline": int(o.deadline), "chains": json.loads(o.chains_json),
                "exploiters": json.loads(o.exploiters_json), "recoveries": json.loads(o.recoveries_json),
                "tokens": json.loads(o.tokens_json)}

    def _settle_at(self, o: Offer) -> int:
        """Submissions close here; settle may run from here if no proof is PENDING."""
        a = int(o.deadline) + int(self.finality_grace_s)
        b = int(o.created_at) + int(self.min_open_s)
        return a if a > b else b

    def _recover_until(self, o: Offer) -> int:
        """PENDING proofs may be retried until here; from here settle always succeeds."""
        return self._settle_at(o) + int(self.recovery_s)

    def _can_settle(self, o: Offer, now: int) -> bool:
        n = int(o.num)
        d = int(o.den)
        if d > 0 and n >= d:
            return True
        if now >= self._recover_until(o):
            return True
        return now >= self._settle_at(o) and int(o.n_pending) == 0

    def _is_exploiter(self, o: Offer, who: str) -> bool:
        for e in json.loads(o.exploiters_json):
            if e["address"] == who:
                return True
        return False

    def _refuse(self, value: int, reason: str) -> dict:
        """A payable refusal: the value is credited back to the sender, never kept, never raised on."""
        if value > 0:
            who = self._sender()
            self.credits[who] = u256(int(self.credits.get(who, u256(0))) + value)
            self.credit_owed_total = u256(int(self.credit_owed_total) + value)
            self.received_total = u256(int(self.received_total) + value)
        self._bump("create_refused")
        return {"ok": False, "reason": reason, "credited": str(value)}

    def _held(self) -> int:
        return int(self.open_total) + int(self.owed_total) + int(self.credit_owed_total)

    def _send(self, who: str, amount: int) -> None:
        """The only way GEN leaves: an external value message (EthSend) to
        `who`, applied when this transaction finalizes and paid for by the
        caller's message allocation. Studio Dev skips an internal
        emit_transfer (declared budget 0) and credits the value back, so it is
        never used. Posted in the same call that marks the payout done: if it
        cannot be posted, the call fails and nothing is marked."""
        self.last_send_at = u64(self._now())
        gl.evm.Account(Address(who)).emit_call(u256(amount), b"")

    # --- offers -----------------------------------------------------------------

    @gl.public.write.payable
    def create_offer(self, incident: str, name: str, chains_json: str, exploiters_json: str,
                     recoveries_json: str, tokens_json: str, bounty_share_bps: int, start: int,
                     deadline: int, payout_rule: str, meta_json: str) -> typing.Any:
        """Open an offer and lock msg.value as the bounty. Never raises."""
        value = int(gl.message.value)
        now = self._now()
        if now <= 0:
            return self._refuse(value, "NO_CLOCK")
        if value < MIN_BOUNTY:
            return self._refuse(value, "BOUNTY_BELOW_MINIMUM")
        if value > MAX_AMOUNT:
            return self._refuse(value, "BOUNTY_TOO_LARGE")
        inc = clean_text(incident, MAX_NAME)
        nm = clean_text(name, MAX_NAME)
        if inc == "" or nm == "":
            return self._refuse(value, "NAME_REQUIRED")
        try:
            ch = json.loads(chains_json) if isinstance(chains_json, str) else chains_json
        except Exception:
            return self._refuse(value, "CHAINS_BAD_JSON")
        if not isinstance(ch, list) or len(ch) == 0:
            return self._refuse(value, "CHAINS_EMPTY")
        chains = []
        for c in ch:
            cc = str(c).strip().lower()
            if cc not in CHAINS:
                return self._refuse(value, "UNSUPPORTED_CHAIN")
            if cc not in chains:
                chains.append(cc)
        chains = sorted(chains)
        ex = _parse_pairs(exploiters_json, chains, MAX_EXPLOITERS)
        if isinstance(ex, str):
            return self._refuse(value, "EXPLOITERS_" + ex)
        rec = _parse_pairs(recoveries_json, chains, MAX_RECOVERIES)
        if isinstance(rec, str):
            return self._refuse(value, "RECOVERIES_" + rec)
        exs = {}
        for e in ex:
            exs[e["address"]] = True
        for r in rec:
            if exs.get(r["address"], False):
                return self._refuse(value, "RECOVERY_IS_EXPLOITER")
        toks = _parse_tokens(tokens_json, chains)
        if isinstance(toks, str):
            return self._refuse(value, "TOKENS_" + toks)
        bps = _as_int(bounty_share_bps, -1)
        if bps < 1 or bps > 10000:
            return self._refuse(value, "BAD_BOUNTY_SHARE")
        s = _as_int(start, -1)
        d = _as_int(deadline, -1)
        if s <= 0 or d <= s:
            return self._refuse(value, "BAD_WINDOW")
        if d - s > MAX_SPAN_S:
            return self._refuse(value, "WINDOW_TOO_LONG")
        if s > now:
            return self._refuse(value, "START_IN_FUTURE")
        rule = str(payout_rule).strip().upper()
        if rule not in PAYOUT_RULES:
            return self._refuse(value, "BAD_PAYOUT_RULE")
        meta = "{}"
        if str(meta_json).strip() != "":
            try:
                mv = json.loads(meta_json)
            except Exception:
                return self._refuse(value, "META_BAD_JSON")
            if not isinstance(mv, dict):
                return self._refuse(value, "META_NOT_OBJECT")
            meta = _canon(mv)
            if len(meta) > MAX_META:
                return self._refuse(value, "META_TOO_LONG")
        # --- writes
        oid = int(self.n_offers) + 1
        self.offers[u64(oid)] = Offer(
            offer_id=u64(oid), incident=inc, name=nm, meta_json=meta, protocol=self._sender(),
            created_at=u64(now), start=u64(s), deadline=u64(d), original_deadline=u64(d), bounty=u256(value),
            bounty_share_bps=u64(bps), payout_rule=rule, claim_window_s=u64(int(self.claim_window_s)),
            chains_json=_canon(chains), exploiters_json=_canon(ex), recoveries_json=_canon(rec),
            tokens_json=_canon(toks), returned_json="{}", returned_by_json="{}", shares_json="{}", claims_json="{}",
            amendments_json="[]", n_proofs=u64(0),
            n_counted=u64(0), n_rejected=u64(0), n_pending=u64(0), n_expired=u64(0), status=ST_OPEN, num="0", den="0", owed=u256(0),
            settled_at=u64(0), settled_by="", refunded_at_settle=u256(0), claim_deadline=u64(0),
            claimed=u256(0), unclaimed_refunded=u256(0),
            refunded_at=u64(0))
        self.n_offers = u64(oid)
        self.by_incident[self._sender() + "|" + inc] = u64(oid)
        self.received_total = u256(int(self.received_total) + value)
        self.open_total = u256(int(self.open_total) + value)
        self._bump("offers")
        return {"ok": True, "offer_id": oid, "bounty": str(value), "settle_at": self._settle_at(self.offers[u64(oid)])}

    def _amendable(self, o: Offer, now: int) -> None:
        """The protocol may amend its open offer only before deadline - amend_lock_s."""
        if o.protocol != self._sender():
            raise gl.vm.UserError("REFUSED: ONLY_THE_PROTOCOL")
        if o.status != ST_OPEN:
            raise gl.vm.UserError("REFUSED: OFFER_IS_" + o.status)
        closes = int(o.deadline) - int(self.amend_lock_s)
        if now >= closes:
            raise gl.vm.UserError("REFUSED: AMENDMENTS_CLOSED_AT_" + str(closes))

    def _amend(self, o: Offer, now: int, entry: dict) -> dict:
        seq = int(self.n_amendments) + 1
        self.n_amendments = u64(seq)
        entry["seq"] = seq
        entry["at"] = now
        h = json.loads(o.amendments_json)
        h.append(entry)
        o.amendments_json = _canon(h)
        return entry

    @gl.public.write
    def extend_deadline(self, offer_id: int, new_deadline: int) -> typing.Any:
        """The protocol may push its deadline later, before the amendment lock;
        in total at most max_extend_s past the original deadline."""
        now = self._now()
        if now <= 0:
            raise gl.vm.UserError("REFUSED: NO_CLOCK")
        o = self._offer(offer_id)
        if o is None:
            raise gl.vm.UserError("REFUSED: NO_SUCH_OFFER")
        self._amendable(o, now)
        nd = _as_int(new_deadline, -1)
        if nd <= int(o.deadline):
            raise gl.vm.UserError("REFUSED: DEADLINE_CAN_ONLY_MOVE_LATER")
        if nd - int(o.start) > MAX_SPAN_S or nd - int(o.original_deadline) > int(self.max_extend_s):
            raise gl.vm.UserError("REFUSED: EXTENSION_CAP_" + str(int(o.original_deadline) + int(self.max_extend_s)))
        # --- writes
        e = self._amend(o, now, {"what": "deadline", "from": int(o.deadline), "to": nd})
        o.deadline = u64(nd)
        self._bump("extensions")
        return {"ok": True, "offer_id": int(o.offer_id), "deadline": nd, "settle_at": self._settle_at(o),
                "amendment": e}

    @gl.public.write
    def add_recovery(self, offer_id: int, chain: str, address: str) -> typing.Any:
        """The protocol may add a recovery address, before the amendment lock."""
        now = self._now()
        if now <= 0:
            raise gl.vm.UserError("REFUSED: NO_CLOCK")
        o = self._offer(offer_id)
        if o is None:
            raise gl.vm.UserError("REFUSED: NO_SUCH_OFFER")
        self._amendable(o, now)
        ch = str(chain).strip().lower()
        if ch not in json.loads(o.chains_json):
            raise gl.vm.UserError("REFUSED: CHAIN_NOT_IN_OFFER")
        a = _addr(address)
        if a == "" or a == ZERO:
            raise gl.vm.UserError("REFUSED: BAD_ADDRESS")
        if self._is_exploiter(o, a):
            raise gl.vm.UserError("REFUSED: RECOVERY_IS_EXPLOITER")
        rec = json.loads(o.recoveries_json)
        for r in rec:
            if r["chain"] == ch and r["address"] == a:
                raise gl.vm.UserError("REFUSED: ALREADY_A_RECOVERY_ADDRESS")
        if len(rec) >= MAX_RECOVERIES:
            raise gl.vm.UserError("REFUSED: TOO_MANY")
        # --- writes
        rec.append({"chain": ch, "address": a})
        rec = sorted(rec, key=lambda x: x["chain"] + "|" + x["address"])
        o.recoveries_json = _canon(rec)
        e = self._amend(o, now, {"what": "recovery", "chain": ch, "address": a})
        self._bump("recoveries_added")
        return {"ok": True, "offer_id": int(o.offer_id), "recoveries": len(rec), "amendment": e}

    # --- proofs -----------------------------------------------------------------

    def _read_and_judge(self, o: Offer, frozen: list) -> list:
        """Every validator reads `frozen` ([chain, hash] pairs) from both RPCs
        of each chain; the agreed reads are judged. -> [[chain, hash, read, judgement]]."""

        def leader() -> list:
            return read_proofs(frozen)

        def validator(res: gl.vm.Result) -> bool:
            if not isinstance(res, gl.vm.Return):
                return False
            got = res.calldata
            if not isinstance(got, list) or len(got) != len(frozen):
                return False
            mine = read_proofs(frozen)
            for i in range(len(frozen)):
                a = got[i]
                b = mine[i]
                if not isinstance(a, dict):
                    return False
                if "reason" in a and "reason" in b:
                    # the same failure, or both transient (a PENDING proof, retried later)
                    if a["reason"] == b["reason"] or (a["reason"] in TRANSIENT and b["reason"] in TRANSIENT):
                        continue
                    return False
                if _canon(a) != _canon(b):
                    return False
            return True

        reads = gl.vm.run_nondet(leader, validator)
        if not isinstance(reads, list) or len(reads) != len(frozen):
            raise gl.vm.UserError("REFUSED: UNREADABLE")
        offer = self._offer_dict(o)
        used = {}
        results = []
        for i in range(len(frozen)):
            r = reads[i]
            if not isinstance(r, dict):
                r = {"reason": "RPC_UNREADABLE"}
            ch = frozen[i][0]
            h = frozen[i][1]
            # keys this registry already counted, plus those earlier in this submission
            pre = {}
            if "read" in r:
                pre_keys = [ch + ":" + h + ":native"]
                for lg in r["read"]["logs"]:
                    pre_keys.append(ch + ":" + h + ":" + str(lg["i"]))
                for k in pre_keys:
                    if used.get(k, False) or int(self.used.get(str(int(o.offer_id)) + "|" + k, u64(0))) > 0:
                        pre[k] = True
            j = judge(offer, ch, h, r, pre)
            if "credits" in j:
                for c in j["credits"]:
                    used[c["key"]] = True
            results.append([ch, h, r, j])
        return results

    def _record(self, o: Offer, row: list, pid: int, who: str, now: int, returned: dict, returned_by: dict) -> dict:
        """Writes one judged proof as proof `pid` (a new record, or the PENDING
        record being retried) and returns its result row."""
        ch = row[0]
        h = row[1]
        r = row[2]
        j = row[3]
        oid = str(int(o.offer_id))
        p = r.get("read", None)
        if "credits" in j:
            st = P_COUNTED
        elif str(j["reason"]) in TRANSIENT:
            st = P_PENDING
        else:
            st = P_REJECTED
        old = self.proofs.get(u64(pid))
        reason = "" if st == P_COUNTED else str(j["reason"])
        detail = "" if st == P_COUNTED else clean_text(r.get("detail", ""), 100)
        rec = Proof(
            proof_id=u64(pid), offer_id=o.offer_id, chain=ch, tx_hash=h,
            submitter=who if old is None else old.submitter, submitted_at=u64(now) if old is None else old.submitted_at,
            status=st, reason=reason, detail=detail, credits_json=_canon(j.get("credits", [])),
            block=u64(int(p["block"]) if p is not None else 0), block_time=u64(int(p["time"]) if p is not None else 0),
            tx_from=p["from"] if p is not None else "", tx_to=p["to"] if p is not None else "",
            attempts=u64(1 if old is None else int(old.attempts) + 1), updated_at=u64(now))
        self.proofs[u64(pid)] = rec
        pk = oid + "|" + ch + ":" + h
        if st == P_PENDING:
            self.pending_tx[pk] = u64(pid)
        elif old is not None:
            self.pending_tx[pk] = u64(0)
        if st == P_COUNTED:
            for c in j["credits"]:
                self.used[oid + "|" + c["key"]] = u64(pid)
                tk = ch + ":" + c["token"]
                returned[tk] = str(int(returned.get(tk, "0")) + int(c["amount"]))
                mine = returned_by.get(c["from"], {})
                mine[tk] = str(int(mine.get(tk, "0")) + int(c["amount"]))
                returned_by[c["from"]] = mine
            self.counted_tx[pk] = u64(pid)
            o.n_counted = u64(int(o.n_counted) + 1)
            self._bump("proofs_counted")
        elif st == P_REJECTED:
            o.n_rejected = u64(int(o.n_rejected) + 1)
            self._bump("proofs_rejected")
            self._bump("reject:" + str(j["reason"]))
        else:
            o.n_pending = u64(int(o.n_pending) + 1)
            self._bump("proofs_pending")
        return {"proof_id": pid, "chain": ch, "tx": h, "status": st, "reason": reason, "detail": detail,
                "credits": j.get("credits", []), "attempts": int(rec.attempts)}

    def _finish(self, o: Offer, returned: dict, returned_by: dict) -> list:
        o.returned_json = _canon(returned)
        o.returned_by_json = _canon(returned_by)
        parts = fraction_parts(json.loads(o.tokens_json), returned)
        o.num = str(parts[0])
        o.den = str(parts[1])
        return parts

    @gl.public.write
    def submit_proofs(self, offer_id: int, items_json: str) -> typing.Any:
        """Anyone: up to MAX_ITEMS [chain, tx_hash] pairs for one open offer,
        until its settle time. Each is read by every validator from both RPCs
        of its chain, then judged and recorded COUNTED, REJECTED or PENDING."""
        now = self._now()
        if now <= 0:
            raise gl.vm.UserError("REFUSED: NO_CLOCK")
        o = self._offer(offer_id)
        if o is None:
            raise gl.vm.UserError("REFUSED: NO_SUCH_OFFER")
        if o.status != ST_OPEN:
            raise gl.vm.UserError("REFUSED: OFFER_IS_" + o.status)
        if now > self._settle_at(o):
            raise gl.vm.UserError("REFUSED: SUBMISSIONS_CLOSED_AT_" + str(self._settle_at(o)))
        try:
            items = json.loads(items_json) if isinstance(items_json, str) else items_json
        except Exception:
            raise gl.vm.UserError("REFUSED: BAD_JSON")
        if not isinstance(items, list) or len(items) == 0:
            raise gl.vm.UserError("REFUSED: NO_ITEMS")
        if len(items) > MAX_ITEMS:
            raise gl.vm.UserError("REFUSED: TOO_MANY_ITEMS")
        chains = json.loads(o.chains_json)
        oid = str(int(o.offer_id))
        clean = []
        seen = {}
        for it in items:
            if not isinstance(it, list) or len(it) != 2:
                raise gl.vm.UserError("REFUSED: BAD_ITEM")
            ch = str(it[0]).strip().lower()
            h = _hash32(it[1])
            if ch not in chains:
                raise gl.vm.UserError("REFUSED: CHAIN_NOT_IN_OFFER")
            if h == "":
                raise gl.vm.UserError("REFUSED: BAD_HASH")
            k = ch + ":" + h
            if seen.get(k, False):
                raise gl.vm.UserError("REFUSED: DUPLICATE_ITEM")
            if int(self.counted_tx.get(oid + "|" + k, u64(0))) > 0:
                raise gl.vm.UserError("REFUSED: ALREADY_COUNTED")
            pend = int(self.pending_tx.get(oid + "|" + k, u64(0)))
            if pend > 0:
                raise gl.vm.UserError("REFUSED: PENDING_RETRY_PROOF_" + str(pend))
            seen[k] = True
            clean.append([ch, h])
        who = self._sender()
        rk = oid + "|" + who
        w = self.rate.get(rk)
        ws = 0
        wn = 0
        if w is not None and w != "":
            parts = w.split(",")
            ws = int(parts[0])
            wn = int(parts[1])
        if now - ws >= int(self.rate_window_s):
            ws = now
            wn = 0
        if wn + len(clean) > int(self.rate_n):
            raise gl.vm.UserError("REFUSED: RATE_LIMITED_UNTIL_" + str(ws + int(self.rate_window_s)))
        results = self._read_and_judge(o, json.loads(_canon(clean)))
        # --- writes
        returned = json.loads(o.returned_json)
        returned_by = json.loads(o.returned_by_json)
        out = []
        for row in results:
            pid = int(self.n_proofs) + 1
            self.n_proofs = u64(pid)
            self.offer_proofs[oid + ":" + str(int(o.n_proofs))] = u64(pid)
            o.n_proofs = u64(int(o.n_proofs) + 1)
            out.append(self._record(o, row, pid, who, now, returned, returned_by))
        parts = self._finish(o, returned, returned_by)
        self.rate[rk] = str(ws) + "," + str(wn + len(clean))
        return {"ok": True, "offer_id": int(o.offer_id), "results": out,
                "fraction_ppm": (parts[0] * 1000000) // parts[1] if parts[1] > 0 else 0}

    @gl.public.write
    def retry_proofs(self, offer_id: int, proof_ids_json: str) -> typing.Any:
        """Anyone: re-read up to MAX_ITEMS PENDING proofs of an open offer, until
        its recovery window ends. Each becomes COUNTED, REJECTED or stays PENDING."""
        now = self._now()
        if now <= 0:
            raise gl.vm.UserError("REFUSED: NO_CLOCK")
        o = self._offer(offer_id)
        if o is None:
            raise gl.vm.UserError("REFUSED: NO_SUCH_OFFER")
        if o.status != ST_OPEN:
            raise gl.vm.UserError("REFUSED: OFFER_IS_" + o.status)
        if now > self._recover_until(o):
            raise gl.vm.UserError("REFUSED: RECOVERY_CLOSED_AT_" + str(self._recover_until(o)))
        try:
            ids = json.loads(proof_ids_json) if isinstance(proof_ids_json, str) else proof_ids_json
        except Exception:
            raise gl.vm.UserError("REFUSED: BAD_JSON")
        if not isinstance(ids, list) or len(ids) == 0:
            raise gl.vm.UserError("REFUSED: NO_ITEMS")
        if len(ids) > MAX_ITEMS:
            raise gl.vm.UserError("REFUSED: TOO_MANY_ITEMS")
        pids = []
        frozen = []
        for x in ids:
            pid = _as_int(x, 0)
            p = self.proofs.get(u64(pid)) if pid > 0 else None
            if p is None or int(p.offer_id) != int(o.offer_id):
                raise gl.vm.UserError("REFUSED: NOT_A_PROOF_OF_THIS_OFFER")
            if p.status != P_PENDING:
                raise gl.vm.UserError("REFUSED: PROOF_" + str(pid) + "_IS_" + p.status)
            if pid in pids:
                raise gl.vm.UserError("REFUSED: DUPLICATE_ITEM")
            pids.append(pid)
            frozen.append([p.chain, p.tx_hash])
        results = self._read_and_judge(o, frozen)
        # --- writes
        returned = json.loads(o.returned_json)
        returned_by = json.loads(o.returned_by_json)
        out = []
        for i in range(len(results)):
            o.n_pending = u64(int(o.n_pending) - 1)
            out.append(self._record(o, results[i], pids[i], self._sender(), now, returned, returned_by))
        parts = self._finish(o, returned, returned_by)
        self._bump("retries", len(pids))
        return {"ok": True, "offer_id": int(o.offer_id), "results": out, "pending": int(o.n_pending),
                "fraction_ppm": (parts[0] * 1000000) // parts[1] if parts[1] > 0 else 0}

    # --- settlement, claim, refunds -------------------------------------------

    @gl.public.write
    def settle(self, offer_id: int) -> typing.Any:
        """Anyone, once the settle time has passed or at 100% returned. Sends
        the remainder (bounty - owed) back to the protocol."""
        now = self._now()
        if now <= 0:
            raise gl.vm.UserError("REFUSED: NO_CLOCK")
        o = self._offer(offer_id)
        if o is None:
            raise gl.vm.UserError("REFUSED: NO_SUCH_OFFER")
        if o.status != ST_OPEN:
            raise gl.vm.UserError("REFUSED: ALREADY_" + o.status)
        parts = fraction_parts(json.loads(o.tokens_json), json.loads(o.returned_json))
        full = parts[1] > 0 and parts[0] >= parts[1]
        if not full and now < self._settle_at(o):
            raise gl.vm.UserError("REFUSED: TOO_EARLY_UNTIL_" + str(self._settle_at(o)))
        if not self._can_settle(o, now):
            raise gl.vm.UserError("REFUSED: PENDING_PROOFS_UNTIL_" + str(self._recover_until(o)))
        bounty = int(o.bounty)
        shares = shares_of(json.loads(o.tokens_json), json.loads(o.returned_json), json.loads(o.returned_by_json), bounty)
        owed = 0
        for a in shares:
            owed += shares[a]
        rest = bounty - owed
        if int(self.balance) < rest:
            raise gl.vm.UserError("REFUSED: REGISTRY_BALANCE_BELOW_REFUND")
        st = ST_FULL if full else (ST_NONE if parts[0] == 0 else ST_PARTIAL)
        # --- writes
        o.status = st
        o.n_expired = o.n_pending
        if int(o.n_pending) > 0:
            self._bump("proofs_expired", int(o.n_pending))
        o.num = str(parts[0])
        o.den = str(parts[1])
        o.owed = u256(owed)
        o.shares_json = _canon({a: str(shares[a]) for a in shares})
        o.settled_at = u64(now)
        o.settled_by = self._sender()
        o.refunded_at_settle = u256(rest)
        o.claim_deadline = u64(now + int(o.claim_window_s)) if owed > 0 else u64(0)
        self.open_total = u256(int(self.open_total) - bounty)
        self.owed_total = u256(int(self.owed_total) + owed)
        self.refunded_total = u256(int(self.refunded_total) + rest)
        self._bump("settled")
        self._bump("settled:" + st)
        if rest > 0:
            self._send(o.protocol, rest)
        return {"ok": True, "offer_id": int(o.offer_id), "status": st, "owed": str(owed), "refunded": str(rest),
                "refund_to": o.protocol if rest > 0 else "", "claim_deadline": int(o.claim_deadline),
                "fraction_ppm": (parts[0] * 1000000) // parts[1] if parts[1] > 0 else 0}

    @gl.public.write
    def commit_beneficiary(self, offer_id: int, payout_to: str) -> typing.Any:
        """A listed exploiter address names, once, the address its share is
        paid to. Only that exploiter address can set it, it cannot be changed,
        and it must be set before the address claims. Refused under the
        EXPLOITER_ONLY payout rule."""
        now = self._now()
        if now <= 0:
            raise gl.vm.UserError("REFUSED: NO_CLOCK")
        o = self._offer(offer_id)
        if o is None:
            raise gl.vm.UserError("REFUSED: NO_SUCH_OFFER")
        who = self._sender()
        if not self._is_exploiter(o, who):
            raise gl.vm.UserError("REFUSED: NOT_AN_EXPLOITER_ADDRESS")
        if o.payout_rule != RULE_OR_NAMED:
            raise gl.vm.UserError("REFUSED: PAYOUT_RULE_IS_" + o.payout_rule)
        a = _addr(payout_to)
        if a == "" or a == ZERO:
            raise gl.vm.UserError("REFUSED: BAD_PAYOUT_ADDRESS")
        bk = str(int(o.offer_id)) + "|" + who
        if self.beneficiaries.get(bk, "") != "":
            raise gl.vm.UserError("REFUSED: BENEFICIARY_ALREADY_COMMITTED")
        if json.loads(o.claims_json).get(who) is not None:
            raise gl.vm.UserError("REFUSED: ALREADY_CLAIMED")
        # --- writes
        self.beneficiaries[bk] = a
        self._bump("beneficiaries")
        return {"ok": True, "offer_id": int(o.offer_id), "exploiter": who, "beneficiary": a}

    def _share(self, o: Offer, who: str) -> int:
        return _as_int(json.loads(o.shares_json).get(who, "0"), 0)

    @gl.public.write
    def claim(self, offer_id: int) -> typing.Any:
        """A listed exploiter address claims ITS OWN share - the part of the
        owed bounty earned by the returns it sent - paid to the beneficiary it
        committed, or to itself."""
        now = self._now()
        if now <= 0:
            raise gl.vm.UserError("REFUSED: NO_CLOCK")
        o = self._offer(offer_id)
        if o is None:
            raise gl.vm.UserError("REFUSED: NO_SUCH_OFFER")
        who = self._sender()
        if o.status == ST_OPEN:
            raise gl.vm.UserError("REFUSED: NOT_SETTLED")
        if not self._is_exploiter(o, who):
            raise gl.vm.UserError("REFUSED: NOT_AN_EXPLOITER_ADDRESS")
        share = self._share(o, who)
        if share <= 0:
            raise gl.vm.UserError("REFUSED: NOTHING_OWED_TO_THIS_ADDRESS")
        claims = json.loads(o.claims_json)
        if claims.get(who) is not None:
            raise gl.vm.UserError("REFUSED: ALREADY_CLAIMED")
        if int(o.unclaimed_refunded) > 0:
            raise gl.vm.UserError("REFUSED: ALREADY_REFUNDED")
        if now > int(o.claim_deadline):
            raise gl.vm.UserError("REFUSED: CLAIM_WINDOW_CLOSED")
        to = self.beneficiaries.get(str(int(o.offer_id)) + "|" + who, "")
        if to == "":
            to = who
        if int(self.balance) < share:
            raise gl.vm.UserError("REFUSED: REGISTRY_BALANCE_BELOW_CLAIM")
        # --- writes
        claims[who] = {"amount": str(share), "to": to, "at": now}
        o.claims_json = _canon(claims)
        o.claimed = u256(int(o.claimed) + share)
        self.owed_total = u256(int(self.owed_total) - share)
        self.paid_total = u256(int(self.paid_total) + share)
        self._bump("claims")
        self._send(to, share)
        return {"ok": True, "offer_id": int(o.offer_id), "exploiter": who, "paid": str(share), "to": to}

    @gl.public.write
    def refund_unclaimed(self, offer_id: int) -> typing.Any:
        """Anyone, after the claim window: every unclaimed share goes back to the protocol."""
        now = self._now()
        if now <= 0:
            raise gl.vm.UserError("REFUSED: NO_CLOCK")
        o = self._offer(offer_id)
        if o is None:
            raise gl.vm.UserError("REFUSED: NO_SUCH_OFFER")
        if o.status == ST_OPEN:
            raise gl.vm.UserError("REFUSED: NOT_SETTLED")
        if int(o.owed) <= 0:
            raise gl.vm.UserError("REFUSED: NOTHING_OWED")
        if int(o.unclaimed_refunded) > 0:
            raise gl.vm.UserError("REFUSED: ALREADY_REFUNDED")
        left = int(o.owed) - int(o.claimed)
        if left <= 0:
            raise gl.vm.UserError("REFUSED: ALREADY_CLAIMED")
        if now <= int(o.claim_deadline):
            raise gl.vm.UserError("REFUSED: CLAIM_WINDOW_OPEN_UNTIL_" + str(int(o.claim_deadline)))
        if int(self.balance) < left:
            raise gl.vm.UserError("REFUSED: REGISTRY_BALANCE_BELOW_REFUND")
        # --- writes
        o.unclaimed_refunded = u256(left)
        o.refunded_at = u64(now)
        self.owed_total = u256(int(self.owed_total) - left)
        self.refunded_total = u256(int(self.refunded_total) + left)
        self._bump("unclaimed_refunds")
        self._send(o.protocol, left)
        return {"ok": True, "offer_id": int(o.offer_id), "refunded": str(left), "to": o.protocol}

    @gl.public.write
    def withdraw_refund(self) -> typing.Any:
        """Value a refused create_offer credited back to the caller."""
        who = self._sender()
        amt = int(self.credits.get(who, u256(0)))
        if amt <= 0:
            raise gl.vm.UserError("REFUSED: NOTHING_TO_WITHDRAW")
        if int(self.balance) < amt:
            raise gl.vm.UserError("REFUSED: REGISTRY_BALANCE_BELOW_CREDIT")
        # --- writes
        self.credits[who] = u256(0)
        self.credit_owed_total = u256(int(self.credit_owed_total) - amt)
        self.credit_paid_total = u256(int(self.credit_paid_total) + amt)
        self._bump("credit_withdrawals")
        self._send(who, amt)
        return {"ok": True, "withdrawn": str(amt)}

    @gl.public.write
    def sweep_stray(self) -> typing.Any:
        """GEN in the balance above what the ledger holds arrived outside
        create_offer (the runtime keeps value sent with a failing or
        non-payable call). It belongs to no offer; anyone may send it to the
        deployer."""
        now = self._now()
        if now <= 0:
            raise gl.vm.UserError("REFUSED: NO_CLOCK")
        if now < int(self.last_send_at) + int(self.sweep_delay_s):
            raise gl.vm.UserError("REFUSED: SENDS_MAY_BE_PENDING_UNTIL_" + str(int(self.last_send_at) + int(self.sweep_delay_s)))
        stray = int(self.balance) - self._held()
        if stray <= 0:
            raise gl.vm.UserError("REFUSED: NO_STRAY_BALANCE")
        # --- writes
        self.stray_swept_total = u256(int(self.stray_swept_total) + stray)
        self._bump("sweeps")
        self._send(self.deployer, stray)
        return {"ok": True, "swept": str(stray), "to": self.deployer}

    # --- views (storage only) -------------------------------------------------

    def _due(self, o: Offer, now: int) -> str:
        if o.status == ST_OPEN:
            if self._can_settle(o, now):
                return "SETTLE"
            if int(o.n_pending) > 0 and now >= self._settle_at(o):
                return "RETRY_PENDING"
            return ""
        if int(o.owed) > int(o.claimed) and int(o.unclaimed_refunded) == 0 and now > int(o.claim_deadline):
            return "REFUND_UNCLAIMED"
        return ""

    def _summary(self, o: Offer) -> dict:
        n = int(o.num)
        d = int(o.den)
        return {"offer_id": int(o.offer_id), "incident": o.incident, "name": o.name, "protocol": o.protocol,
                "status": o.status, "created_at": int(o.created_at), "start": int(o.start),
                "deadline": int(o.deadline), "settle_at": self._settle_at(o), "recover_until": self._recover_until(o),
                "settled_at": int(o.settled_at),
                "claim_deadline": int(o.claim_deadline), "bounty": str(int(o.bounty)),
                "bounty_share_bps": int(o.bounty_share_bps), "fraction_ppm": (n * 1000000) // d if d > 0 else 0,
                "owed": str(int(o.owed)), "refunded_at_settle": str(int(o.refunded_at_settle)),
                "claimed": str(int(o.claimed)), "unclaimed_refunded": str(int(o.unclaimed_refunded)),
                "n_proofs": int(o.n_proofs), "n_counted": int(o.n_counted), "n_rejected": int(o.n_rejected),
                "n_pending": int(o.n_pending) if o.status == ST_OPEN else 0, "n_expired": int(o.n_expired),
                "chains": json.loads(o.chains_json), "meta": json.loads(o.meta_json)}

    def _full(self, o: Offer) -> dict:
        out = self._summary(o)
        out["original_deadline"] = int(o.original_deadline)
        out["payout_rule"] = o.payout_rule
        out["claim_window_s"] = int(o.claim_window_s)
        out["exploiters"] = json.loads(o.exploiters_json)
        out["recoveries"] = json.loads(o.recoveries_json)
        out["tokens"] = json.loads(o.tokens_json)
        out["returned"] = json.loads(o.returned_json)
        out["returned_by"] = json.loads(o.returned_by_json)
        out["shares"] = json.loads(o.shares_json)
        out["claims"] = json.loads(o.claims_json)
        bens = {}
        for e in json.loads(o.exploiters_json):
            b = self.beneficiaries.get(str(int(o.offer_id)) + "|" + e["address"], "")
            if b != "":
                bens[e["address"]] = b
        out["beneficiaries"] = bens
        out["amendments"] = json.loads(o.amendments_json)
        out["amendments_close_at"] = int(o.deadline) - int(self.amend_lock_s)
        out["max_deadline"] = int(o.original_deadline) + int(self.max_extend_s)
        out["num"] = o.num
        out["den"] = o.den
        out["settled_by"] = o.settled_by
        out["refunded_at"] = int(o.refunded_at)
        return out

    @gl.public.view
    def get_offer(self, offer_id: int) -> typing.Any:
        o = self._offer(offer_id)
        if o is None:
            return {"found": False, "offer_id": _as_int(offer_id, 0)}
        out = self._full(o)
        out["found"] = True
        return out

    @gl.public.view
    def get_offer_by(self, protocol: str, incident: str) -> typing.Any:
        """The latest offer that `protocol` itself created under `incident`
        (incident as stored: clean_text, at most MAX_NAME characters). An offer
        another address opened under the same name is never returned."""
        a = _addr(protocol)
        inc = clean_text(incident, MAX_NAME)
        oid = int(self.by_incident.get(a + "|" + inc, u64(0))) if a != "" and inc != "" else 0
        o = self.offers.get(u64(oid)) if oid > 0 else None
        if o is None:
            return {"found": False, "protocol": a, "incident": inc}
        out = self._full(o)
        out["found"] = True
        return out

    @gl.public.view
    def get_offers(self, offset: int, limit: int) -> typing.Any:
        """Offers offset+1 .. offset+limit (ids are 1..n), oldest first."""
        off = max(_as_int(offset, 0), 0)
        lim = min(max(_as_int(limit, PAGE_MAX), 1), PAGE_MAX)
        n = int(self.n_offers)
        items = []
        i = off + 1
        while i <= n and len(items) < lim:
            o = self.offers.get(u64(i))
            if o is not None:
                items.append(self._summary(o))
            i += 1
        return {"total": n, "offset": off, "limit": lim, "items": items,
                "next_offset": off + len(items) if off + len(items) < n else -1}

    @gl.public.view
    def get_due(self, now: int, offset: int, limit: int) -> typing.Any:
        """Offers, scanned offset+1 .. offset+limit, that need a keeper action
        at time `now` (SETTLE or REFUND_UNCLAIMED). The caller passes its clock;
        the write re-checks with the chain's."""
        t = _as_int(now, 0)
        off = max(_as_int(offset, 0), 0)
        lim = min(max(_as_int(limit, PAGE_MAX), 1), PAGE_MAX)
        n = int(self.n_offers)
        items = []
        i = off + 1
        scanned = 0
        while i <= n and scanned < lim:
            o = self.offers.get(u64(i))
            scanned += 1
            if o is not None:
                d = self._due(o, t)
                if d != "":
                    s = self._summary(o)
                    s["due"] = d
                    items.append(s)
            i += 1
        nxt = off + scanned
        return {"total": n, "offset": off, "limit": lim, "scanned": scanned, "items": items,
                "next_offset": nxt if nxt < n else -1}

    def _proof_view(self, p: Proof) -> dict:
        st = p.status
        if st == P_PENDING:
            o = self.offers.get(p.offer_id)
            if o is not None and o.status != ST_OPEN:
                st = P_EXPIRED
        return {"proof_id": int(p.proof_id), "offer_id": int(p.offer_id), "chain": p.chain, "tx_hash": p.tx_hash,
                "submitter": p.submitter, "submitted_at": int(p.submitted_at), "status": st,
                "attempts": int(p.attempts), "updated_at": int(p.updated_at), "transient": p.reason in TRANSIENT,
                "reason": p.reason, "detail": p.detail, "credits": json.loads(p.credits_json), "block": int(p.block),
                "block_time": int(p.block_time), "from": p.tx_from, "to": p.tx_to}

    @gl.public.view
    def get_proofs(self, offer_id: int, offset: int, limit: int) -> typing.Any:
        o = self._offer(offer_id)
        if o is None:
            return {"found": False, "total": 0, "items": [], "next_offset": -1}
        off = max(_as_int(offset, 0), 0)
        lim = min(max(_as_int(limit, PAGE_MAX), 1), PAGE_MAX)
        n = int(o.n_proofs)
        items = []
        i = off
        while i < n and len(items) < lim:
            pid = int(self.offer_proofs.get(str(int(o.offer_id)) + ":" + str(i), u64(0)))
            if pid > 0:
                p = self.proofs.get(u64(pid))
                if p is not None:
                    items.append(self._proof_view(p))
            i += 1
        return {"found": True, "offer_id": int(o.offer_id), "total": n, "offset": off, "limit": lim,
                "items": items, "next_offset": off + len(items) if off + len(items) < n else -1}

    @gl.public.view
    def get_proof(self, proof_id: int) -> typing.Any:
        p = self.proofs.get(u64(max(_as_int(proof_id, 0), 0)))
        if p is None:
            return {"found": False}
        out = self._proof_view(p)
        out["found"] = True
        return out

    @gl.public.view
    def get_claimant(self, offer_id: int, exploiter: str) -> typing.Any:
        """One exploiter address's position in an offer: what it returned, its
        share, its committed beneficiary and its claim."""
        o = self._offer(offer_id)
        a = _addr(exploiter)
        if o is None:
            return {"found": False, "offer_id": _as_int(offer_id, 0), "address": a}
        return {"found": True, "offer_id": int(o.offer_id), "address": a, "listed": self._is_exploiter(o, a),
                "returned": json.loads(o.returned_by_json).get(a, {}), "share": str(self._share(o, a)),
                "beneficiary": self.beneficiaries.get(str(int(o.offer_id)) + "|" + a, ""),
                "claim": json.loads(o.claims_json).get(a)}

    @gl.public.view
    def get_credit(self, who: str) -> typing.Any:
        return {"address": _addr(who), "credit": str(int(self.credits.get(_addr(who), u256(0))))}

    @gl.public.view
    def get_config(self) -> typing.Any:
        return {"version": VERSION, "contract": "WhiteFlagRegistry", "mode": self.mode, "deployer": self.deployer,
                "claim_window_s": int(self.claim_window_s), "min_open_s": int(self.min_open_s),
                "rate_n": int(self.rate_n), "rate_window_s": int(self.rate_window_s), "max_items": MAX_ITEMS,
                "max_exploiters": MAX_EXPLOITERS, "max_recoveries": MAX_RECOVERIES, "max_tokens": MAX_TOKENS,
                "max_span_s": MAX_SPAN_S, "max_extend_s": int(self.max_extend_s), "amend_lock_s": int(self.amend_lock_s),
                "amendments": int(self.n_amendments), "min_bounty": str(MIN_BOUNTY),
                "payout_rules": list(PAYOUT_RULES), "page_max": PAGE_MAX, "sweep_delay_s": int(self.sweep_delay_s),
                "finality_grace_s": int(self.finality_grace_s), "recovery_s": int(self.recovery_s),
                "transient_reasons": list(TRANSIENT),
                "last_send_at": int(self.last_send_at), "reasons": list(REASONS),
                "chains": {k: {"chain_id": CHAINS[k][0], "rpcs": list(CHAINS[k][1])} for k in CHAINS}}

    @gl.public.view
    def get_stats(self) -> typing.Any:
        c = {}
        for k in COUNT_KEYS:
            c[k] = int(self.counts.get(k, u64(0)))
        return {"offers": int(self.n_offers), "proofs": int(self.n_proofs), "counts": c,
                "received_total": str(int(self.received_total)), "open_total": str(int(self.open_total)),
                "owed_total": str(int(self.owed_total)), "paid_total": str(int(self.paid_total)),
                "refunded_total": str(int(self.refunded_total)), "credit_owed_total": str(int(self.credit_owed_total)),
                "credit_paid_total": str(int(self.credit_paid_total)), "stray_swept_total": str(int(self.stray_swept_total)),
                "held": str(self._held()), "balance": str(int(self.balance))}
