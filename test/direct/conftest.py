"""GenLayer Direct Mode (genlayer-test's `direct_vm` / `direct_deploy`) for the
WhiteFlag contracts: build/WhiteFlagRegistry.py and build/SafeHarborGate.py,
the exact bytes that are deployed, run inside the official GenLayer Python SDK
(the runner the contract header pins).

Every JSON-RPC request the registry sends from its nondeterministic block goes
to `Rpc`, a set of mock EVM chains answering JSON-RPC batches per URL, so a
test can take one endpoint down, make the two endpoints disagree, or move the
finalized head between the leader's run and a validator's re-run
(`direct_vm.run_validator()`).

    .venv/bin/python -m pytest test/direct -q
"""
import hashlib
import json
import os
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
# The contracts pin py-genlayer:5jycge4q..., the runner GenLayer Studio Dev
# accepts; it is not in any published GenVM bundle, so Direct Mode runs the
# build files with that one Depends line pointed at the newest published
# runner whose SDK layout genlayer-test's Direct Mode loads (py-genlayer:1zr6nqk5...,
# GenVM v0.3.0-rc7, GENVM_VERSION). Every
# other byte is the deployed one; test_runner_pin checks that.
STUDIO_RUNNER = "5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng"
PUBLISHED_RUNNER = "1zr6nqk597d97kg0dyxg0shhrykx5v02zjgnyrajapy4wlqvfvwh"
os.environ.setdefault("GENVM_VERSION", "v0.3.0-rc7")
_RUN = Path(tempfile.mkdtemp(prefix="wf-direct-"))


def runnable(name):
    src = (ROOT / "build" / (name + ".py")).read_text()
    assert src.count(STUDIO_RUNNER) == 1, name
    out = _RUN / (name + ".py")
    out.write_text(src.replace(STUDIO_RUNNER, PUBLISHED_RUNNER))
    return str(out)


REGISTRY = runnable("WhiteFlagRegistry")
GATE = runnable("SafeHarborGate")

TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ETH_URLS = ("https://rpc.mevblocker.io", "https://eth-mainnet.public.blastapi.io")
ARB_URLS = ("https://arb1.arbitrum.io/rpc", "https://arbitrum-one.public.blastapi.io")
DEMO_URLS = ("https://whiteflag-ledger.vercel.app/api/demochain/a", "https://whiteflag-ledger.vercel.app/api/demochain/b")
GEN = 10 ** 18
NOW_ISO = "2026-10-17T12:00:00Z"
NOW = 1792238400


def h32(seed):
    return "0x" + hashlib.sha256(str(seed).encode()).hexdigest()


def addr(n):
    return "0x" + hashlib.sha256(b"direct-addr%d" % n).hexdigest()[:40]


def raw(a):
    """A 0x address as the 20 bytes the VM context takes."""
    return bytes.fromhex(a[2:])


def topic(a):
    return "0x" + "0" * 24 + a[2:].lower()


