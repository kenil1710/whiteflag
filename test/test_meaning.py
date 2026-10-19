"""Meaning: the gate never reads favorable from missing data, the docs say
what the code does, and the site's JavaScript rule is the contract's rule.
cd test && python3 -m unittest -q test_meaning"""
import json
import random
import re
import subprocess
import unittest
from pathlib import Path

import fixtures as F

ROOT = Path(__file__).resolve().parent.parent
RG = F.RG
GT = F.GT
RULES = (ROOT / "docs" / "RULES.md").read_text()


def good(**over):
    base = {"found": True, "offer_id": 1, "protocol": F.PROTOCOL, "incident": "x", "status": "SETTLED_FULL",
            "bounty": "100", "owed": "100", "claimed": "0", "refunded_at_settle": "0", "unclaimed_refunded": "0",
            "fraction_ppm": 1000000, "claim_deadline": 5}
    base.update(over)
    return base


class GateNeverFavorableOnMissingData(unittest.TestCase):
    def test_each_missing_field(self):
        for k in list(good().keys()):
            r = good()
            del r[k]
            s = GT.gate_state(r, 1, 900000)
            self.assertFalse(s["favorable"], k)
            self.assertNotIn(s["state"], ("SETTLED_FULL", "SETTLED_PARTIAL"), k)

    def test_each_field_nulled(self):
        for k in list(good().keys()):
            s = GT.gate_state(good(**{k: None}), 1, 900000)
            self.assertFalse(s["favorable"], k)

    def test_each_field_wrong_type(self):
        for k in list(good().keys()):
            for junk in ([], {}, "abc", -5, True, 1.5):
                if k == "found" and junk is True:
                    continue
                s = GT.gate_state(good(**{k: junk}), 1, 900000)
                if s["favorable"]:
                    self.assertEqual(k, "incident", (k, junk))   # the label is informational only

    def test_random_junk_never_favorable(self):
        rnd = random.Random(7)
        vals = [None, "", "0", "1", 0, 1, -1, [], {}, "SETTLED_FULL", "OPEN", True, False, "1000000", 1000000]
        keys = list(good().keys())
        for _ in range(3000):
            raw = {k: rnd.choice(vals) for k in keys if rnd.random() < 0.8}
            s = GT.gate_state(raw, 1, 900000)
            if s["favorable"]:
                # favorable only if it is a complete, consistent settled answer
                self.assertEqual(raw.get("found"), True)
                self.assertIn(raw.get("status"), ("SETTLED_FULL", "SETTLED_PARTIAL"))

    def test_not_settled_states_never_favorable(self):
        for st in ("OPEN", "SETTLED_NONE", "RECOVERED", "", None):
            self.assertFalse(GT.gate_state(good(status=st), 1, 1)["favorable"], st)

    def test_no_offer_is_not_settled(self):
        s = GT.gate_state({"found": False}, 9, 1)
        self.assertEqual((s["state"], s["fraction_ppm"], s["paid"], s["refunded"]), ("NO_OFFER", 0, "0", "0"))

    def test_states_documented(self):
        for st in GT.STATES:
            self.assertIn("`" + st + "`", RULES)


