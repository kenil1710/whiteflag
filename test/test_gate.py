"""SafeHarborGate: structured state per incident, never favorable on missing
or inconsistent data.   cd test && python3 -m unittest -q test_gate"""
import json
import unittest

import fixtures as F
import world
from fixtures import ETH, GEN, NOW, tok, EXPLOITER, RECOVERY, STRANGER

GT = F.GT
Reverted = world.Reverted


def good(**over):
    base = {"found": True, "offer_id": 1, "status": "SETTLED_PARTIAL", "bounty": "100", "owed": "40",
            "claimed": "0", "refunded_at_settle": "60", "unclaimed_refunded": "0", "fraction_ppm": 400000,
            "claim_deadline": NOW + 100}
    base.update(over)
    return base


class PureState(unittest.TestCase):
    def st(self, raw, oid=1, ppm=900000):
        return GT.gate_state(raw, oid, ppm)

    def test_no_offer(self):
        s = self.st({"found": False})
        self.assertEqual((s["state"], s["favorable"]), ("NO_OFFER", False))

    def test_none_is_unreadable(self):
        self.assertEqual(self.st(None)["state"], "UNREADABLE")

    def test_string_not_json(self):
        self.assertEqual(self.st("{oops")["state"], "UNREADABLE")

    def test_list_is_unreadable(self):
        self.assertEqual(self.st([1, 2])["state"], "UNREADABLE")

    def test_empty_object_is_unreadable_not_no_offer(self):
        self.assertEqual(self.st({})["state"], "UNREADABLE")

    def test_other_offer_id_unreadable(self):
        self.assertEqual(self.st(good(offer_id=2))["state"], "UNREADABLE")

    def test_unknown_status(self):
        self.assertEqual(self.st(good(status="RECOVERED"))["state"], "UNREADABLE")

    def test_missing_field(self):
        r = good()
        del r["owed"]
        self.assertEqual(self.st(r)["state"], "UNREADABLE")

    def test_negative_field(self):
        self.assertEqual(self.st(good(owed=-1))["state"], "UNREADABLE")

    def test_bool_field(self):
        self.assertEqual(self.st(good(fraction_ppm=True))["state"], "UNREADABLE")

    def test_ppm_over_million(self):
        self.assertEqual(self.st(good(fraction_ppm=1000001))["state"], "UNREADABLE")

    def test_numbers_must_add_up(self):
        self.assertEqual(self.st(good(refunded_at_settle="59"))["state"], "UNREADABLE")

    def test_claimed_above_owed(self):
        self.assertEqual(self.st(good(claimed="41"))["state"], "UNREADABLE")

    def test_full_with_wrong_ppm(self):
        self.assertEqual(self.st(good(status="SETTLED_FULL", owed="100", refunded_at_settle="0", fraction_ppm=999999))["state"], "UNREADABLE")

    def test_none_with_owed(self):
        self.assertEqual(self.st(good(status="SETTLED_NONE", fraction_ppm=0))["state"], "UNREADABLE")

    def test_partial_with_full_ppm(self):
        self.assertEqual(self.st(good(fraction_ppm=1000000))["state"], "UNREADABLE")

    def test_open_never_favorable(self):
        s = self.st(good(status="OPEN", fraction_ppm=1000000))
        self.assertEqual((s["state"], s["favorable"]), ("OPEN", False))

    def test_full_favorable(self):
        s = self.st(good(status="SETTLED_FULL", owed="100", refunded_at_settle="0", fraction_ppm=1000000))
        self.assertEqual((s["state"], s["favorable"]), ("SETTLED_FULL", True))

    def test_partial_below_threshold(self):
        s = self.st(good())
        self.assertEqual((s["state"], s["favorable"]), ("SETTLED_PARTIAL", False))

    def test_partial_at_threshold(self):
        s = self.st(good(fraction_ppm=900000, owed="90", refunded_at_settle="10"))
        self.assertTrue(s["favorable"])

    def test_partial_just_below_threshold(self):
        s = self.st(good(fraction_ppm=899999, owed="89", refunded_at_settle="11"))
        self.assertFalse(s["favorable"])

    def test_none_not_favorable(self):
        s = self.st(good(status="SETTLED_NONE", owed="0", refunded_at_settle="100", fraction_ppm=0))
        self.assertEqual((s["state"], s["favorable"]), ("SETTLED_NONE", False))

    def test_paid_and_refunded_reported(self):
        s = self.st(good(claimed="40"))
        self.assertEqual((s["paid"], s["refunded"]), ("40", "60"))

    def test_every_unfavorable_state_has_a_reason(self):
        for raw in (None, {}, {"found": False}, good(status="OPEN"), good(owed="x")):
            s = self.st(raw)
            self.assertFalse(s["favorable"])
            self.assertNotEqual(s["why"], "")