class Chain:
    def __init__(self, chain_id, finalized):
        self.chain_id = chain_id
        self.finalized = finalized
        self.blocks = {}
        self.txs = {}
        self.n = 0

    def block(self, number, ts):
        self.blocks[number] = {"number": hex(number), "hash": h32("blk%d-%d" % (self.chain_id, number)), "timestamp": hex(ts)}

    def tx(self, frm, to, value=0, ts=NOW - 86400, block=None, status=1, logs=(), pending=False):
        self.n += 1
        hsh = h32("tx%d-%d" % (self.chain_id, self.n))
        number = block if block is not None else self.finalized - 100 + self.n
        self.block(number, ts)
        bh = self.blocks[number]["hash"]
        tx = {"hash": hsh, "from": frm, "to": to, "value": hex(value), "blockNumber": hex(number), "blockHash": bh, "input": "0x"}
        rl = [{"address": t, "topics": [TRANSFER, topic(f), topic(r)], "data": "0x%064x" % a, "logIndex": hex(i)}
              for i, (t, f, r, a) in enumerate(logs)]
        rc = {"transactionHash": hsh, "status": hex(status), "blockNumber": hex(number), "blockHash": bh, "logs": rl}
        if pending:
            tx["blockNumber"] = None
            tx["blockHash"] = None
            rc = None
        self.txs[hsh] = {"tx": tx, "rc": rc}
        return hsh

    def answer(self, method, params):
        if method == "eth_chainId":
            return hex(self.chain_id)
        if method == "eth_getTransactionByHash":
            t = self.txs.get(params[0])
            return t["tx"] if t else None
        if method == "eth_getTransactionReceipt":
            t = self.txs.get(params[0])
            return t["rc"] if t else None
        if method == "eth_getBlockByNumber":
            if params[0] == "finalized":
                if self.finalized not in self.blocks:
                    self.block(self.finalized, NOW - 600)
                return self.blocks[self.finalized]
            return self.blocks.get(int(params[0], 16))
        raise ValueError(method)


class Rpc:
    """URL -> chain; per-URL faults: `down` (HTTP 503), `tamper` (rewrite an answer)."""

    def __init__(self):
        self.chains = {}
        self.down = set()
        self.tamper = {}
        self.calls = 0

    def serve(self, urls, chain):
        for u in urls:
            self.chains[u] = chain

    def __call__(self, data):
        url = data.get("url", "")
        self.calls += 1
        if url in self.down or url not in self.chains:
            return _http(503, b"down")
        body = data.get("body") or b"[]"
        if isinstance(body, (bytes, bytearray)):
            body = body.decode()
        reqs = json.loads(body)
        out = []
        for r in (reqs if isinstance(reqs, list) else [reqs]):
            ans = {"jsonrpc": "2.0", "id": r["id"], "result": self.chains[url].answer(r["method"], r["params"])}
            if url in self.tamper:
                ans = self.tamper[url](r, json.loads(json.dumps(ans)))
            out.append(ans)
        return _http(200, json.dumps(out).encode())


def _http(status, body):
    return {"ok": {"response": {"status": status, "headers": {}, "body": body}}}


@pytest.fixture
def rpc(direct_vm):
    r = Rpc()
    r.eth = Chain(1, 20_000_000)
    r.arb = Chain(42161, 300_000_000)
    r.demo = Chain(357357, 1_000)
    r.serve(ETH_URLS, r.eth)
    r.serve(ARB_URLS, r.arb)
    r.serve(DEMO_URLS, r.demo)
    direct_vm._live_web_handler = r
    return r


def set_time(vm, iso):
    """vm.warp() keeps the VM's clock; the contracts read gl.message.raw["datetime"], so it is set too."""
    import sys as _sys
    vm.warp(iso)
    msg = _sys.modules.get("genlayer.message")
    if msg is not None and isinstance(getattr(msg, "raw", None), dict):
        msg.raw["datetime"] = iso


def _fresh_contract_slot():
    """Direct Mode runs one contract per VM; the SDK remembers the first one per process."""
    import sys as _sys
    mod = _sys.modules.get("genlayer.contract")
    if mod is not None and hasattr(mod, "__known_contract__"):
        mod.__known_contract__ = None


