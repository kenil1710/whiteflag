"""WhiteFlagRegistry, rule by rule, against build/ (the deployed bytes) and
mock chains.   cd test && python3 -m unittest -q test_registry"""
import json
import unittest

import fixtures as F
import stub
import world
from fixtures import ETH, GEN, EXPLOITER, EXPLOITER2, RECOVERY, RECOVERY2, STRANGER, PROTOCOL, PAYEE, PROVER, TOKEN, \
    TOKEN_ARB, LOOKALIKE, START, DEADLINE, NOW, tok, pairs

Reverted = world.Reverted
RG = F.RG


class Base(unittest.TestCase):
    mode = "DEMO"

    def setUp(self):
        self.d = F.Deployment(self.mode)
        self.c = self.d.chains

    def refused(self, fn, *a, reason=None, **k):
        with self.assertRaises(Reverted) as cm:
            fn(*a, **k)
        if reason is not None:
            self.assertIn(reason, cm.exception.msg)
        return cm.exception.msg

    def native(self, value=10 * ETH, frm=EXPLOITER, to=RECOVERY, **k):
        return self.c.tx("ethereum", frm, to, value=value, **k)

    def erc20(self, amount=10 * ETH, token=TOKEN, frm=EXPLOITER, to=RECOVERY, sender=None, chain="ethereum", **k):
        return self.c.tx(chain, sender or frm, token, logs=[(token, frm, to, amount)], **k)

    def two_token_offer(self, **k):
        return self.d.offer(tokens=json.dumps([tok(stolen=100 * ETH, weight=2000), tok(token=TOKEN, stolen=1000 * ETH, weight=1, symbol="TKN")]), **k)


# =============================================================================
# 1. creating an offer
# =============================================================================

class Create(Base):
    def test_creates_and_locks_bounty(self):
        r = self.d.create(bounty=5 * GEN)
        self.assertTrue(r["ok"])
        self.assertEqual(self.d.balance(), 5 * GEN)
        o = self.d.get(r["offer_id"])
        self.assertEqual(o["status"], "OPEN")
        self.assertEqual(o["bounty"], str(5 * GEN))
        self.assertEqual(o["protocol"], PROTOCOL)

    def test_offer_freezes_every_field(self):
        oid = self.d.offer(share=1500, rule="EXPLOITER_ONLY", meta=json.dumps({"case_no": 3}))
        o = self.d.get(oid)
        for k in ("start", "deadline", "bounty_share_bps", "payout_rule", "claim_window_s", "exploiters", "recoveries",
                  "tokens", "chains", "meta", "incident", "name"):
            self.assertIn(k, o)
        self.assertEqual(o["bounty_share_bps"], 1500)
        self.assertEqual(o["payout_rule"], "EXPLOITER_ONLY")
        self.assertEqual(o["meta"], {"case_no": 3})

    def test_ids_are_sequential(self):
        self.assertEqual([self.d.offer() for _ in range(3)], [1, 2, 3])

    def assert_refused(self, reason, **k):
        before = self.d.stats()
        r = self.d.create(**k)
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], reason)
        after = self.d.stats()
        self.assertEqual(before["offers"], after["offers"], "a refusal must not move the offer counter")
        self.assertEqual(int(after["credit_owed_total"]) - int(before["credit_owed_total"]), int(r["credited"]))
        return r

    def test_bounty_below_minimum(self):
        self.assert_refused("BOUNTY_BELOW_MINIMUM", bounty=10 ** 14)

    def test_zero_bounty(self):
        r = self.assert_refused("BOUNTY_BELOW_MINIMUM", bounty=0)
        self.assertEqual(r["credited"], "0")

    def test_name_required(self):
        self.assert_refused("NAME_REQUIRED", name="   ")

    def test_markup_stripped_from_name(self):
        oid = self.d.offer(name="<b>Hack</b> \"x\"")
        self.assertEqual(self.d.get(oid)["name"], "bHack/b x")

    def test_unsupported_chain(self):
        self.assert_refused("UNSUPPORTED_CHAIN", chains=("solana",))

    def test_chains_empty(self):
        self.assert_refused("CHAINS_EMPTY", chains=())

    def test_exploiters_empty(self):
        self.assert_refused("EXPLOITERS_EMPTY", exploiters="[]")

    def test_exploiter_bad_address(self):
        self.assert_refused("EXPLOITERS_BAD_ADDRESS", exploiters=pairs(("ethereum", "0x1234")))

    def test_exploiter_zero_address(self):
        self.assert_refused("EXPLOITERS_BAD_ADDRESS", exploiters=pairs(("ethereum", F.RG.ZERO)))

    def test_exploiter_chain_not_in_offer(self):
        self.assert_refused("EXPLOITERS_CHAIN_NOT_IN_OFFER", exploiters=pairs(("arbitrum", EXPLOITER)))

    def test_too_many_exploiters(self):
        self.assert_refused("EXPLOITERS_TOO_MANY", exploiters=pairs(*[("ethereum", F.addr(1000 + i)) for i in range(25)]))

    def test_exploiters_bad_json(self):
        self.assert_refused("EXPLOITERS_BAD_JSON", exploiters="{nope")

    def test_recoveries_empty(self):
        self.assert_refused("RECOVERIES_EMPTY", recoveries="[]")

    def test_recovery_is_exploiter(self):
        self.assert_refused("RECOVERY_IS_EXPLOITER", recoveries=pairs(("ethereum", EXPLOITER)))

    def test_recovery_is_exploiter_on_other_chain(self):
        self.assert_refused("RECOVERY_IS_EXPLOITER", chains=("ethereum", "arbitrum"),
                            exploiters=pairs(("ethereum", EXPLOITER)), recoveries=pairs(("arbitrum", EXPLOITER)))

    def test_tokens_empty(self):
        self.assert_refused("TOKENS_EMPTY", tokens="[]")

    def test_token_bad_address(self):
        self.assert_refused("TOKENS_BAD_TOKEN", tokens=json.dumps([tok(token="0xzz")]))

    def test_token_bad_decimals(self):
        self.assert_refused("TOKENS_BAD_DECIMALS", tokens=json.dumps([tok(decimals=19)]))

    def test_token_zero_stolen(self):
        self.assert_refused("TOKENS_BAD_STOLEN", tokens=json.dumps([tok(stolen=0)]))

    def test_token_zero_weight(self):
        self.assert_refused("TOKENS_BAD_WEIGHT", tokens=json.dumps([tok(weight=0)]))

    def test_token_duplicate(self):
        self.assert_refused("TOKENS_DUPLICATE_TOKEN", tokens=json.dumps([tok(), tok()]))

    def test_token_chain_not_in_offer(self):
        self.assert_refused("TOKENS_CHAIN_NOT_IN_OFFER", tokens=json.dumps([tok(chain="arbitrum")]))

    def test_too_many_tokens(self):
        self.assert_refused("TOKENS_TOO_MANY", tokens=json.dumps([tok(token=F.addr(2000 + i)) for i in range(13)]))

    def test_bad_share_zero(self):
        self.assert_refused("BAD_BOUNTY_SHARE", share=0)

    def test_bad_share_over_100(self):
        self.assert_refused("BAD_BOUNTY_SHARE", share=10001)

    def test_share_100_percent_allowed(self):
        self.assertTrue(self.d.create(share=10000)["ok"])

    def test_bad_window_deadline_before_start(self):
        self.assert_refused("BAD_WINDOW", start=DEADLINE, deadline=START)

    def test_bad_window_equal(self):
        self.assert_refused("BAD_WINDOW", start=START, deadline=START)

    def test_window_too_long(self):
        self.assert_refused("WINDOW_TOO_LONG", start=START, deadline=START + RG.MAX_SPAN_S + 1)

    def test_start_in_future(self):
        self.assert_refused("START_IN_FUTURE", start=NOW + 10, deadline=NOW + 1000)

    def test_bad_payout_rule(self):
        self.assert_refused("BAD_PAYOUT_RULE", rule="ANYONE")

    def test_meta_bad_json(self):
        self.assert_refused("META_BAD_JSON", meta="{x")

    def test_meta_not_object(self):
        self.assert_refused("META_NOT_OBJECT", meta="[1]")

    def test_meta_too_long(self):
        self.assert_refused("META_TOO_LONG", meta=json.dumps({"x": "a" * 900}))

    def test_refused_value_is_credited_and_withdrawable(self):
        r = self.d.create(bounty=3 * GEN, rule="NOPE")
        self.assertFalse(r["ok"])
        self.assertEqual(self.d.balance(), 3 * GEN)
        self.assertEqual(self.d.w.view(self.d.reg, "get_credit", PROTOCOL)["credit"], str(3 * GEN))
        w = self.d.w.call(self.d.reg, "withdraw_refund", sender=PROTOCOL)
        self.assertEqual(w["withdrawn"], str(3 * GEN))
        self.assertEqual(self.d.balance(), 0)
        self.assertEqual(self.d.sent_to(PROTOCOL), 3 * GEN)
        self.assertTrue(self.d.ledger_ok())

    def test_withdraw_nothing_refused(self):
        self.refused(self.d.w.call, self.d.reg, "withdraw_refund", sender=STRANGER, reason="NOTHING_TO_WITHDRAW")

    def test_withdraw_twice_refused(self):
        self.d.create(bounty=GEN, rule="NOPE")
        self.d.w.call(self.d.reg, "withdraw_refund", sender=PROTOCOL)
        self.refused(self.d.w.call, self.d.reg, "withdraw_refund", sender=PROTOCOL, reason="NOTHING_TO_WITHDRAW")

    def test_credits_accumulate_per_sender(self):
        self.d.create(bounty=GEN, rule="NOPE")
        self.d.create(bounty=2 * GEN, share=0)
        self.assertEqual(self.d.w.view(self.d.reg, "get_credit", PROTOCOL)["credit"], str(3 * GEN))

    def test_dedupes_addresses(self):
        oid = self.d.offer(exploiters=pairs(("ethereum", EXPLOITER), ("ethereum", EXPLOITER.upper()[0:2] + EXPLOITER[2:].upper())))
        self.assertEqual(len(self.d.get(oid)["exploiters"]), 1)

    def test_historic_offer_after_deadline_is_accepted(self):
        oid = self.d.offer(start=START, deadline=DEADLINE)
        o = self.d.get(oid)
        self.assertEqual(o["settle_at"], NOW + RG.MODES["DEMO"][1])

    def test_no_cancel_method(self):
        for name in ("cancel", "cancel_offer", "withdraw_bounty", "close", "set_owner", "pause"):
            self.assertFalse(hasattr(RG.WhiteFlagRegistry, name), name)