class OnRegistry(unittest.TestCase):
    def setUp(self):
        self.d = F.Deployment()

    def check(self, oid):
        return self.d.w.view(self.d.gate, "check", oid)

    def test_no_offer(self):
        self.assertEqual(self.check(7)["state"], "NO_OFFER")

    def test_zero_id(self):
        self.assertEqual(self.check(0)["state"], "NO_OFFER")

    def test_open(self):
        oid = self.d.offer()
        self.assertEqual(self.check(oid)["state"], "OPEN")

    def test_open_at_100_not_favorable_until_settled(self):
        oid = self.d.offer(deadline=NOW + 10 ** 6, tokens=json.dumps([tok(stolen=ETH)]))
        self.d.prove(oid, "ethereum", self.d.chains.tx("ethereum", EXPLOITER, RECOVERY, value=ETH))
        s = self.check(oid)
        self.assertEqual((s["state"], s["favorable"], s["fraction_ppm"]), ("OPEN", False, 1000000))
        self.d.settle(oid)
        self.assertEqual((self.check(oid)["state"], self.check(oid)["favorable"]), ("SETTLED_FULL", True))

    def test_partial_and_none_from_registry(self):
        a = self.d.offer(tokens=json.dumps([tok(stolen=10 * ETH)]))
        b = self.d.offer()
        self.d.prove(a, "ethereum", self.d.chains.tx("ethereum", EXPLOITER, RECOVERY, value=9 * ETH))
        self.d.w.advance(100)
        self.d.settle(a)
        self.d.settle(b)
        self.assertEqual((self.check(a)["state"], self.check(a)["favorable"]), ("SETTLED_PARTIAL", True))
        self.assertEqual((self.check(b)["state"], self.check(b)["favorable"]), ("SETTLED_NONE", False))

    def test_registry_gone_is_unreadable(self):
        oid = self.d.offer()
        del self.d.w.instances[self.d.reg]
        s = self.check(oid)
        self.assertEqual((s["state"], s["favorable"]), ("UNREADABLE", False))

    def test_is_favorable(self):
        self.assertFalse(self.d.w.view(self.d.gate, "is_favorable", 1))

    def test_attest_and_latest(self):
        oid = self.d.offer()
        a = self.d.w.call(self.d.gate, "attest", oid, sender=STRANGER)
        self.assertEqual((a["attestation_id"], a["state"]), (1, "OPEN"))
        l = self.d.w.view(self.d.gate, "get_latest", oid)
        self.assertEqual((l["found"], l["attested_by"]), (True, STRANGER))

    def test_latest_missing_is_not_a_state(self):
        self.assertEqual(self.d.w.view(self.d.gate, "get_latest", 3), {"found": False, "offer_id": 3})

    def test_attest_no_offer_recorded_as_no_offer(self):
        a = self.d.w.call(self.d.gate, "attest", 9)
        self.assertEqual(a["state"], "NO_OFFER")

    def test_attestations_pages(self):
        oid = self.d.offer()
        for _ in range(5):
            self.d.w.call(self.d.gate, "attest", oid)
        p = self.d.w.view(self.d.gate, "get_attestations", 2, 2)
        self.assertEqual(([x["attestation_id"] for x in p["items"]], p["next_offset"]), ([3, 4], 4))

    def test_get_attestation_missing(self):
        self.assertFalse(self.d.w.view(self.d.gate, "get_attestation", 1)["found"])

    def test_config(self):
        c = self.d.w.view(self.d.gate, "get_config")
        self.assertEqual((c["registry"], c["min_fraction_ppm"]), (self.d.reg, 900000))

    def test_bad_constructor(self):
        w = self.d.w
        with self.assertRaises(Exception):
            w.deploy("SafeHarborGate", "0x12", 5)
        with self.assertRaises(Exception):
            w.deploy("SafeHarborGate", self.d.reg, 0)
        with self.assertRaises(Exception):
            w.deploy("SafeHarborGate", self.d.reg, 1000001)


if __name__ == "__main__":
    unittest.main()