class W:
    """The world of one test: the VM, a DEMO registry, named accounts."""

    def __init__(self, vm, deploy, rpc, mode="DEMO"):
        self.vm = vm
        self.rpc = rpc
        vm.warp(NOW_ISO)
        self.deployer = addr(0)
        vm.sender = raw(self.deployer)
        _fresh_contract_slot()
        self.reg = deploy(REGISTRY, mode)
        set_time(vm, NOW_ISO)
        # Payouts: the contract calls gl.evm.Account(to).emit_call(value, b""), the
        # external value message Studio's runner delivers. In the published SDK
        # that method is only a Protocol stub (a silent no-op), so the harness
        # records each call; the demo run checks real delivery on Studio.
        self.sends = []
        import sys as _sys
        evm = _sys.modules["genlayer.evm"]
        world = self

        def emit_call(acct, value, data):
            world.sends.append(("0x" + bytes(acct.address.as_bytes).hex(), int(value)))
            me = vm._contract_address
            vm.deal(me, vm._balances.get(me, 0) - int(value))
        self._evm, self._saved_emit = evm, getattr(evm.Account, "emit_call", None)
        evm.Account.emit_call = emit_call
        self.protocol, self.exploiter, self.exploiter2, self.recovery = addr(1), addr(2), addr(3), addr(4)
        self.stranger, self.payee, self.attacker = addr(5), addr(6), addr(7)
        for a in (self.protocol, self.exploiter, self.exploiter2, self.stranger, self.attacker):
            vm.deal(raw(a), 1000 * GEN)

    def at(self, epoch):
        import datetime
        set_time(self.vm, datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))

    def as_(self, who, value=0):
        self.vm.sender = raw(who)
        self.vm.value = value
        return self.reg

    def offer(self, sender=None, incident="inc", chain="ethereum", exploiters=None, stolen=10 * GEN, bounty=10 * GEN,
              start=NOW - 30 * 86400, deadline=NOW + 3600, rule="EXPLOITER_OR_NAMED"):
        ex = exploiters or [self.exploiter]
        r = self.as_(sender or self.protocol, bounty).create_offer(
            incident, "Incident " + incident, json.dumps([chain]),
            json.dumps([{"chain": chain, "address": a} for a in ex]),
            json.dumps([{"chain": chain, "address": self.recovery}]),
            json.dumps([{"chain": chain, "token": "native", "decimals": 18, "stolen": str(stolen), "weight": "1"}]),
            1000, start, deadline, rule, "{}")
        self.vm.value = 0
        assert r["ok"], r
        self.credit(bounty)
        return r["offer_id"]

    def credit(self, amount):
        """Direct Mode does not move msg.value into the contract; the chain does. Do it here."""
        me = self.vm._contract_address
        self.vm.deal(me, self.vm._balances.get(me, 0) + amount)

    def paid(self, to):
        return sum(v for (a, v) in self.sends if a == to.lower())


@pytest.fixture
def w(direct_vm, direct_deploy, rpc):
    world = W(direct_vm, direct_deploy, rpc)
    yield world
    if world._saved_emit is not None:
        world._evm.Account.emit_call = world._saved_emit


class GateWorld:
    """A SafeHarborGate alone in its VM. Its one cross-contract read,
    registry.get_offer_by(protocol, incident), is answered from `answers`
    (what the registry returns for each (protocol, incident))."""

    def __init__(self, vm, deploy):
        self.vm = vm
        vm.warp(NOW_ISO)
        vm.sender = raw(addr(0))
        self.registry = addr(99)
        self.answers = {}
        self.reads = []
        _fresh_contract_slot()
        self.gate = deploy(GATE, self.registry, 900000)
        set_time(vm, NOW_ISO)
        import sys as _sys
        gl_mod = _sys.modules["genlayer.contract"]
        world = self

        class _View:
            def get_offer_by(self, protocol, incident):
                world.reads.append((protocol, incident))
                a = world.answers.get((protocol, incident))
                if isinstance(a, Exception):
                    raise a
                return json.loads(json.dumps(a)) if a is not None else {"found": False, "protocol": protocol, "incident": incident}

        class _Handle:
            def view(self):
                return _View()

        self._saved = gl_mod.get_at
        gl_mod.get_at = lambda address: _Handle()
        self._mod = gl_mod

    def close(self):
        self._mod.get_at = self._saved


@pytest.fixture
def gw(direct_vm, direct_deploy):
    g = GateWorld(direct_vm, direct_deploy)
    yield g
    g.close()