# =============================================================================
# 2. return proofs: the rule
# =============================================================================

class Proofs(Base):
    def setUp(self):
        super().setUp()
        self.oid = self.two_token_offer()

    def test_native_return_counts(self):
        r = self.d.prove(self.oid, "ethereum", self.native(5 * ETH))
        self.assertEqual(r["status"], "COUNTED")
        self.assertEqual(r["credits"][0]["amount"], str(5 * ETH))
        self.assertEqual(self.d.get(self.oid)["returned"], {"ethereum:native": str(5 * ETH)})

    def test_erc20_return_counts(self):
        r = self.d.prove(self.oid, "ethereum", self.erc20(7 * ETH))
        self.assertEqual(r["status"], "COUNTED")
        self.assertEqual(self.d.get(self.oid)["returned"], {"ethereum:" + TOKEN: str(7 * ETH)})

    def test_native_and_erc20_in_one_tx(self):
        h = self.c.tx("ethereum", EXPLOITER, RECOVERY, value=ETH, logs=[(TOKEN, EXPLOITER, RECOVERY, 2 * ETH)])
        r = self.d.prove(self.oid, "ethereum", h)
        self.assertEqual(len(r["credits"]), 2)

    def test_two_logs_in_one_tx(self):
        h = self.c.tx("ethereum", EXPLOITER, TOKEN, logs=[(TOKEN, EXPLOITER, RECOVERY, ETH), (TOKEN, EXPLOITER, RECOVERY, 2 * ETH)])
        r = self.d.prove(self.oid, "ethereum", h)
        self.assertEqual([c["log"] for c in r["credits"]], [0, 1])
        self.assertEqual(self.d.get(self.oid)["returned"]["ethereum:" + TOKEN], str(3 * ETH))

    def reject(self, h, reason, chain="ethereum", oid=None):
        r = self.d.prove(oid or self.oid, chain, h)
        self.assertEqual(r["status"], "REJECTED")
        self.assertEqual(r["reason"], reason)
        return r

    def test_failed_tx(self):
        self.reject(self.native(status=0), "TX_FAILED")

    def test_wrong_sender(self):
        self.reject(self.native(frm=STRANGER), "SENDER_NOT_EXPLOITER")

    def test_wrong_recipient(self):
        self.reject(self.native(to=STRANGER), "NO_RETURN_TO_RECOVERY")

    def test_recovery_from_non_exploiter_log(self):
        # tx sent by the exploiter, but the Transfer is from someone else
        h = self.c.tx("ethereum", EXPLOITER, TOKEN, logs=[(TOKEN, STRANGER, RECOVERY, ETH)])
        self.reject(h, "NO_RETURN_TO_RECOVERY")

    def test_unlisted_token(self):
        self.reject(self.erc20(token=F.addr(999)), "NO_RETURN_TO_RECOVERY")

    def test_lookalike_token(self):
        self.reject(self.erc20(token=LOOKALIKE), "NO_RETURN_TO_RECOVERY")

    def test_zero_value_native(self):
        self.reject(self.native(value=0), "NO_RETURN_TO_RECOVERY")

    def test_zero_amount_log(self):
        self.reject(self.erc20(amount=0), "NO_RETURN_TO_RECOVERY")

    def test_native_not_listed(self):
        oid = self.d.offer(tokens=json.dumps([tok(token=TOKEN, symbol="TKN")]))
        self.reject(self.native(), "NO_RETURN_TO_RECOVERY", oid=oid)

    def test_not_finalized(self):
        self.reject(self.native(block=F.FINALIZED["ethereum"] + 1), "NOT_FINALIZED")

    def test_block_equal_finalized_counts(self):
        self.assertEqual(self.d.prove(self.oid, "ethereum", self.native(block=F.FINALIZED["ethereum"]))["status"], "COUNTED")

    def test_finalized_is_the_lower_of_two_rpcs(self):
        urls = RG.CHAINS["ethereum"][1]

        def lower(req, ans):
            if req["method"] == "eth_getBlockByNumber" and req["params"][0] == "finalized":
                ans = json.loads(json.dumps(ans))
                ans["result"]["number"] = hex(F.FINALIZED["ethereum"] - 5)
            return ans
        stub.WEB.tamper[urls[1]] = lower
        self.reject(self.native(block=F.FINALIZED["ethereum"] - 2), "NOT_FINALIZED")

    def test_pending_tx(self):
        self.reject(self.native(pending=True), "TX_PENDING")

    def test_unknown_tx(self):
        self.reject(self.native(missing=True), "TX_NOT_FOUND")

    def test_block_time_equal_start_counts(self):
        self.assertEqual(self.d.prove(self.oid, "ethereum", self.native(ts=START))["status"], "COUNTED")

    def test_block_time_before_start(self):
        self.reject(self.native(ts=START - 1), "BEFORE_OFFER_START")

    def test_block_time_equal_deadline_counts(self):
        self.assertEqual(self.d.prove(self.oid, "ethereum", self.native(ts=DEADLINE))["status"], "COUNTED")

    def test_block_time_after_deadline(self):
        self.reject(self.native(ts=DEADLINE + 1), "AFTER_DEADLINE")

    def test_rpc_disagree_on_value(self):
        urls = RG.CHAINS["ethereum"][1]

        def lie(req, ans):
            if req["method"] == "eth_getTransactionByHash" and ans.get("result"):
                ans = json.loads(json.dumps(ans))
                ans["result"]["value"] = hex(10 ** 30)
            return ans
        stub.WEB.tamper[urls[0]] = lie
        self.reject(self.native(), "RPC_DISAGREE")

    def test_rpc_disagree_on_logs(self):
        urls = RG.CHAINS["ethereum"][1]

        def drop(req, ans):
            if req["method"] == "eth_getTransactionReceipt" and ans.get("result"):
                ans = json.loads(json.dumps(ans))
                ans["result"]["logs"] = []
            return ans
        stub.WEB.tamper[urls[1]] = drop
        self.reject(self.erc20(), "RPC_DISAGREE")

    def test_rpc_disagree_on_block_hash(self):
        urls = RG.CHAINS["ethereum"][1]

        def reorg(req, ans):
            if req["method"] == "eth_getTransactionReceipt" and ans.get("result"):
                ans = json.loads(json.dumps(ans))
                ans["result"]["blockHash"] = "0x" + "ab" * 32
            return ans
        stub.WEB.tamper[urls[1]] = reorg
        self.reject(self.native(), "RPC_DISAGREE")

    def test_one_rpc_does_not_know_the_tx(self):
        urls = RG.CHAINS["ethereum"][1]

        def forget(req, ans):
            if req["method"] in ("eth_getTransactionByHash", "eth_getTransactionReceipt"):
                return {"jsonrpc": "2.0", "id": ans["id"], "result": None}
            return ans
        stub.WEB.tamper[urls[1]] = forget
        self.reject(self.native(), "RPC_DISAGREE")

    def test_rpc_down(self):
        stub.WEB.down.add(RG.CHAINS["ethereum"][1][0])
        self.reject(self.native(), "RPC_UNREADABLE")

    def test_rpc_http_500(self):
        stub.WEB.rpc_status[RG.CHAINS["ethereum"][1][1]] = 500
        self.reject(self.native(), "RPC_UNREADABLE")

    def test_rpc_error_answer(self):
        self.c.c["ethereum"].fail = lambda m, p: {"code": -32000, "message": "boom"} if m == "eth_getTransactionReceipt" else None
        self.reject(self.native(), "RPC_UNREADABLE")

    def test_wrong_chain_id(self):
        self.c.c["ethereum"].chain_id = 5
        self.reject(self.native(), "WRONG_CHAIN_ID")

    def test_header_hash_mismatch_unreadable(self):
        urls = RG.CHAINS["ethereum"][1]

        def bad_header(req, ans):
            if req["method"] == "eth_getBlockByNumber" and req["params"][0] != "finalized" and ans.get("result"):
                ans = json.loads(json.dumps(ans))
                ans["result"]["hash"] = "0x" + "cd" * 32
            return ans
        stub.WEB.tamper[urls[0]] = bad_header
        stub.WEB.tamper[urls[1]] = bad_header
        self.reject(self.native(), "RPC_UNREADABLE")

    def test_rejected_proof_can_be_resubmitted(self):
        h = self.native()
        stub.WEB.down.add(RG.CHAINS["ethereum"][1][0])
        self.reject(h, "RPC_UNREADABLE")
        stub.WEB.down.clear()
        self.assertEqual(self.d.prove(self.oid, "ethereum", h)["status"], "COUNTED")

    def test_counted_tx_cannot_be_resubmitted(self):
        h = self.native()
        self.d.prove(self.oid, "ethereum", h)
        self.refused(self.d.prove, self.oid, "ethereum", h, reason="ALREADY_COUNTED")

    def test_same_log_counts_once_across_offers(self):
        oid2 = self.two_token_offer()
        h = self.erc20()
        self.d.prove(self.oid, "ethereum", h)
        self.reject(h, "ALREADY_COUNTED", oid=oid2)
        self.assertEqual(self.d.get(oid2)["returned"], {})

    def test_duplicate_item_in_batch(self):
        h = self.native()
        self.refused(self.d.submit, self.oid, [["ethereum", h], ["ethereum", h]], reason="DUPLICATE_ITEM")

    def test_batch_of_five(self):
        hs = [self.native(ETH) for _ in range(5)]
        r = self.d.submit(self.oid, [["ethereum", h] for h in hs])
        self.assertEqual([x["status"] for x in r["results"]], ["COUNTED"] * 5)
        self.assertEqual(self.d.get(self.oid)["n_counted"], 5)

    def test_batch_of_six_refused(self):
        hs = [self.native(ETH) for _ in range(6)]
        self.refused(self.d.submit, self.oid, [["ethereum", h] for h in hs], reason="TOO_MANY_ITEMS")

    def test_empty_batch_refused(self):
        self.refused(self.d.submit, self.oid, [], reason="NO_ITEMS")

    def test_mixed_batch_records_each(self):
        r = self.d.submit(self.oid, [["ethereum", self.native()], ["ethereum", self.native(frm=STRANGER)]])
        self.assertEqual([x["status"] for x in r["results"]], ["COUNTED", "REJECTED"])
        o = self.d.get(self.oid)
        self.assertEqual((o["n_proofs"], o["n_counted"], o["n_rejected"]), (2, 1, 1))

    def test_bad_hash(self):
        self.refused(self.d.submit, self.oid, [["ethereum", "0x1234"]], reason="BAD_HASH")

    def test_chain_not_in_offer(self):
        self.refused(self.d.submit, self.oid, [["arbitrum", self.native()]], reason="CHAIN_NOT_IN_OFFER")

    def test_no_such_offer(self):
        self.refused(self.d.submit, 99, [["ethereum", self.native()]], reason="NO_SUCH_OFFER")

    def test_proofs_refused_after_settlement(self):
        self.d.to_settle_time(self.oid)
        self.d.settle(self.oid)
        self.refused(self.d.submit, self.oid, [["ethereum", self.native()]], reason="OFFER_IS_SETTLED")

    def test_anyone_may_submit(self):
        for who in (STRANGER, EXPLOITER, PROTOCOL):
            self.assertEqual(self.d.prove(self.oid, "ethereum", self.native(ETH), sender=who)["status"], "COUNTED")

    def test_rate_limit(self):
        n = RG.MODES["DEMO"][2]
        for _ in range(n // 5):
            self.d.submit(self.oid, [["ethereum", self.native(1)] for _ in range(5)])
        msg = self.refused(self.d.submit, self.oid, [["ethereum", self.native(1)]], reason="RATE_LIMITED_UNTIL_")
        self.assertIn(str(NOW + RG.MODES["DEMO"][3]), msg)

    def test_rate_limit_is_per_sender(self):
        n = RG.MODES["DEMO"][2]
        for _ in range(n // 5):
            self.d.submit(self.oid, [["ethereum", self.native(1)] for _ in range(5)])
        self.assertEqual(self.d.prove(self.oid, "ethereum", self.native(1), sender=STRANGER)["status"], "COUNTED")

    def test_rate_limit_window_resets(self):
        n = RG.MODES["DEMO"][2]
        for _ in range(n // 5):
            self.d.submit(self.oid, [["ethereum", self.native(1)] for _ in range(5)])
        self.d.w.advance(RG.MODES["DEMO"][3])
        self.assertEqual(self.d.prove(self.oid, "ethereum", self.native(1))["status"], "COUNTED")

    def test_refused_submission_moves_no_counter(self):
        before = self.d.stats()
        self.refused(self.d.submit, self.oid, [["ethereum", "0x12"]])
        self.assertEqual(before, self.d.stats())

    def test_consensus_failure_commits_nothing(self):
        h = self.native()
        ch = self.c.c["ethereum"]

        def change():
            ch.txs[h]["tx"]["value"] = hex(ETH)        # validators see a different chain
        stub.WEB.validator_hook = change
        self.refused(self.d.prove, self.oid, "ethereum", h, reason="UNDETERMINED")
        stub.WEB.validator_hook = None
        self.assertEqual(self.d.get(self.oid)["n_proofs"], 0)

    def test_leader_lying_about_a_read_is_not_accepted(self):
        h = self.native(frm=STRANGER)

        def forge(res):
            res[0]["read"]["from"] = EXPLOITER
            return res
        stub.FORGE["mutate"] = forge
        try:
            self.refused(self.d.prove, self.oid, "ethereum", h, reason="UNDETERMINED")
        finally:
            stub.FORGE["mutate"] = None

    def test_both_unreadable_validators_agree_to_reject(self):
        h = self.native()
        stub.WEB.down.add("*")
        self.reject(h, "RPC_UNREADABLE")

    def test_arbitrum_erc20(self):
        oid = self.d.offer(chains=("arbitrum",), tokens=json.dumps([tok(chain="arbitrum", token=TOKEN_ARB, symbol="FRAX")]))
        r = self.d.prove(oid, "arbitrum", self.erc20(token=TOKEN_ARB, chain="arbitrum"))
        self.assertEqual(r["status"], "COUNTED")

    def test_cross_chain_addresses_are_per_chain(self):
        # EXPLOITER listed only on arbitrum: its ethereum tx does not count
        oid = self.d.offer(chains=("ethereum", "arbitrum"), exploiters=pairs(("arbitrum", EXPLOITER)),
                           recoveries=pairs(("ethereum", RECOVERY), ("arbitrum", RECOVERY)))
        self.reject(self.native(), "SENDER_NOT_EXPLOITER", oid=oid)

    def test_proof_records_block_and_parties(self):
        h = self.native()
        self.d.prove(self.oid, "ethereum", h)
        p = self.d.w.view(self.d.reg, "get_proofs", self.oid, 0, 10)["items"][0]
        self.assertEqual((p["from"], p["to"], p["tx_hash"]), (EXPLOITER, RECOVERY, h))
        self.assertGreater(p["block"], 0)
        self.assertGreater(p["block_time"], 0)

    def test_offer_status_unchanged_by_proofs(self):
        self.d.prove(self.oid, "ethereum", self.native(1000 * ETH))
        self.assertEqual(self.d.get(self.oid)["status"], "OPEN")


# =============================================================================
# 3. the returned fraction and owed bounty
# =============================================================================

class Fraction(Base):
    def frac(self, tokens, returned):
        return RG.fraction_parts(tokens, returned)

    def test_single_token_half(self):
        n, d = self.frac([tok(stolen=100)], {"ethereum:native": "50"})
        self.assertEqual(n * 2, d)

    def test_capped_at_stolen(self):
        n, d = self.frac([tok(stolen=100)], {"ethereum:native": "500"})
        self.assertEqual(n, d)

    def test_weights(self):
        toks = [tok(stolen=10, weight=300000), tok(token=TOKEN, stolen=1000, weight=100)]
        n, d = self.frac(toks, {"ethereum:" + TOKEN: "1000"})
        self.assertEqual((n, d), (1000 * 100, 10 * 300000 + 1000 * 100))

    def test_over_return_of_one_token_does_not_cover_another(self):
        toks = [tok(stolen=10, weight=1), tok(token=TOKEN, stolen=10, weight=1)]
        n, d = self.frac(toks, {"ethereum:native": "1000"})
        self.assertEqual(n * 2, d)

    def test_decimals_normalized(self):
        toks = [tok(stolen=10 * ETH, weight=1), tok(token=F.USDC6, stolen=10 * 10 ** 6, weight=1, decimals=6)]
        n, d = self.frac(toks, {"ethereum:" + F.USDC6: str(10 * 10 ** 6)})
        self.assertEqual(n * 2, d)

    def test_nothing_returned(self):
        self.assertEqual(self.frac([tok()], {})[0], 0)

    def test_unlisted_key_ignored(self):
        self.assertEqual(self.frac([tok()], {"ethereum:" + TOKEN: "100"})[0], 0)

    def test_huge_amounts_exact(self):
        big = 10 ** 39
        n, d = self.frac([tok(stolen=big, weight=10 ** 18)], {"ethereum:native": str(big - 1)})
        self.assertEqual(d - n, 10 ** 18)

    def owed_after(self, stolen, returned, bounty, weight=1):
        oid = self.d.offer(bounty=bounty, tokens=json.dumps([tok(stolen=stolen, weight=weight)]))
        if returned:
            self.d.prove(oid, "ethereum", self.native(returned))
        self.d.to_settle_time(oid)
        r = self.d.settle(oid)
        return r, oid

    def test_owed_rounds_down(self):
        r, _ = self.owed_after(3, 1, 10 ** 15 + 1)
        self.assertEqual(int(r["owed"]), (10 ** 15 + 1) // 3)
        self.assertEqual(int(r["owed"]) + int(r["refunded"]), 10 ** 15 + 1)

    def test_owed_plus_refund_is_bounty(self):
        for stolen, ret in ((7, 3), (1000, 999), (10 ** 21, 1), (13, 12)):
            d = F.Deployment()
            self.d = d
            self.c = d.chains
            r, _ = self.owed_after(stolen, ret, 10 ** 18 + 7)
            self.assertEqual(int(r["owed"]) + int(r["refunded"]), 10 ** 18 + 7, (stolen, ret))

    def test_fraction_ppm_reported(self):
        r, oid = self.owed_after(100 * ETH, 25 * ETH, GEN)
        self.assertEqual(r["fraction_ppm"], 250000)
        self.assertEqual(self.d.get(oid)["fraction_ppm"], 250000)

    def test_tiny_fraction_is_partial_not_none(self):
        r, _ = self.owed_after(10 ** 24, 1, GEN)
        self.assertEqual(r["status"], "SETTLED_PARTIAL")
        self.assertEqual(r["owed"], "0") if 10 ** 18 * 1 // 10 ** 24 == 0 else None

    def test_weights_change_owed(self):
        toks = json.dumps([tok(stolen=10 * ETH, weight=3000), tok(token=TOKEN, stolen=10 * ETH, weight=1000, symbol="T")])
        oid = self.d.offer(bounty=4 * GEN, tokens=toks)
        self.d.prove(oid, "ethereum", self.native(10 * ETH))
        self.d.to_settle_time(oid)
        self.assertEqual(self.d.settle(oid)["owed"], str(3 * GEN))


# =============================================================================
# 4. settlement
# =============================================================================

class Settle(Base):
    def test_too_early(self):
        oid = self.d.offer(deadline=NOW + 1000)
        msg = self.refused(self.d.settle, oid, reason="TOO_EARLY_UNTIL_")
        self.assertIn(str(NOW + 1000), msg)

    def test_exactly_at_deadline(self):
        oid = self.d.offer(deadline=NOW + 1000)
        self.d.w.set_time(NOW + 999)
        self.refused(self.d.settle, oid, reason="TOO_EARLY")
        self.d.w.set_time(NOW + 1000)
        self.assertEqual(self.d.settle(oid)["status"], "SETTLED_NONE")

    def test_historic_offer_waits_min_open(self):
        oid = self.d.offer()
        self.refused(self.d.settle, oid, reason="TOO_EARLY")
        self.d.w.advance(RG.MODES["DEMO"][1])
        self.assertTrue(self.d.settle(oid)["ok"])

    def test_canonical_min_open_is_three_hours(self):
        d = F.Deployment("CANONICAL")
        oid = d.offer()
        self.assertEqual(d.get(oid)["settle_at"], NOW + 3 * 3600)

    def test_early_settle_at_100(self):
        oid = self.d.offer(deadline=NOW + 10 ** 6, tokens=json.dumps([tok(stolen=10 * ETH)]))
        self.d.prove(oid, "ethereum", self.native(10 * ETH))
        r = self.d.settle(oid)
        self.assertEqual(r["status"], "SETTLED_FULL")
        self.assertEqual(r["refunded"], "0")

    def test_no_early_settle_at_99(self):
        oid = self.d.offer(deadline=NOW + 10 ** 6, tokens=json.dumps([tok(stolen=10 * ETH)]))
        self.d.prove(oid, "ethereum", self.native(10 * ETH - 1))
        self.refused(self.d.settle, oid, reason="TOO_EARLY")

    def test_none_refunds_everything(self):
        oid = self.d.offer(bounty=7 * GEN)
        self.d.to_settle_time(oid)
        r = self.d.settle(oid)
        self.assertEqual((r["status"], r["owed"], r["refunded"]), ("SETTLED_NONE", "0", str(7 * GEN)))
        self.assertEqual(self.d.sent_to(PROTOCOL), 7 * GEN)
        self.assertEqual(self.d.balance(), 0)
        self.assertEqual(self.d.get(oid)["claim_deadline"], 0)

    def test_partial_refunds_remainder_now(self):
        oid = self.d.offer(bounty=10 * GEN, tokens=json.dumps([tok(stolen=10 * ETH)]))
        self.d.prove(oid, "ethereum", self.native(4 * ETH))
        self.d.to_settle_time(oid)
        r = self.d.settle(oid)
        self.assertEqual((r["status"], r["owed"], r["refunded"]), ("SETTLED_PARTIAL", str(4 * GEN), str(6 * GEN)))
        self.assertEqual(self.d.sent_to(PROTOCOL), 6 * GEN)
        self.assertEqual(self.d.balance(), 4 * GEN)

    def test_full_after_deadline(self):
        oid = self.d.offer(tokens=json.dumps([tok(stolen=10 * ETH)]))
        self.d.prove(oid, "ethereum", self.native(11 * ETH))
        r = self.d.settle(oid)
        self.assertEqual(r["status"], "SETTLED_FULL")

    def test_claim_deadline_set(self):
        oid = self.d.offer(tokens=json.dumps([tok(stolen=10 * ETH)]))
        self.d.prove(oid, "ethereum", self.native(5 * ETH))
        self.d.to_settle_time(oid)
        r = self.d.settle(oid)
        self.assertEqual(r["claim_deadline"], self.d.w.now() + RG.MODES["DEMO"][0])

    def test_canonical_claim_window_one_hour(self):
        self.assertEqual(RG.MODES["CANONICAL"][0], 3600)

    def test_settle_twice_refused(self):
        oid = self.d.offer()
        self.d.to_settle_time(oid)
        self.d.settle(oid)
        self.refused(self.d.settle, oid, reason="ALREADY_SETTLED_NONE")

    def test_anyone_settles(self):
        oid = self.d.offer()
        self.d.to_settle_time(oid)
        self.assertEqual(self.d.settle(oid, sender=STRANGER)["status"], "SETTLED_NONE")
        self.assertEqual(self.d.get(oid)["settled_by"], STRANGER)

    def test_no_such_offer(self):
        self.refused(self.d.settle, 5, reason="NO_SUCH_OFFER")

    def test_settle_reads_nothing_external(self):
        oid = self.d.offer()
        self.d.to_settle_time(oid)
        stub.WEB.down.add("*")
        self.assertTrue(self.d.settle(oid)["ok"])

    def test_extended_deadline_delays_settle(self):
        oid = self.d.offer(deadline=NOW + 100)
        self.d.w.call(self.d.reg, "extend_deadline", oid, NOW + 500, sender=PROTOCOL)
        self.d.w.set_time(NOW + 200)
        self.refused(self.d.settle, oid, reason="TOO_EARLY_UNTIL_" + str(NOW + 500))


# =============================================================================
# 5. claim and refunds
# =============================================================================

class Claim(Base):
    def settled(self, ret=5 * ETH, rule="EXPLOITER_OR_NAMED", bounty=10 * GEN, exploiters=None):
        oid = self.d.offer(bounty=bounty, tokens=json.dumps([tok(stolen=10 * ETH)]), rule=rule,
                           exploiters=exploiters or pairs(("ethereum", EXPLOITER), ("ethereum", EXPLOITER2)))
        if ret:
            self.d.prove(oid, "ethereum", self.native(ret))
        self.d.to_settle_time(oid)
        self.d.settle(oid)
        return oid

    def test_exploiter_claims_to_self(self):
        oid = self.settled()
        r = self.d.claim(oid)
        self.assertEqual((r["paid"], r["to"]), (str(5 * GEN), EXPLOITER))
        self.assertEqual(self.d.sent_to(EXPLOITER), 5 * GEN)
        self.assertEqual(self.d.balance(), 0)

    def test_claim_to_named_payout_address(self):
        oid = self.settled()
        r = self.d.claim(oid, PAYEE)
        self.assertEqual(r["to"], PAYEE)
        self.assertEqual(self.d.sent_to(PAYEE), 5 * GEN)
        o = self.d.get(oid)
        self.assertEqual((o["claimed_by"], o["paid_to"]), (EXPLOITER, PAYEE))

    def test_second_exploiter_address_may_claim(self):
        oid = self.settled()
        self.assertEqual(self.d.claim(oid, sender=EXPLOITER2)["to"], EXPLOITER2)

    def test_non_exploiter_refused(self):
        oid = self.settled()
        self.refused(self.d.claim, oid, sender=STRANGER, reason="NOT_AN_EXPLOITER_ADDRESS")

    def test_protocol_cannot_claim(self):
        oid = self.settled()
        self.refused(self.d.claim, oid, sender=PROTOCOL, reason="NOT_AN_EXPLOITER_ADDRESS")

    def test_recovery_address_cannot_claim(self):
        oid = self.settled()
        self.refused(self.d.claim, oid, sender=RECOVERY, reason="NOT_AN_EXPLOITER_ADDRESS")

    def test_named_payout_refused_under_exploiter_only(self):
        oid = self.settled(rule="EXPLOITER_ONLY")
        self.refused(self.d.claim, oid, PAYEE, reason="PAYOUT_RULE_IS_EXPLOITER_ONLY")

    def test_self_named_allowed_under_exploiter_only(self):
        oid = self.settled(rule="EXPLOITER_ONLY")
        self.assertEqual(self.d.claim(oid, EXPLOITER)["to"], EXPLOITER)

    def test_bad_payout_address(self):
        oid = self.settled()
        self.refused(self.d.claim, oid, "0xnope", reason="BAD_PAYOUT_ADDRESS")

    def test_zero_payout_address(self):
        oid = self.settled()
        self.refused(self.d.claim, oid, RG.ZERO, reason="BAD_PAYOUT_ADDRESS")

    def test_claim_before_settle(self):
        oid = self.d.offer()
        self.refused(self.d.claim, oid, reason="NOT_SETTLED")

    def test_claim_on_none(self):
        oid = self.settled(ret=0)
        self.refused(self.d.claim, oid, reason="NOTHING_OWED")

    def test_claim_twice(self):
        oid = self.settled()
        self.d.claim(oid)
        self.refused(self.d.claim, oid, sender=EXPLOITER2, reason="ALREADY_CLAIMED")

    def test_claim_at_window_end_allowed(self):
        oid = self.settled()
        self.d.w.set_time(self.d.get(oid)["claim_deadline"])
        self.assertTrue(self.d.claim(oid)["ok"])

    def test_claim_after_window_refused(self):
        oid = self.settled()
        self.d.w.set_time(self.d.get(oid)["claim_deadline"] + 1)
        self.refused(self.d.claim, oid, reason="CLAIM_WINDOW_CLOSED")

    def test_refund_before_window_refused(self):
        oid = self.settled()
        self.refused(self.d.refund, oid, reason="CLAIM_WINDOW_OPEN_UNTIL_")

    def test_refund_at_window_end_refused(self):
        oid = self.settled()
        self.d.w.set_time(self.d.get(oid)["claim_deadline"])
        self.refused(self.d.refund, oid, reason="CLAIM_WINDOW_OPEN")

    def test_refund_after_window(self):
        oid = self.settled()
        self.d.w.set_time(self.d.get(oid)["claim_deadline"] + 1)
        r = self.d.refund(oid, sender=STRANGER)
        self.assertEqual((r["refunded"], r["to"]), (str(5 * GEN), PROTOCOL))
        self.assertEqual(self.d.sent_to(PROTOCOL), 10 * GEN)
        self.assertEqual(self.d.balance(), 0)

    def test_claim_after_refund_refused(self):
        oid = self.settled()
        self.d.w.set_time(self.d.get(oid)["claim_deadline"] + 1)
        self.d.refund(oid)
        self.refused(self.d.claim, oid, reason="ALREADY_REFUNDED")

    def test_refund_after_claim_refused(self):
        oid = self.settled()
        self.d.claim(oid)
        self.d.w.set_time(self.d.get(oid)["claim_deadline"] + 1)
        self.refused(self.d.refund, oid, reason="ALREADY_CLAIMED")

    def test_refund_twice_refused(self):
        oid = self.settled()
        self.d.w.set_time(self.d.get(oid)["claim_deadline"] + 1)
        self.d.refund(oid)
        self.refused(self.d.refund, oid, reason="ALREADY_REFUNDED")

    def test_refund_on_none_refused(self):
        oid = self.settled(ret=0)
        self.d.w.advance(10 ** 6)
        self.refused(self.d.refund, oid, reason="NOTHING_OWED")

    def test_refund_on_open_refused(self):
        oid = self.d.offer()
        self.refused(self.d.refund, oid, reason="NOT_SETTLED")

    def test_full_claim_pays_whole_bounty(self):
        oid = self.settled(ret=10 * ETH)
        self.assertEqual(self.d.claim(oid)["paid"], str(10 * GEN))

    def test_claim_marks_before_send(self):
        oid = self.settled()
        self.d.claim(oid)
        o = self.d.get(oid)
        self.assertEqual(o["claimed"], str(5 * GEN))
        self.assertGreater(o["claimed_at"], 0)


# =============================================================================
# 6. the protocol's only two powers
# =============================================================================

class Protocol(Base):
    def test_extend_deadline(self):
        oid = self.d.offer()
        r = self.d.w.call(self.d.reg, "extend_deadline", oid, DEADLINE + 100, sender=PROTOCOL)
        self.assertEqual(r["deadline"], DEADLINE + 100)
        o = self.d.get(oid)
        self.assertEqual((o["deadline"], o["original_deadline"]), (DEADLINE + 100, DEADLINE))
        self.assertEqual(o["history"][0]["what"], "deadline")

    def test_extend_counts_later_returns(self):
        oid = self.d.offer()
        h = self.native(ts=DEADLINE + 50)
        self.assertEqual(self.d.prove(oid, "ethereum", h)["reason"], "AFTER_DEADLINE")
        self.d.w.call(self.d.reg, "extend_deadline", oid, DEADLINE + 100, sender=PROTOCOL)
        self.assertEqual(self.d.prove(oid, "ethereum", h)["status"], "COUNTED")

    def test_extend_only_later(self):
        oid = self.d.offer()
        self.refused(self.d.w.call, self.d.reg, "extend_deadline", oid, DEADLINE, sender=PROTOCOL, reason="ONLY_MOVE_LATER")

    def test_extend_only_protocol(self):
        oid = self.d.offer()
        self.refused(self.d.w.call, self.d.reg, "extend_deadline", oid, DEADLINE + 1, sender=STRANGER, reason="ONLY_THE_PROTOCOL")

    def test_extend_cap(self):
        oid = self.d.offer()
        self.refused(self.d.w.call, self.d.reg, "extend_deadline", oid, DEADLINE + RG.MAX_EXTEND_S + 1, sender=PROTOCOL,
                     reason="WINDOW_TOO_LONG")

    def test_extend_after_settle_refused(self):
        oid = self.d.offer()
        self.d.to_settle_time(oid)
        self.d.settle(oid)
        self.refused(self.d.w.call, self.d.reg, "extend_deadline", oid, DEADLINE + 100, sender=PROTOCOL, reason="OFFER_IS_SETTLED")

    def test_add_recovery(self):
        oid = self.d.offer()
        h = self.native(to=RECOVERY2)
        self.assertEqual(self.d.prove(oid, "ethereum", h)["reason"], "NO_RETURN_TO_RECOVERY")
        self.d.w.call(self.d.reg, "add_recovery", oid, "ethereum", RECOVERY2, sender=PROTOCOL)
        self.assertEqual(self.d.prove(oid, "ethereum", h)["status"], "COUNTED")
        self.assertEqual(self.d.get(oid)["history"][-1]["what"], "recovery")

    def test_add_recovery_not_exploiter(self):
        oid = self.d.offer()
        self.refused(self.d.w.call, self.d.reg, "add_recovery", oid, "ethereum", EXPLOITER, sender=PROTOCOL,
                     reason="RECOVERY_IS_EXPLOITER")

    def test_add_recovery_only_protocol(self):
        oid = self.d.offer()
        self.refused(self.d.w.call, self.d.reg, "add_recovery", oid, "ethereum", RECOVERY2, sender=EXPLOITER,
                     reason="ONLY_THE_PROTOCOL")

    def test_add_recovery_duplicate(self):
        oid = self.d.offer()
        self.refused(self.d.w.call, self.d.reg, "add_recovery", oid, "ethereum", RECOVERY, sender=PROTOCOL,
                     reason="ALREADY_A_RECOVERY_ADDRESS")

    def test_add_recovery_chain_not_in_offer(self):
        oid = self.d.offer()
        self.refused(self.d.w.call, self.d.reg, "add_recovery", oid, "arbitrum", RECOVERY2, sender=PROTOCOL,
                     reason="CHAIN_NOT_IN_OFFER")

    def test_add_recovery_bad_address(self):
        oid = self.d.offer()
        self.refused(self.d.w.call, self.d.reg, "add_recovery", oid, "ethereum", "0x00", sender=PROTOCOL, reason="BAD_ADDRESS")

    def test_add_recovery_cap(self):
        oid = self.d.offer()
        for i in range(RG.MAX_RECOVERIES - 1):
            self.d.w.call(self.d.reg, "add_recovery", oid, "ethereum", F.addr(5000 + i), sender=PROTOCOL)
        self.refused(self.d.w.call, self.d.reg, "add_recovery", oid, "ethereum", F.addr(6000), sender=PROTOCOL, reason="TOO_MANY")

    def test_protocol_cannot_change_tokens_or_exploiters(self):
        for name in ("set_tokens", "add_exploiter", "remove_exploiter", "remove_recovery", "set_weight", "set_bounty"):
            self.assertFalse(hasattr(RG.WhiteFlagRegistry, name), name)


# =============================================================================
# 7. fund conservation
# =============================================================================

class Conservation(Base):
    def run_scenario(self, seed):
        import random
        rnd = random.Random(seed)
        oids = []
        for i in range(6):
            bounty = rnd.randint(10 ** 15, 10 ** 19)
            stolen = rnd.randint(1, 10 ** 21)
            oid = self.d.offer(bounty=bounty, tokens=json.dumps([tok(stolen=stolen)]), deadline=NOW + rnd.randint(0, 500) if rnd.random() < 0.5 else DEADLINE)
            oids.append((oid, stolen))
            if rnd.random() < 0.3:
                self.d.create(bounty=rnd.randint(1, 10 ** 18), rule="BAD")
        for oid, stolen in oids:
            for _ in range(rnd.randint(0, 3)):
                amt = rnd.randint(1, stolen)
                h = self.native(amt, ts=START + rnd.randint(0, DEADLINE - START)) if rnd.random() < 0.8 else self.native(amt, frm=STRANGER)
                try:
                    self.d.prove(oid, "ethereum", h)
                except Reverted:
                    pass
        self.d.w.advance(10 ** 4)
        for oid, _ in oids:
            self.d.settle(oid)
        for oid, _ in oids:
            o = self.d.get(oid)
            if int(o["owed"]) > 0 and rnd.random() < 0.5:
                self.d.claim(oid, PAYEE if rnd.random() < 0.5 else "")
        self.d.w.advance(10 ** 4)
        for oid, _ in oids:
            o = self.d.get(oid)
            if int(o["owed"]) > 0 and o["claimed"] == "0":
                self.d.refund(oid)
        if int(self.d.stats()["credit_owed_total"]) > 0:
            self.d.w.call(self.d.reg, "withdraw_refund", sender=PROTOCOL)
        s = self.d.stats()
        self.assertTrue(self.d.ledger_ok(), s)
        self.assertEqual(self.d.balance(), 0, s)
        total_out = sum(a for (_, _, a) in self.d.w.transfers)
        self.assertEqual(total_out, int(s["received_total"]))
        for oid, _ in oids:
            o = self.d.get(oid)
            self.assertEqual(int(o["claimed"]) + int(o["unclaimed_refunded"]) + int(o["refunded_at_settle"]), int(o["bounty"]))


for _seed in range(20):
    setattr(Conservation, "test_sum_in_equals_sum_out_seed_%02d" % _seed, lambda self, s=_seed: self.run_scenario(s))


class Ledger(Base):
    def test_ledger_after_each_step(self):
        oid = self.d.offer(tokens=json.dumps([tok(stolen=10 * ETH)]))
        self.assertTrue(self.d.ledger_ok())
        self.d.prove(oid, "ethereum", self.native(3 * ETH))
        self.assertTrue(self.d.ledger_ok())
        self.d.to_settle_time(oid)
        self.d.settle(oid)
        self.assertTrue(self.d.ledger_ok())
        self.d.claim(oid)
        self.assertTrue(self.d.ledger_ok())
        s = self.d.stats()
        self.assertEqual((s["open_total"], s["owed_total"]), ("0", "0"))

    def test_held_matches_balance(self):
        self.d.offer(bounty=2 * GEN)
        self.d.offer(bounty=3 * GEN)
        self.assertEqual(int(self.d.stats()["held"]), self.d.balance())


# =============================================================================
# 8. stray value
# =============================================================================

class Stray(Base):
    def test_sweep_stray(self):
        oid = self.d.offer(bounty=GEN)
        self.d.w.instances[self.d.reg].balance += 5     # value the runtime kept from a failing call
        r = self.d.w.call(self.d.reg, "sweep_stray", sender=STRANGER)
        self.assertEqual((r["swept"], r["to"]), ("5", F.DEPLOYER))
        self.assertEqual(self.d.balance(), GEN)
        self.assertEqual(self.d.get(oid)["bounty"], str(GEN))

    def test_no_stray(self):
        self.d.offer(bounty=GEN)
        self.refused(self.d.w.call, self.d.reg, "sweep_stray", reason="NO_STRAY_BALANCE")

    def test_sweep_waits_after_a_send(self):
        oid = self.d.offer(bounty=GEN)
        self.d.to_settle_time(oid)
        self.d.settle(oid)
        self.d.w.instances[self.d.reg].balance += GEN  # as if the refund were not yet applied
        self.refused(self.d.w.call, self.d.reg, "sweep_stray", reason="SENDS_MAY_BE_PENDING_UNTIL_")
        self.d.w.advance(RG.MODES["DEMO"][4])
        self.assertEqual(self.d.w.call(self.d.reg, "sweep_stray")["swept"], str(GEN))

    def test_canonical_sweep_delay_two_days(self):
        self.assertEqual(RG.MODES["CANONICAL"][4], 2 * 86400)


# =============================================================================
# 9. views and pagination
# =============================================================================

class Views(Base):
    def test_get_offers_pages(self):
        for _ in range(7):
            self.d.offer()
        p1 = self.d.w.view(self.d.reg, "get_offers", 0, 3)
        self.assertEqual(([o["offer_id"] for o in p1["items"]], p1["next_offset"], p1["total"]), ([1, 2, 3], 3, 7))
        p3 = self.d.w.view(self.d.reg, "get_offers", 6, 3)
        self.assertEqual(([o["offer_id"] for o in p3["items"]], p3["next_offset"]), ([7], -1))

    def test_limit_capped(self):
        for _ in range(3):
            self.d.offer()
        self.assertEqual(self.d.w.view(self.d.reg, "get_offers", 0, 10 ** 6)["limit"], RG.PAGE_MAX)

    def test_negative_offset(self):
        self.d.offer()
        self.assertEqual(self.d.w.view(self.d.reg, "get_offers", -5, 2)["offset"], 0)

    def test_summary_has_bot_fields(self):
        self.d.offer()
        o = self.d.w.view(self.d.reg, "get_offers", 0, 1)["items"][0]
        for k in ("deadline", "settle_at", "claim_deadline", "status", "owed", "claimed", "unclaimed_refunded", "fraction_ppm"):
            self.assertIn(k, o)

    def test_get_due_settle(self):
        a = self.d.offer()
        self.d.offer(deadline=NOW + 10 ** 6)
        due = self.d.w.view(self.d.reg, "get_due", NOW + 61, 0, 10)
        self.assertEqual([(x["offer_id"], x["due"]) for x in due["items"]], [(a, "SETTLE")])

    def test_get_due_refund(self):
        oid = self.d.offer(tokens=json.dumps([tok(stolen=10 * ETH)]))
        self.d.prove(oid, "ethereum", self.native(5 * ETH))
        self.d.to_settle_time(oid)
        self.d.settle(oid)
        cd = self.d.get(oid)["claim_deadline"]
        self.assertEqual(self.d.w.view(self.d.reg, "get_due", cd, 0, 10)["items"], [])
        self.assertEqual(self.d.w.view(self.d.reg, "get_due", cd + 1, 0, 10)["items"][0]["due"], "REFUND_UNCLAIMED")

    def test_get_due_full_is_due_early(self):
        oid = self.d.offer(deadline=NOW + 10 ** 6, tokens=json.dumps([tok(stolen=ETH)]))
        self.d.prove(oid, "ethereum", self.native(ETH))
        self.assertEqual(self.d.w.view(self.d.reg, "get_due", NOW, 0, 10)["items"][0]["due"], "SETTLE")

    def test_get_due_pages_scan(self):
        for _ in range(5):
            self.d.offer()
        p = self.d.w.view(self.d.reg, "get_due", NOW + 100, 0, 2)
        self.assertEqual((p["scanned"], p["next_offset"], len(p["items"])), (2, 2, 2))

    def test_get_proofs_pages(self):
        oid = self.d.offer()
        for _ in range(4):
            self.d.prove(oid, "ethereum", self.native(1))
        p = self.d.w.view(self.d.reg, "get_proofs", oid, 1, 2)
        self.assertEqual(([x["proof_id"] for x in p["items"]], p["next_offset"]), ([2, 3], 3))

    def test_get_proofs_unknown_offer(self):
        self.assertFalse(self.d.w.view(self.d.reg, "get_proofs", 9, 0, 5)["found"])

    def test_get_offer_missing(self):
        self.assertEqual(self.d.get(42), {"found": False, "offer_id": 42})

    def test_get_proof(self):
        oid = self.d.offer()
        self.d.prove(oid, "ethereum", self.native(1))
        self.assertTrue(self.d.w.view(self.d.reg, "get_proof", 1)["found"])
        self.assertFalse(self.d.w.view(self.d.reg, "get_proof", 2)["found"])

    def test_config(self):
        c = self.d.w.view(self.d.reg, "get_config")
        self.assertEqual((c["mode"], c["claim_window_s"], c["contract"]), ("DEMO", 180, "WhiteFlagRegistry"))
        self.assertEqual(set(c["chains"]), {"ethereum", "arbitrum"})

    def test_stats_counts_reasons(self):
        oid = self.d.offer()
        self.d.prove(oid, "ethereum", self.native(frm=STRANGER))
        self.assertEqual(self.d.stats()["counts"]["reject:SENDER_NOT_EXPLOITER"], 1)

    def test_bad_mode(self):
        w = world.new_world(now_iso=F.NOW_ISO)
        with self.assertRaises(Exception):
            w.deploy("WhiteFlagRegistry", "TEST")


if __name__ == "__main__":
    unittest.main()
