"""The internal attack round (docs/ATTACK_REPORT.md), contract and gate
layers. Each test is one attack; it passes when the attack fails.
cd test && python3 -m unittest -q test_attacks"""
import json
import unittest

import fixtures as F
import stub
import world
from fixtures import ETH, GEN, EXPLOITER, EXPLOITER2, RECOVERY, RECOVERY2, STRANGER, PROTOCOL, PAYEE, TOKEN, LOOKALIKE, \
    NOW, START, DEADLINE, tok, pairs, TOPIC, topic_addr, word

Reverted = world.Reverted
RG = F.RG
ATTACKER = F.addr(666)


class Base(unittest.TestCase):
    def setUp(self):
        self.d = F.Deployment()
        self.c = self.d.chains
        self.oid = self.d.offer(tokens=json.dumps([tok(stolen=10 * ETH), tok(token=TOKEN, stolen=10 * ETH, symbol="TKN")]))

    def native(self, value=ETH, frm=EXPLOITER, to=RECOVERY, **k):
        return self.c.tx("ethereum", frm, to, value=value, **k)

    def returned(self, oid=None):
        return self.d.get(oid or self.oid)["returned"]


class ProofSpoofing(Base):
    def test_leader_invents_a_transfer(self):
        h = self.native(frm=STRANGER)

        def forge(res):
            res[0]["read"]["from"] = EXPLOITER
            return res
        stub.FORGE["mutate"] = forge
        try:
            with self.assertRaises(Reverted):
                self.d.prove(self.oid, "ethereum", h)
        finally:
            stub.FORGE["mutate"] = None
        self.assertEqual(self.returned(), {})

    def test_leader_inflates_an_amount(self):
        h = self.native(ETH)

        def forge(res):
            res[0]["read"]["value"] = str(10 ** 24)
            return res
        stub.FORGE["mutate"] = forge
        try:
            with self.assertRaises(Reverted):
                self.d.prove(self.oid, "ethereum", h)
        finally:
            stub.FORGE["mutate"] = None

    def test_leader_claims_finality_it_does_not_have(self):
        h = self.native(block=F.FINALIZED["ethereum"] + 3)

        def forge(res):
            res[0]["final"] = True
            return res
        stub.FORGE["mutate"] = forge
        try:
            with self.assertRaises(Reverted):
                self.d.prove(self.oid, "ethereum", h)
        finally:
            stub.FORGE["mutate"] = None

    def test_leader_rejects_a_good_proof(self):
        # a leader that hides a valid return cannot get the rejection agreed
        h = self.native()
        stub.FORGE["payload"] = [{"reason": "TX_NOT_FOUND", "detail": ""}]
        try:
            with self.assertRaises(Reverted):
                self.d.prove(self.oid, "ethereum", h)
        finally:
            stub.FORGE["payload"] = None
        self.assertEqual(self.d.prove(self.oid, "ethereum", h)["status"], "COUNTED")

    def test_one_lying_rpc(self):
        url = RG.CHAINS["ethereum"][1][0]

        def lie(req, ans):
            if req["method"] == "eth_getTransactionByHash" and ans.get("result"):
                ans = json.loads(json.dumps(ans))
                ans["result"]["from"] = EXPLOITER
            return ans
        stub.WEB.tamper[url] = lie
        r = self.d.prove(self.oid, "ethereum", self.native(frm=STRANGER))
        self.assertEqual((r["status"], r["reason"]), ("PENDING", "RPC_DISAGREE"))

    def test_both_rpcs_on_the_wrong_chain(self):
        self.c.c["ethereum"].chain_id = 56
        r = self.d.prove(self.oid, "ethereum", self.native())
        self.assertEqual(r["reason"], "WRONG_CHAIN_ID")

    def test_hash_from_another_chain(self):
        h = self.c.tx("arbitrum", EXPLOITER, RECOVERY, value=ETH)
        r = self.d.prove(self.oid, "ethereum", h)
        self.assertEqual(r["reason"], "TX_NOT_FOUND")

    def test_unlisted_rpc_cannot_be_used(self):
        self.assertFalse(RG.rpc_url_allowed("https://evil.example/rpc"))


