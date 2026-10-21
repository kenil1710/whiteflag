"""Direct Mode: the registry's nondeterministic block under validator
disagreement and nondeterministic RPC failures. The leader's run happens in
the contract call; `direct_vm.run_validator()` then re-runs the captured
validator against whatever the RPCs answer at that moment."""
import json

from conftest import ETH_URLS, GEN, NOW


def prove(w, oid, h, chain="ethereum", who=None):
    return w.as_(who or w.stranger).submit_proofs(oid, json.dumps([[chain, h]]))["results"][0]


def test_honest_validator_agrees(w):
    oid = w.offer()
    r = prove(w, oid, w.rpc.eth.tx(w.exploiter, w.recovery, value=4 * GEN))
    assert r["status"] == "COUNTED"
    assert w.vm.run_validator() is True


def test_validator_disagrees_when_its_rpcs_answer_a_different_value(w):
    oid = w.offer()
    h = w.rpc.eth.tx(w.exploiter, w.recovery, value=4 * GEN)
    assert prove(w, oid, h)["status"] == "COUNTED"
    w.rpc.eth.txs[h]["tx"]["value"] = hex(9 * GEN)        # the validator's reads see another amount
    assert w.vm.run_validator() is False


def test_validator_rejects_a_leader_that_invents_a_return(w):
    oid = w.offer()
    h = w.rpc.eth.tx(w.exploiter, w.recovery, value=GEN)
    prove(w, oid, h)
    forged = [{"read": {"status": 1, "block": 1, "block_hash": "0x" + "1" * 64, "time": NOW - 10, "from": w.exploiter,
                        "to": w.recovery, "value": str(10 * GEN), "logs": []}, "final": True}]
    assert w.vm.run_validator(leader_result=forged) is False


def test_validator_rejects_a_leader_that_hides_a_return_behind_a_transient_failure(w):
    oid = w.offer()
    h = w.rpc.eth.tx(w.exploiter, w.recovery, value=GEN)
    prove(w, oid, h)
    assert w.vm.run_validator(leader_result=[{"reason": "RPC_UNREADABLE", "detail": "x"}]) is False


def test_validator_rejects_a_leader_error_and_a_malformed_answer(w):
    oid = w.offer()
    prove(w, oid, w.rpc.eth.tx(w.exploiter, w.recovery, value=GEN))
    assert w.vm.run_validator(leader_error=Exception("boom")) is False
    assert w.vm.run_validator(leader_result="not a list") is False
    assert w.vm.run_validator(leader_result=[]) is False


def test_one_rpc_down_is_pending_and_validators_agree_on_transient_failures(w):
    oid = w.offer()
    h = w.rpc.eth.tx(w.exploiter, w.recovery, value=GEN)
    w.rpc.down.add(ETH_URLS[0])
    r = prove(w, oid, h)
    assert (r["status"], r["reason"]) == ("PENDING", "RPC_UNREADABLE")
    # the validator sees the other endpoint fail instead: still transient, still agreement
    w.rpc.down.clear()
    w.rpc.down.add(ETH_URLS[1])
    assert w.vm.run_validator() is True
    # the validator sees a disagreement between the two RPCs: transient too
    w.rpc.down.clear()
    w.rpc.tamper[ETH_URLS[0]] = lambda req, ans: ({**ans, "result": {**ans["result"], "value": "0x1"}}
                                                  if req["method"] == "eth_getTransactionByHash" else ans)
    assert w.vm.run_validator() is True


def test_transient_leader_but_validator_reads_fine_disagrees(w):
    """A leader may not turn a readable return into PENDING: validators that can read it refuse."""
    oid = w.offer()
    h = w.rpc.eth.tx(w.exploiter, w.recovery, value=GEN)
    w.rpc.down.add(ETH_URLS[0])
    assert prove(w, oid, h)["status"] == "PENDING"
    w.rpc.down.clear()
    assert w.vm.run_validator() is False


def test_permanent_and_transient_reasons_never_agree(w):
    oid = w.offer()
    junk = "0x" + "ab" * 32
    r = prove(w, oid, junk)
    assert (r["status"], r["reason"]) == ("REJECTED", "TX_NOT_FOUND")
    assert w.vm.run_validator() is True
    w.rpc.down.add(ETH_URLS[0])
    assert w.vm.run_validator() is False                  # validator: transient, leader: permanent


def test_finality_moving_between_leader_and_validator(w):
    oid = w.offer()
    eth = w.rpc.eth
    h = eth.tx(w.exploiter, w.recovery, value=GEN, block=eth.finalized + 3)
    r = prove(w, oid, h)
    assert (r["status"], r["reason"]) == ("PENDING", "NOT_FINALIZED")
    eth.finalized += 10                                    # the block finalizes before the validator reads
    assert w.vm.run_validator() is False                  # a PENDING read against a counted one: no agreement
    assert w.as_(w.stranger).retry_proofs(oid, json.dumps([r["proof_id"]]))["results"][0]["status"] == "COUNTED"
    assert w.vm.run_validator() is True


def test_rate_limited_endpoint_is_retried_inside_the_read(w):
    oid = w.offer()
    h = w.rpc.eth.tx(w.exploiter, w.recovery, value=GEN)
    calls = {"n": 0}
    real = w.rpc.__call__

    def flaky(data):
        if data.get("url") == ETH_URLS[1] and calls["n"] < 2:
            calls["n"] += 1
            return {"ok": {"response": {"status": 429, "headers": {}, "body": b"slow down"}}}
        return real(data)
    w.vm._live_web_handler = flaky
    assert prove(w, oid, h)["status"] == "COUNTED"
    assert calls["n"] == 2
