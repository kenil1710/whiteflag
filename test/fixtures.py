"""Builders for the offline suite: two mock chains (each served by its two
allowlisted RPC URLs), transactions with receipts and Transfer logs, and a
wired deployment (a WhiteFlagRegistry in either mode and a SafeHarborGate)."""
import hashlib
import json

import stub
import world

RG = world.module("WhiteFlagRegistry")
GT = world.module("SafeHarborGate")

NOW_ISO = "2026-10-17T12:00:00Z"
NOW = RG._epoch_from_iso(NOW_ISO)
GEN = 10 ** 18
ETH = 10 ** 18
TOPIC = RG.TRANSFER_TOPIC
DEPLOYER = "0x" + "d" * 40


def addr(n):
    return "0x" + hashlib.sha256(b"addr%d" % n).hexdigest()[:40]


PROTOCOL = addr(1)
EXPLOITER = addr(2)
EXPLOITER2 = addr(3)
RECOVERY = addr(4)
RECOVERY2 = addr(5)
STRANGER = addr(6)
PROVER = addr(7)
PAYEE = addr(8)
KEEPER = addr(9)
TOKEN = addr(100)        # a listed ERC-20 on ethereum
TOKEN_ARB = addr(101)    # a listed ERC-20 on arbitrum
LOOKALIKE = addr(102)    # same symbol, different address
USDC6 = addr(103)        # a 6-decimals token

# offer window: start / deadline in the past (a historic incident)
START = NOW - 30 * 86400
DEADLINE = NOW - 20 * 86400
BLOCK_TS = START + 86400          # a block inside the window
FINALIZED = {"ethereum": 20_000_000, "arbitrum": 300_000_000}
CHAIN_IDS = {"ethereum": 1, "arbitrum": 42161}
_n = [0]


def h32(seed):
    return "0x" + hashlib.sha256(str(seed).encode()).hexdigest()


def word(n):
    return "0x" + ("%064x" % int(n))


def topic_addr(a):
    return "0x" + "0" * 24 + a[2:].lower()


class Chains:
    """Both mock chains; each is answered identically by its two RPC URLs
    unless a test tampers with one URL."""

    def __init__(self):
        stub.WEB.reset()
        self.c = {}
        for name, fin in FINALIZED.items():
            ch = stub.MockChain(CHAIN_IDS[name], fin, NOW - 900)
            ch.batch_cap = RG.BATCH_MAX
            self.c[name] = ch
            for url in RG.CHAINS[name][1]:
                stub.WEB.chains[url] = ch
        self.next_block = {"ethereum": FINALIZED["ethereum"] - 1000, "arbitrum": FINALIZED["arbitrum"] - 1000}

    def block(self, chain, ts, number=None):
        ch = self.c[chain]
        if number is None:
            number = self.next_block[chain]
            self.next_block[chain] += 1
        ch.set_block(number, ts)
        return number

    def tx(self, chain, frm, to, value=0, logs=(), ts=BLOCK_TS, block=None, status=1, pending=False, missing=False):
        """A transaction with its receipt. logs: (token, from, to, amount) Transfer events
        or raw dicts. Returns the hash."""
        _n[0] += 1
        hsh = h32("tx%d" % _n[0])
        ch = self.c[chain]
        if missing:
            return hsh
        number = self.block(chain, ts, block)
        bh = ch.blocks[number][0]
        tx = {"hash": hsh, "from": frm, "to": to, "value": hex(value), "blockNumber": hex(number), "blockHash": bh,
              "input": "0x", "nonce": "0x1"}
        rlogs = []
        for i, lg in enumerate(logs):
            if isinstance(lg, dict):
                d = dict(lg)
                d.setdefault("logIndex", hex(i))
                rlogs.append(d)
                continue
            token, lf, lt, amt = lg
            rlogs.append({"address": token, "topics": [TOPIC, topic_addr(lf), topic_addr(lt)], "data": word(amt),
                          "logIndex": hex(i), "blockNumber": hex(number), "transactionHash": hsh})
        rc = {"transactionHash": hsh, "status": hex(status), "blockNumber": hex(number), "blockHash": bh, "logs": rlogs}
        if pending:
            tx["blockNumber"] = None
            tx["blockHash"] = None
            rc = None
        ch.txs[hsh] = {"tx": tx, "receipt": rc}
        return hsh


