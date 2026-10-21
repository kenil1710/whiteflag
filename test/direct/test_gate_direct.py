"""Direct Mode: SafeHarborGate answers only protocol-bound questions. The
registry's answers come from the shape the real registry returns
(test_registry_direct checks the registry side: get_offer_by never returns a
copy opened by another address)."""
import pytest

from conftest import NOW, addr

PROTOCOL, ATTACKER = addr(1), addr(7)


def settled(protocol, incident, offer_id=1, status="SETTLED_FULL", ppm=1000000, bounty="100", owed="100"):
    return {"found": True, "offer_id": offer_id, "protocol": protocol, "incident": incident, "status": status,
            "bounty": bounty, "owed": owed, "claimed": "0", "refunded_at_settle": str(int(bounty) - int(owed)),
            "unclaimed_refunded": "0", "fraction_ppm": ppm, "claim_deadline": NOW + 100}


def test_unverified_views_do_not_exist(gw):
    for name in ("check", "is_favorable"):
        with pytest.raises(Exception):
            getattr(gw.gate, name)(1)


def test_favorable_for_the_protocols_own_settled_offer(gw):
    gw.answers[(PROTOCOL, "hack")] = settled(PROTOCOL, "hack")
    s = gw.gate.check_for(PROTOCOL, "hack")
    assert (s["state"], s["favorable"], s["offer_id"]) == ("SETTLED_FULL", True, 1)
    assert gw.gate.is_favorable_for(PROTOCOL, "hack") is True
    assert gw.reads[-1] == (PROTOCOL, "hack")


def test_copied_incident_by_another_address_is_not_found_for_the_protocol(gw):
    # the attacker's copy exists, settled FULL, but only under the attacker's address
    gw.answers[(ATTACKER, "hack")] = settled(ATTACKER, "hack", offer_id=2)
    s = gw.gate.check_for(PROTOCOL, "hack")
    assert (s["state"], s["favorable"]) == ("NO_OFFER", False)
    assert gw.gate.is_favorable_for(PROTOCOL, "hack") is False


def test_registry_answer_for_another_creator_or_incident_is_never_believed(gw):
    gw.answers[(PROTOCOL, "hack")] = settled(ATTACKER, "hack", offer_id=2)
    assert gw.gate.check_for(PROTOCOL, "hack")["state"] == "UNREADABLE"
    gw.answers[(PROTOCOL, "hack")] = settled(PROTOCOL, "other")
    assert gw.gate.is_favorable_for(PROTOCOL, "hack") is False


def test_unreadable_registry_is_never_favorable(gw):
    gw.answers[(PROTOCOL, "hack")] = RuntimeError("registry down")
    s = gw.gate.check_for(PROTOCOL, "hack")
    assert (s["state"], s["favorable"]) == ("UNREADABLE", False)


def test_partial_threshold_and_open(gw):
    gw.answers[(PROTOCOL, "p")] = settled(PROTOCOL, "p", status="SETTLED_PARTIAL", ppm=899999, owed="89")
    assert gw.gate.is_favorable_for(PROTOCOL, "p") is False
    gw.answers[(PROTOCOL, "p")] = settled(PROTOCOL, "p", status="SETTLED_PARTIAL", ppm=900000, owed="90")
    assert gw.gate.is_favorable_for(PROTOCOL, "p") is True
    gw.answers[(PROTOCOL, "o")] = {**settled(PROTOCOL, "o"), "status": "OPEN"}
    assert gw.gate.check_for(PROTOCOL, "o")["state"] == "OPEN"


def test_bad_protocol_address(gw):
    for p in ("nope", "", "0x" + "0" * 40):
        s = gw.gate.check_for(p, "hack")
        assert (s["state"], s["favorable"]) == ("UNREADABLE", False)
