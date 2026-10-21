"""Direct Mode: the steward's four rule changes on the real contracts.
Claim fairness, evidence recovery, the protocol-bound gate with copied
incidents, and the amendment lock near settlement."""
import json


from conftest import ETH_URLS, GEN, NOW


def prove(w, oid, h, who=None):
    return w.as_(who or w.stranger).submit_proofs(oid, json.dumps([["ethereum", h]]))["results"][0]


def ret(w, frm, value):
    return w.rpc.eth.tx(frm, w.recovery, value=value)


# --- 1. claim fairness ---------------------------------------------------------

def test_each_exploiter_address_claims_only_its_own_share(w):
    oid = w.offer(exploiters=[w.exploiter, w.exploiter2, w.attacker], stolen=12 * GEN, bounty=12 * GEN)
    prove(w, oid, ret(w, w.exploiter, 3 * GEN))
    prove(w, oid, ret(w, w.exploiter2, 6 * GEN))
    w.at(NOW + 3600 + 60)
    s = w.as_(w.stranger).settle(oid)
    assert (s["status"], s["owed"]) == ("SETTLED_PARTIAL", str(9 * GEN))
    o = w.reg.get_offer(oid)
    assert o["shares"] == {w.exploiter: str(3 * GEN), w.exploiter2: str(6 * GEN)}
    with w.vm.expect_revert("NOTHING_OWED_TO_THIS_ADDRESS"):
        w.as_(w.attacker).claim(oid)                     # listed, returned nothing
    assert w.as_(w.exploiter2).claim(oid)["paid"] == str(6 * GEN)
    assert w.as_(w.exploiter).claim(oid)["paid"] == str(3 * GEN)
    assert (w.paid(w.exploiter), w.paid(w.exploiter2), w.paid(w.attacker), w.paid(w.protocol)) == (3 * GEN, 6 * GEN, 0, 3 * GEN)
    assert w.reg.get_stats()["balance"] == "0"
    with w.vm.expect_revert("ALREADY_CLAIMED"):
        w.as_(w.exploiter).claim(oid)


def test_beneficiary_commitment_is_set_once_by_the_exploiter_only(w):
    oid = w.offer()
    prove(w, oid, ret(w, w.exploiter, 5 * GEN))
    with w.vm.expect_revert("NOT_AN_EXPLOITER_ADDRESS"):
        w.as_(w.attacker).commit_beneficiary(oid, w.attacker)
    w.as_(w.exploiter).commit_beneficiary(oid, w.payee)
    with w.vm.expect_revert("BENEFICIARY_ALREADY_COMMITTED"):
        w.as_(w.exploiter).commit_beneficiary(oid, w.attacker)
    w.at(NOW + 3600 + 60)
    w.as_(w.stranger).settle(oid)
    r = w.as_(w.exploiter).claim(oid)
    assert (r["to"], r["paid"]) == (w.payee, str(5 * GEN))
    assert (w.paid(w.payee), w.paid(w.attacker), w.paid(w.exploiter)) == (5 * GEN, 0, 0)


# --- 2. evidence recovery -------------------------------------------------------

def test_outage_pending_then_recovered_inside_the_window(w):
    oid = w.offer()
    h = ret(w, w.exploiter, 5 * GEN)
    w.rpc.down.add(ETH_URLS[0])
    r = prove(w, oid, h)
    assert r["status"] == "PENDING"
    o = w.reg.get_offer(oid)
    w.at(o["settle_at"])
    with w.vm.expect_revert("PENDING_PROOFS_UNTIL_%d" % o["recover_until"]):
        w.as_(w.stranger).settle(oid)
    w.rpc.down.clear()
    assert w.as_(w.stranger).retry_proofs(oid, json.dumps([r["proof_id"]]))["results"][0]["status"] == "COUNTED"
    assert w.as_(w.stranger).settle(oid)["status"] == "SETTLED_PARTIAL"


def test_outage_past_the_window_expires(w):
    oid = w.offer()
    w.rpc.down.add(ETH_URLS[1])
    prove(w, oid, ret(w, w.exploiter, 5 * GEN))
    o = w.reg.get_offer(oid)
    w.at(o["recover_until"] + 1)
    with w.vm.expect_revert("RECOVERY_CLOSED_AT_"):
        w.as_(w.stranger).retry_proofs(oid, json.dumps([1]))
    assert w.as_(w.stranger).settle(oid)["status"] == "SETTLED_NONE"
    assert w.reg.get_proofs(oid, 0, 10)["items"][0]["status"] == "EXPIRED"


# --- 3. the registry index the gate reads: copies never shadow the protocol's offer ----

def test_get_offer_by_returns_only_the_protocols_own_offer(w):
    real = w.offer(incident="exploit-2026")
    copy = w.offer(sender=w.attacker, incident="exploit-2026", exploiters=[w.stranger], stolen=GEN)
    prove(w, copy, w.rpc.eth.tx(w.stranger, w.recovery, value=GEN))
    assert w.as_(w.stranger).settle(copy)["status"] == "SETTLED_FULL"
    o = w.reg.get_offer_by(w.protocol, "exploit-2026")
    assert (o["found"], o["offer_id"], o["protocol"], o["status"]) == (True, real, w.protocol, "OPEN")
    assert w.reg.get_offer_by(w.attacker, "exploit-2026")["offer_id"] == copy
    assert w.reg.get_offer_by(w.protocol, "never-opened")["found"] is False


# --- 4. amendments near settlement ------------------------------------------------

def test_amendments_close_before_the_deadline_and_are_recorded(w):
    oid = w.offer(deadline=NOW + 1000)
    w.as_(w.protocol).extend_deadline(oid, NOW + 1100)
    w.as_(w.protocol).add_recovery(oid, "ethereum", w.payee)
    o = w.reg.get_offer(oid)
    assert [(e["seq"], e["what"]) for e in o["amendments"]] == [(1, "deadline"), (2, "recovery")]
    w.at(o["amendments_close_at"])
    with w.vm.expect_revert("AMENDMENTS_CLOSED_AT_%d" % o["amendments_close_at"]):
        w.as_(w.protocol).extend_deadline(oid, NOW + 1200)
    with w.vm.expect_revert("AMENDMENTS_CLOSED_AT_"):
        w.as_(w.protocol).add_recovery(oid, "ethereum", w.stranger)
    with w.vm.expect_revert("EXTENSION_CAP_"):
        w.at(NOW)
        w.as_(w.protocol).extend_deadline(oid, NOW + 1000 + 3601)