def tok(chain="ethereum", token="native", stolen=100 * ETH, weight=1, decimals=18, symbol="ETH"):
    return {"chain": chain, "token": token, "symbol": symbol, "decimals": decimals, "stolen": str(stolen),
            "weight": str(weight)}


def pairs(*items):
    return json.dumps([{"chain": c, "address": a} for c, a in items])


class Deployment:
    def __init__(self, mode="DEMO", gate_ppm=900000):
        self.w = world.new_world(now_iso=NOW_ISO)
        self.chains = Chains()
        self.reg = self.w.deploy("WhiteFlagRegistry", mode, sender=DEPLOYER)
        self.gate = self.w.deploy("SafeHarborGate", self.reg, gate_ppm, sender=DEPLOYER)
        self.mode = mode

    # --- registry calls ---------------------------------------------------------
    def create(self, bounty=10 * GEN, chains=("ethereum",), exploiters=None, recoveries=None, tokens=None,
               share=1000, start=START, deadline=DEADLINE, rule="EXPLOITER_OR_NAMED", meta="{}", sender=PROTOCOL,
               incident="test-incident", name="Test incident"):
        ex = exploiters if exploiters is not None else pairs(*[(c, EXPLOITER) for c in chains])
        rec = recoveries if recoveries is not None else pairs(*[(c, RECOVERY) for c in chains])
        tk = tokens if tokens is not None else json.dumps([tok()])
        return self.w.call(self.reg, "create_offer", incident, name, json.dumps(list(chains)), ex, rec, tk, share, start,
                           deadline, rule, meta, sender=sender, value=bounty)

    def offer(self, **k):
        r = self.create(**k)
        assert r["ok"], r
        return r["offer_id"]

    def submit(self, oid, items, sender=PROVER):
        return self.w.call(self.reg, "submit_proofs", oid, json.dumps(items), sender=sender)

    def prove(self, oid, chain, hsh, sender=PROVER):
        return self.submit(oid, [[chain, hsh]], sender=sender)["results"][0]

    def settle(self, oid, sender=KEEPER):
        return self.w.call(self.reg, "settle", oid, sender=sender)

    def claim(self, oid, payout_to="", sender=EXPLOITER):
        """claim(); a payout_to other than the sender is committed first (commit_beneficiary)."""
        if payout_to != "" and payout_to.lower() != sender.lower():
            self.commit(oid, payout_to, sender=sender)
        return self.w.call(self.reg, "claim", oid, sender=sender)

    def commit(self, oid, payout_to, sender=EXPLOITER):
        return self.w.call(self.reg, "commit_beneficiary", oid, payout_to, sender=sender)

    def claimant(self, oid, who):
        return self.w.view(self.reg, "get_claimant", oid, who)

    def refund(self, oid, sender=KEEPER):
        return self.w.call(self.reg, "refund_unclaimed", oid, sender=sender)

    def get(self, oid):
        return self.w.view(self.reg, "get_offer", oid)

    def stats(self):
        return self.w.view(self.reg, "get_stats")

    def balance(self):
        return self.w.instances[self.reg].balance

    def sent_to(self, who):
        return sum(a for (src, to, a) in self.w.transfers if to == who.lower())

    def settle_time(self, oid):
        return self.get(oid)["settle_at"]

    def to_settle_time(self, oid):
        self.w.set_time(self.settle_time(oid))

    def ledger_ok(self):
        s = self.stats()
        held = int(s["open_total"]) + int(s["owed_total"]) + int(s["credit_owed_total"])
        out_ = int(s["paid_total"]) + int(s["refunded_total"]) + int(s["credit_paid_total"]) + int(s["stray_swept_total"])
        return int(s["received_total"]) + int(s["stray_swept_total"]) == held + out_ and self.balance() >= held