class FakeLogs(Base):
    def test_lookalike_token_same_symbol(self):
        h = self.c.tx("ethereum", EXPLOITER, LOOKALIKE, logs=[(LOOKALIKE, EXPLOITER, RECOVERY, 10 * ETH)])
        self.assertEqual(self.d.prove(self.oid, "ethereum", h)["reason"], "NO_RETURN_TO_RECOVERY")

    def test_attacker_contract_emits_transfer_topic(self):
        # a contract the exploiter calls emits Transfer(exploiter -> recovery); the emitter is not the token
        fake = F.addr(777)
        h = self.c.tx("ethereum", EXPLOITER, fake, logs=[(fake, EXPLOITER, RECOVERY, 10 * ETH)])
        self.assertEqual(self.d.prove(self.oid, "ethereum", h)["reason"], "NO_RETURN_TO_RECOVERY")

    def test_four_topic_transfer_is_not_erc20(self):
        # ERC-721 Transfer has the tokenId as a 4th topic: never an ERC-20 amount
        lg = {"address": TOKEN, "topics": [TOPIC, topic_addr(EXPLOITER), topic_addr(RECOVERY), word(5)], "data": "0x"}
        h = self.c.tx("ethereum", EXPLOITER, TOKEN, logs=[lg])
        self.assertEqual(self.d.prove(self.oid, "ethereum", h)["reason"], "NO_RETURN_TO_RECOVERY")

    def test_other_event_with_three_topics(self):
        approval = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"
        lg = {"address": TOKEN, "topics": [approval, topic_addr(EXPLOITER), topic_addr(RECOVERY)], "data": word(10 * ETH)}
        h = self.c.tx("ethereum", EXPLOITER, TOKEN, logs=[lg])
        self.assertEqual(self.d.prove(self.oid, "ethereum", h)["reason"], "NO_RETURN_TO_RECOVERY")

    def test_dirty_topic_padding(self):
        # high bytes in an address topic: not a clean address, the read is refused rather than truncated
        bad = "0x" + "ff" * 12 + EXPLOITER[2:]
        lg = {"address": TOKEN, "topics": [TOPIC, bad, topic_addr(RECOVERY)], "data": word(ETH)}
        h = self.c.tx("ethereum", EXPLOITER, TOKEN, logs=[lg])
        r = self.d.prove(self.oid, "ethereum", h)
        self.assertEqual(r["status"], "REJECTED")

    def test_malformed_log_data(self):
        lg = {"address": TOKEN, "topics": [TOPIC, topic_addr(EXPLOITER), topic_addr(RECOVERY)], "data": "0xzz"}
        h = self.c.tx("ethereum", EXPLOITER, TOKEN, logs=[lg])
        self.assertEqual(self.d.prove(self.oid, "ethereum", h)["reason"], "RPC_UNREADABLE")


class ProxyTokens(Base):
    def test_proxy_address_is_what_counts(self):
        proxy, impl = F.addr(801), F.addr(802)
        oid = self.d.offer(tokens=json.dumps([tok(token=proxy, symbol="PRX")]))
        # the proxy emits the event (delegatecall keeps the proxy as log address)
        h = self.c.tx("ethereum", EXPLOITER, proxy, logs=[(proxy, EXPLOITER, RECOVERY, ETH)])
        self.assertEqual(self.d.prove(oid, "ethereum", h)["status"], "COUNTED")

    def test_listing_the_implementation_does_not_count_proxy_events(self):
        proxy, impl = F.addr(801), F.addr(802)
        oid = self.d.offer(tokens=json.dumps([tok(token=impl, symbol="IMP")]))
        h = self.c.tx("ethereum", EXPLOITER, proxy, logs=[(proxy, EXPLOITER, RECOVERY, ETH)])
        self.assertEqual(self.d.prove(oid, "ethereum", h)["reason"], "NO_RETURN_TO_RECOVERY")