class DocsMatchCode(unittest.TestCase):
    def test_every_reason_documented(self):
        table = RULES[RULES.index("## Rejection reasons"):]
        documented = re.findall(r"^\| `([A-Z_]+)` \|", table, re.M)
        self.assertEqual(sorted(documented), sorted(RG.REASONS))

    def test_modes(self):
        c, d = RG.MODES["CANONICAL"], RG.MODES["DEMO"]
        self.assertIn("3600 s on the canonical registry, 180 s on the demo registry", RULES)
        self.assertEqual((c[0], d[0]), (3600, 180))
        self.assertIn("Minimum open time: %d s canonical, %d s demo" % (c[1], d[1]), RULES)
        self.assertIn("%d proofs per (offer, sender) per window of %d s (canonical) or %d s" % (c[2], c[3], d[3]), RULES)
        self.assertEqual(c[2], d[2])
        self.assertIn("never sooner than %d s (canonical) or %d s (demo)" % (c[4], d[4]), RULES)
        self.assertIn("Finality grace: %d s canonical, %d s demo" % (c[5], d[5]), RULES)

    def test_limits(self):
        self.assertIn("1 to %d (chain, address) pairs; a transaction" % RG.MAX_EXPLOITERS, RULES)
        self.assertIn("1 to %d (chain, address) pairs; no address" % RG.MAX_RECOVERIES, RULES)
        self.assertIn("1 to %d entries" % RG.MAX_TOKENS, RULES)
        self.assertIn("at most %d days later" % (RG.MAX_SPAN_S // 86400), RULES)
        self.assertIn("at most %d days past the original" % (RG.MAX_EXTEND_S // 86400), RULES)
        self.assertIn("with 1 to %d transactions" % RG.MAX_ITEMS, RULES)
        self.assertIn("JSON-RPC batches of at most %d calls" % RG.BATCH_MAX, RULES)
        self.assertIn("at most %d per page" % RG.PAGE_MAX, RULES)
        self.assertIn("at most %d characters" % RG.MAX_NAME, RULES)
        self.assertEqual(RG.MIN_BOUNTY, 10 ** 15)
        self.assertIn("at least 0.001 GEN (10^15 wei)", RULES)
        self.assertIn("1 to 10000 basis points", RULES)

    def test_chains_table(self):
        for name, (cid, urls) in RG.CHAINS.items():
            self.assertIn("| %s | %d | `%s` | `%s` |" % (name, cid, urls[0], urls[1]), RULES)

    def test_payout_rules(self):
        for r in RG.PAYOUT_RULES:
            self.assertIn("`" + r + "`", RULES)

    def test_statuses(self):
        for s in (RG.ST_FULL, RG.ST_PARTIAL, RG.ST_NONE):
            self.assertIn("`" + s + "`", RULES)

    def test_gate_threshold_as_deployed(self):
        dep = (ROOT / "test" / "deploy.mjs").read_text()
        self.assertEqual(len(re.findall(r"SafeHarborGate\", \[r[cd], 900000\]", dep)), 2)
        self.assertIn("threshold (900000 parts per million on both deployed gates)", RULES)

    def test_formula_in_docs_is_the_code(self):
        # the documented formula, evaluated by hand, equals fraction_parts
        toks = [F.tok(stolen=10, weight=3), F.tok(token=F.TOKEN, stolen=1000, weight=1, decimals=6)]
        ret = {"ethereum:native": "50", "ethereum:" + F.TOKEN: "400"}
        num, den = RG.fraction_parts(toks, ret)
        hand_num = min(50, 10) * 10 ** 0 * 3 + min(400, 1000) * 10 ** 12 * 1
        hand_den = 10 * 3 + 1000 * 10 ** 12
        self.assertEqual(num * hand_den, hand_num * den)

    def test_order_of_checks_matches_docs(self):
        src = (ROOT / "build" / "WhiteFlagRegistry.py").read_text()
        body = src[src.index("def judge("):src.index("# ====", src.index("def judge("))]
        order = [body.index(x) for x in ('"TX_FAILED"', '"NOT_FINALIZED"', '"BEFORE_OFFER_START"', '"AFTER_DEADLINE"',
                                          '"SENDER_NOT_EXPLOITER"', '"NO_RETURN_TO_RECOVERY"', '"ALREADY_COUNTED"')]
        self.assertEqual(order, sorted(order))
        doc_order = [RULES.index(x) for x in ("-> `TX_FAILED`", "-> `NOT_FINALIZED`", "-> `BEFORE_OFFER_START`",
                                              "-> `AFTER_DEADLINE`", "-> `SENDER_NOT_EXPLOITER`", "-> `NO_RETURN_TO_RECOVERY`",
                                              "-> `ALREADY_COUNTED`")]
        self.assertEqual(doc_order, sorted(doc_order))

    def test_no_owner_language(self):
        self.assertIn("There is no cancel.", RULES)
        for word in ("admin", "owner can", "pause"):
            self.assertNotIn(word, RULES.lower())


def js(script, payload):
    r = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps(payload), capture_output=True,
                       text=True, cwd=str(ROOT))
    if r.returncode != 0:
        raise AssertionError(r.stderr)
    return json.loads(r.stdout)


JUDGE = """
import { judge, fractionPpm } from "./tools/lib/verify.mjs";
let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => {
  const p = JSON.parse(s);
  const out = p.cases.map((c) => { const r = judge(p.offer, c.chain, c.hash, c.proj, c.fin, new Set(c.used));
    return r.reason ? { reason: r.reason } : { credits: r.credits.map((x) => ({ key: x.key, amount: x.amount })) }; });
  const fr = p.fracs.map((f) => fractionPpm(f.tokens, f.returned).toString());
  console.log(JSON.stringify({ out, fr }));
});
"""


class JsMatchesContract(unittest.TestCase):
    def test_judge_and_fraction_agree(self):
        rnd = random.Random(11)
        offer = {"start": 1000, "deadline": 2000,
                 "exploiters": [{"chain": "ethereum", "address": F.EXPLOITER}, {"chain": "arbitrum", "address": F.EXPLOITER2}],
                 "recoveries": [{"chain": "ethereum", "address": F.RECOVERY}, {"chain": "arbitrum", "address": F.RECOVERY}],
                 "tokens": [{"chain": "ethereum", "token": "native"}, {"chain": "ethereum", "token": F.TOKEN}, {"chain": "arbitrum", "token": F.TOKEN_ARB}]}
        parties = [F.EXPLOITER, F.EXPLOITER2, F.RECOVERY, F.STRANGER]
        cases = []
        for i in range(400):
            chain = rnd.choice(["ethereum", "arbitrum"])
            h = F.h32("c%d" % i)
            logs = []
            for j in range(rnd.randint(0, 3)):
                logs.append({"i": j, "address": rnd.choice([F.TOKEN, F.TOKEN_ARB, F.LOOKALIKE]), "from": rnd.choice(parties),
                             "to": rnd.choice(parties), "amount": str(rnd.choice([0, 1, 10 ** 18]))})
            proj = {"status": rnd.choice([0, 1, 1, 1]), "block": rnd.randint(90, 110), "block_hash": "0x" + "1" * 64,
                    "time": rnd.choice([999, 1000, 1500, 2000, 2001]), "from": rnd.choice(parties), "to": rnd.choice(parties),
                    "value": str(rnd.choice([0, 5])), "logs": logs}
            used = [chain + ":" + h + ":native"] if rnd.random() < 0.2 else []
            cases.append({"chain": chain, "hash": h, "proj": proj, "fin": [100, rnd.choice([100, 105, 120])], "used": used})
        fracs = []
        for _ in range(200):
            toks = [{"chain": "ethereum", "token": "native", "decimals": 18, "stolen": str(rnd.randint(1, 10 ** 22)), "weight": str(rnd.randint(1, 10 ** 6))},
                    {"chain": "ethereum", "token": F.TOKEN, "decimals": rnd.choice([6, 8, 18]), "stolen": str(rnd.randint(1, 10 ** 12)), "weight": str(rnd.randint(1, 10 ** 6))}]
            ret = {"ethereum:native": str(rnd.randint(0, 2 * int(toks[0]["stolen"]))), "ethereum:" + F.TOKEN: str(rnd.randint(0, 2 * int(toks[1]["stolen"])))}
            fracs.append({"tokens": toks, "returned": ret})
        got = js(JUDGE, {"offer": offer, "cases": cases, "fracs": fracs})
        for c, j in zip(cases, got["out"]):
            r = {"read": c["proj"], "final": c["proj"]["block"] <= min(c["fin"])}
            py = RG.judge(offer, c["chain"], c["hash"], r, {k: True for k in c["used"]})
            pyo = {"reason": py["reason"]} if "reason" in py else {"credits": [{"key": x["key"], "amount": x["amount"]} for x in py["credits"]]}
            self.assertEqual(pyo, j, c)
        for f, ppm in zip(fracs, got["fr"]):
            n, d = RG.fraction_parts(f["tokens"], f["returned"])
            self.assertEqual(str(n * 1000000 // d), ppm)


for _i in range(12):
    def _t(self, i=_i):
        rnd = random.Random(100 + i)
        raw = good(status=rnd.choice(["SETTLED_FULL", "SETTLED_PARTIAL", "SETTLED_NONE", "OPEN"]))
        k = rnd.choice(list(raw.keys()))
        raw[k] = rnd.choice([None, "", "x", -1, [], {}])
        s = GT.gate_state(raw, 1, 900000)
        if k not in ("incident", "claim_deadline"):
            self.assertFalse(s["favorable"], (k, raw[k]))
    setattr(GateNeverFavorableOnMissingData, "test_corrupted_answer_%02d" % _i, _t)


if __name__ == "__main__":
    unittest.main()