class Reorgs(Base):
    def test_unfinalized_block(self):
        r = self.d.prove(self.oid, "ethereum", self.native(block=F.FINALIZED["ethereum"] + 1))
        self.assertEqual(r["reason"], "NOT_FINALIZED")
        self.assertEqual(self.returned(), {})

    def test_rpcs_on_different_forks(self):
        url = RG.CHAINS["ethereum"][1][1]

        def fork(req, ans):
            if req["method"] in ("eth_getTransactionReceipt",) and ans.get("result"):
                ans = json.loads(json.dumps(ans))
                ans["result"]["blockNumber"] = hex(int(ans["result"]["blockNumber"], 16) + 1)
            return ans
        stub.WEB.tamper[url] = fork
        self.assertEqual(self.d.prove(self.oid, "ethereum", self.native())["status"], "PENDING")

    def test_receipt_block_hash_not_the_header(self):
        for url in RG.CHAINS["ethereum"][1]:
            def other(req, ans):
                if req["method"] == "eth_getTransactionReceipt" and ans.get("result"):
                    ans = json.loads(json.dumps(ans))
                    ans["result"]["blockHash"] = "0x" + "11" * 32
                return ans
            stub.WEB.tamper[url] = other
        self.assertEqual(self.d.prove(self.oid, "ethereum", self.native())["reason"], "RPC_UNREADABLE")


class WrongParties(Base):
    def test_non_exploiter_sends_to_recovery(self):
        self.assertEqual(self.d.prove(self.oid, "ethereum", self.native(frm=STRANGER))["reason"], "SENDER_NOT_EXPLOITER")

    def test_exploiter_moves_victim_tokens_via_allowance(self):
        # transferFrom(victim, recovery): the Transfer is from the victim, not an exploiter address
        victim = F.addr(900)
        h = self.c.tx("ethereum", EXPLOITER, TOKEN, logs=[(TOKEN, victim, RECOVERY, 10 * ETH)])
        self.assertEqual(self.d.prove(self.oid, "ethereum", h)["reason"], "NO_RETURN_TO_RECOVERY")

    def test_third_party_pays_on_behalf_counts_only_its_exploiter_logs(self):
        h = self.c.tx("ethereum", EXPLOITER, TOKEN, logs=[(TOKEN, STRANGER, RECOVERY, ETH), (TOKEN, EXPLOITER, RECOVERY, 2 * ETH)])
        r = self.d.prove(self.oid, "ethereum", h)
        self.assertEqual([c["amount"] for c in r["credits"]], [str(2 * ETH)])

    def test_exploiter_returns_to_itself(self):
        self.assertEqual(self.d.prove(self.oid, "ethereum", self.native(to=EXPLOITER2))["reason"], "NO_RETURN_TO_RECOVERY")

    def test_protocol_cannot_make_an_exploiter_a_recovery(self):
        with self.assertRaises(Reverted):
            self.d.w.call(self.d.reg, "add_recovery", self.oid, "ethereum", EXPLOITER, sender=PROTOCOL)


class Splitting(Base):
    def test_split_returns_add_up_exactly(self):
        hs = [self.native(ETH // 7) for _ in range(7)]
        for i in range(0, 7, 5):
            self.d.submit(self.oid, [["ethereum", h] for h in hs[i:i + 5]])
        self.assertEqual(self.returned()["ethereum:native"], str(7 * (ETH // 7)))

    def test_splitting_does_not_beat_the_cap(self):
        for _ in range(3):
            self.d.submit(self.oid, [["ethereum", self.native(5 * ETH)] for _ in range(5)])
        self.d.w.set_time(self.d.get(self.oid)["settle_at"])
        r = self.d.settle(self.oid)
        self.assertEqual(r["fraction_ppm"], 500000)   # ETH capped at its stolen amount, the token is still missing

    def test_splitting_has_no_rounding_gain(self):
        a = F.Deployment()
        oa = a.offer(bounty=10 ** 18 + 1, tokens=json.dumps([tok(stolen=3)]))
        a.prove(oa, "ethereum", a.chains.tx("ethereum", EXPLOITER, RECOVERY, value=2))
        b = F.Deployment()
        ob = b.offer(bounty=10 ** 18 + 1, tokens=json.dumps([tok(stolen=3)]))
        b.submit(ob, [["ethereum", b.chains.tx("ethereum", EXPLOITER, RECOVERY, value=1)], ["ethereum", b.chains.tx("ethereum", EXPLOITER, RECOVERY, value=1)]])
        for d, o in ((a, oa), (b, ob)):
            d.w.set_time(d.get(o)["settle_at"])
        self.assertEqual(a.settle(oa)["owed"], b.settle(ob)["owed"])


class Griefing(Base):
    def test_junk_proofs_do_not_block_a_real_one(self):
        for s in range(4):
            sender = F.addr(3000 + s)
            self.d.submit(self.oid, [["ethereum", self.native(frm=STRANGER)] for _ in range(5)], sender=sender)
        r = self.d.prove(self.oid, "ethereum", self.native(), sender=F.addr(3999))
        self.assertEqual(r["status"], "COUNTED")

    def test_early_junk_submission_of_a_real_tx_is_resubmittable(self):
        h = self.native(block=F.FINALIZED["ethereum"] + 1)
        r = self.d.prove(self.oid, "ethereum", h, sender=ATTACKER)
        self.assertEqual((r["status"], r["reason"]), ("PENDING", "NOT_FINALIZED"))
        self.c.c["ethereum"].finalized += 10
        self.c.c["ethereum"].set_block(self.c.c["ethereum"].finalized, NOW - 600)
        self.assertEqual(self.d.retry(self.oid, [r["proof_id"]])["results"][0]["status"], "COUNTED")

    def test_rate_limit_binds_the_griefer_only(self):
        for _ in range(4):
            self.d.submit(self.oid, [["ethereum", self.native(frm=STRANGER)] for _ in range(5)], sender=ATTACKER)
        with self.assertRaises(Reverted):
            self.d.prove(self.oid, "ethereum", self.native(frm=STRANGER), sender=ATTACKER)
        self.assertEqual(self.d.prove(self.oid, "ethereum", self.native())["status"], "COUNTED")

    def test_copycat_offer_cannot_consume_the_real_offers_return(self):
        fake = self.d.offer(bounty=10 ** 15, sender=ATTACKER, tokens=json.dumps([tok(stolen=10 * ETH)]))
        h = self.native(10 * ETH)
        self.d.prove(fake, "ethereum", h, sender=ATTACKER)
        self.assertEqual(self.d.prove(self.oid, "ethereum", h)["status"], "COUNTED")

    def test_griefer_cannot_settle_early(self):
        oid = self.d.offer(deadline=NOW + 1000)
        with self.assertRaises(Reverted):
            self.d.settle(oid, sender=ATTACKER)

    def test_huge_receipt_is_bounded(self):
        logs = [(TOKEN, EXPLOITER, RECOVERY, 1) for _ in range(300)]
        h = self.c.tx("ethereum", EXPLOITER, TOKEN, logs=logs)
        r = self.d.prove(self.oid, "ethereum", h)
        self.assertEqual(len(r["credits"]), 300)

    def test_batch_chunks_when_an_rpc_takes_fewer_calls(self):
        for url in RG.CHAINS["ethereum"][1]:
            stub.WEB.caps[url] = RG.BATCH_MAX
        r = self.d.submit(self.oid, [["ethereum", self.native()] for _ in range(5)])
        self.assertEqual([x["status"] for x in r["results"]], ["COUNTED"] * 5)

    def test_rejection_detail_names_the_rpc(self):
        stub.WEB.down.add(RG.CHAINS["ethereum"][1][0])
        r = self.d.prove(self.oid, "ethereum", self.native())
        self.assertIn(RG.CHAINS["ethereum"][1][0].split("/")[2], r["detail"])


class ClaimFrontRunning(Base):
    def settled(self):
        oid = self.d.offer(tokens=json.dumps([tok(stolen=10 * ETH)]), exploiters=pairs(("ethereum", EXPLOITER), ("ethereum", EXPLOITER2)))
        self.d.prove(oid, "ethereum", self.native(5 * ETH))
        self.d.w.set_time(self.d.get(oid)["settle_at"])
        self.d.settle(oid)
        return oid

    def test_stranger_cannot_claim_to_itself(self):
        oid = self.settled()
        with self.assertRaises(Reverted):
            self.d.claim(oid, ATTACKER, sender=ATTACKER)

    def test_stranger_cannot_redirect_a_pending_claim(self):
        oid = self.settled()
        for who in (PROTOCOL, ATTACKER, RECOVERY):
            with self.assertRaises(Reverted):
                self.d.commit(oid, ATTACKER, sender=who)
        r = self.d.claim(oid, PAYEE)
        self.assertEqual(r["to"], PAYEE)

    def test_payout_address_is_bound_to_the_commitment(self):
        oid = self.settled()
        self.d.commit(oid, PAYEE, sender=EXPLOITER)
        with self.assertRaises(Reverted):
            self.d.commit(oid, ATTACKER, sender=EXPLOITER)
        self.d.claim(oid, sender=EXPLOITER)
        self.assertEqual(self.d.sent_to(PAYEE), 5 * GEN)
        self.assertEqual(self.d.sent_to(ATTACKER), 0)

    def test_refund_cannot_race_an_open_window(self):
        oid = self.settled()
        with self.assertRaises(Reverted):
            self.d.refund(oid, sender=ATTACKER)
        self.assertEqual(self.d.claim(oid)["paid"], str(5 * GEN))

    def test_protocol_cannot_cancel_to_dodge_paying(self):
        for name in ("cancel", "cancel_offer", "withdraw_bounty", "reduce_bounty", "remove_exploiter"):
            self.assertFalse(hasattr(RG.WhiteFlagRegistry, name))


class GateAttacks(Base):
    def test_copycat_full_offer_never_reaches_the_gate(self):
        fake = self.d.offer(bounty=10 ** 15, sender=ATTACKER, incident="test-incident", exploiters=pairs(("ethereum", STRANGER)),
                            tokens=json.dumps([tok(stolen=1)]), deadline=NOW + 10 ** 6)
        self.d.prove(fake, "ethereum", self.native(1, frm=STRANGER))
        self.d.settle(fake)
        s = self.d.w.view(self.d.gate, "check_for", PROTOCOL, "test-incident")
        self.assertEqual((s["favorable"], s["offer_id"]), (False, self.oid))
        self.assertFalse(self.d.w.view(self.d.gate, "is_favorable_for", PROTOCOL, "test-incident"))

    def test_check_for_the_right_protocol(self):
        oid = self.d.offer(incident="right", tokens=json.dumps([tok(stolen=1)]), deadline=NOW + 10 ** 6)
        self.d.prove(oid, "ethereum", self.native(1))
        self.d.settle(oid)
        self.assertTrue(self.d.w.view(self.d.gate, "is_favorable_for", PROTOCOL, "right"))

    def test_check_for_bad_address(self):
        self.assertFalse(self.d.w.view(self.d.gate, "check_for", "nope", "test-incident")["favorable"])

    def test_registry_answer_without_protocol(self):
        raw = {"found": True, "offer_id": 1, "incident": "x", "status": "SETTLED_FULL", "bounty": "1", "owed": "1", "claimed": "0",
               "refunded_at_settle": "0", "unclaimed_refunded": "0", "fraction_ppm": 1000000, "claim_deadline": 1}
        self.assertEqual(F.GT.gate_state(raw, PROTOCOL, "x", 900000)["state"], "UNREADABLE")


class Money(Base):
    def test_value_never_leaves_except_through_send(self):
        oid = self.d.offer(bounty=3 * GEN, tokens=json.dumps([tok(stolen=10 * ETH)]))
        self.d.prove(oid, "ethereum", self.native(5 * ETH))
        self.d.w.set_time(self.d.get(oid)["settle_at"])
        self.d.settle(oid)
        self.d.claim(oid)
        for _, to, amt in self.d.w.transfers:
            self.assertIn(to, (PROTOCOL, EXPLOITER))
        self.assertTrue(self.d.ledger_ok())

    def test_refused_create_cannot_be_withdrawn_by_someone_else(self):
        self.d.create(bounty=GEN, rule="X")
        with self.assertRaises(Reverted):
            self.d.w.call(self.d.reg, "withdraw_refund", sender=ATTACKER)

    def test_stray_sweep_cannot_touch_bounties(self):
        self.d.w.instances[self.d.reg].balance += 1
        r = self.d.w.call(self.d.reg, "sweep_stray", sender=ATTACKER)
        self.assertEqual((r["swept"], r["to"]), ("1", F.DEPLOYER))
        self.assertEqual(int(self.d.stats()["open_total"]), self.d.balance())


if __name__ == "__main__":
    unittest.main()
