"""Static checks on the deployed bytes (build/): format, the one way GEN
leaves, checks-before-writes, nothing nondeterministic outside the read.
cd test && python3 -m unittest -q test_static"""
import ast
import json
import re
import subprocess
import unittest
from pathlib import Path

import stub

ROOT = Path(__file__).resolve().parent.parent
NAMES = ("WhiteFlagRegistry", "SafeHarborGate")
DEPENDS = '# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }'


def src(name):
    return (ROOT / "build" / (name + ".py")).read_text()


def calls_named(tree, attr):
    return [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == attr]


def methods(name):
    tree = ast.parse(src(name))
    cls = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == name][0]
    return {n.name: n for n in cls.body if isinstance(n, ast.FunctionDef)}


def decorators(fn):
    return [ast.unparse(d) for d in fn.decorator_list]


class Format(unittest.TestCase):
    def test_build_is_fresh(self):
        r = subprocess.run(["python3", str(ROOT / "tools" / "build.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_first_line_and_depends(self):
        for n in NAMES:
            lines = src(n).split("\n")
            self.assertEqual(lines[0], "# v0.3.0", n)
            self.assertEqual(lines[1], DEPENDS, n)

    def test_parses(self):
        for n in NAMES:
            ast.parse(src(n))

    def test_no_undefined_names(self):
        for n in NAMES:
            self.assertEqual(stub.undefined_names(ROOT / "build" / (n + ".py")), [], n)

    def test_no_str_replace(self):
        for n in NAMES:
            self.assertEqual(calls_named(ast.parse(src(n)), "replace"), [], n)

    def test_no_forbidden_imports(self):
        for n in NAMES:
            for node in ast.walk(ast.parse(src(n))):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    mod = node.module if isinstance(node, ast.ImportFrom) else node.names[0].name
                    self.assertIn(mod.split(".")[0], ("genlayer", "dataclasses", "json", "typing"), n)

    def test_no_float(self):
        for n in NAMES:
            for node in ast.walk(ast.parse(src(n))):
                if isinstance(node, ast.Constant):
                    self.assertNotIsInstance(node.value, float, n)
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                    self.assertNotEqual(node.func.id, "float", n)
                if isinstance(node, ast.BinOp):
                    self.assertNotIsInstance(node.op, ast.Div, n + ": use // (integer math)")

    def test_storage_uses_gl_types(self):
        for n in NAMES:
            tree = ast.parse(src(n))
            cls = [c for c in tree.body if isinstance(c, ast.ClassDef) and c.name == n][0]
            for node in cls.body:
                if isinstance(node, ast.AnnAssign):
                    ann = ast.unparse(node.annotation)
                    self.assertFalse(ann.startswith("dict") or ann.startswith("list"), n + "." + ast.unparse(node.target))

    def test_shared_helpers_identical_in_both(self):
        common = (ROOT / "contracts" / "shared" / "common.py").read_text()
        for n in NAMES:
            self.assertIn(common, src(n))


class NoModel(unittest.TestCase):
    def test_no_prompt_anywhere(self):
        for n in NAMES:
            t = src(n)
            for word in ("exec_prompt", "eq_principle", "prompt_comparative", "web.render", "web.get("):
                self.assertNotIn(word, t, n)

    def test_one_nondet_block(self):
        self.assertEqual(len(calls_named(ast.parse(src("WhiteFlagRegistry")), "run_nondet")), 1)
        self.assertEqual(len(calls_named(ast.parse(src("SafeHarborGate")), "run_nondet")), 0)

    def test_nondet_only_in_submit_and_retry(self):
        m = methods("WhiteFlagRegistry")
        users = sorted(k for k, f in m.items() if calls_named(f, "run_nondet"))
        self.assertEqual(users, ["_read_and_judge"])
        callers = sorted(k for k, f in m.items() if calls_named(f, "_read_and_judge"))
        self.assertEqual(callers, ["retry_proofs", "submit_proofs"])

    def test_web_request_only_posts_to_allowlist(self):
        t = src("WhiteFlagRegistry")
        self.assertIn("if not rpc_url_allowed(url):", t)
        self.assertEqual(t.count("gl.nondet.web.request("), 1)


class ValueExits(unittest.TestCase):
    def setUp(self):
        self.tree = ast.parse(src("WhiteFlagRegistry"))
        self.m = methods("WhiteFlagRegistry")

    def test_no_internal_transfer_anywhere(self):
        for n in NAMES:
            self.assertEqual(calls_named(ast.parse(src(n)), "emit_transfer"), [], n)

    def test_one_send_and_it_is_external(self):
        sends = calls_named(self.tree, "emit_call")
        self.assertEqual(len(sends), 1)
        lines = range(self.m["_send"].lineno, self.m["_send"].end_lineno + 1)
        self.assertIn(sends[0].lineno, lines)
        self.assertIn("gl.evm.Account", ast.unparse(sends[0].func))
        self.assertEqual(ast.unparse(sends[0].args[1]), "b''")

    def test_who_sends(self):
        users = sorted(k for k, f in self.m.items() if k != "_send" and calls_named(f, "_send"))
        self.assertEqual(users, ["claim", "refund_unclaimed", "settle", "sweep_stray", "withdraw_refund"])

    def test_each_sender_sends_once_and_last(self):
        for k in ("claim", "refund_unclaimed", "settle", "sweep_stray", "withdraw_refund"):
            body = self.m[k].body
            send_at = [i for i, s in enumerate(body) if calls_named(s, "_send")]
            self.assertEqual(len(send_at), 1, k)
            # nothing but the return after the send
            self.assertTrue(all(isinstance(s, ast.Return) for s in body[send_at[0] + 1:]), k)

    def test_gate_holds_no_value(self):
        t = src("SafeHarborGate")
        self.assertNotIn("payable", t)
        self.assertNotIn("emit_call", t)

    def test_only_create_offer_is_payable(self):
        pay = sorted(k for k, f in self.m.items() if any("payable" in d for d in decorators(f)))
        self.assertEqual(pay, ["create_offer"])

    def test_create_offer_never_raises(self):
        raises = [n for n in ast.walk(self.m["create_offer"]) if isinstance(n, ast.Raise)]
        self.assertEqual(raises, [])

    def test_no_owner_powers(self):
        for k in self.m:
            self.assertNotIn(k, ("set_mode", "set_claim_window", "pause", "upgrade", "cancel", "set_deployer"))


class ChecksBeforeWrites(unittest.TestCase):
    """In every write, no assignment to self.* (or a stored struct) happens
    before the last `raise`."""

    def test_writes_after_last_raise(self):
        m = methods("WhiteFlagRegistry")
        for k, f in m.items():
            if not any("write" in d for d in decorators(f)):
                continue
            body = f.body
            last_raise = max([i for i, s in enumerate(body) if any(isinstance(n, ast.Raise) for n in ast.walk(s))], default=-1)
            for i, s in enumerate(body[:last_raise + 1]):
                for n in ast.walk(s):
                    if isinstance(n, (ast.Assign, ast.AugAssign)):
                        for t in (n.targets if isinstance(n, ast.Assign) else [n.target]):
                            txt = ast.unparse(t)
                            self.assertFalse(txt.startswith("self.") or txt.startswith("o.") or txt.startswith("p."),
                                             "%s writes %s before its last check" % (k, txt))
                    if isinstance(n, ast.Call) and ast.unparse(n.func).startswith("self._bump"):
                        self.fail("%s bumps a counter before its last check" % k)

    def test_writes_marker_present(self):
        m = methods("WhiteFlagRegistry")
        for k in ("create_offer", "extend_deadline", "add_recovery", "submit_proofs", "settle", "claim",
                  "refund_unclaimed", "withdraw_refund", "sweep_stray"):
            self.assertIn("# --- writes", ast.get_source_segment(src("WhiteFlagRegistry"), m[k]), k)


class ChainTables(unittest.TestCase):
    def test_contract_and_js_tables_agree(self):
        reg = __import__("fixtures").RG
        js = (ROOT / "tools" / "lib" / "chains.mjs").read_text()
        for name, (cid, urls) in reg.CHAINS.items():
            m = re.search(name + r": \{ id: (\d+), rpcs: \[([^\]]*)\]", js)
            self.assertIsNotNone(m, name)
            self.assertEqual(int(m.group(1)), cid)
            self.assertEqual(json.loads("[" + m.group(2) + "]"), list(urls))

    def test_two_distinct_operators_per_chain(self):
        reg = __import__("fixtures").RG
        for name, (_, urls) in reg.CHAINS.items():
            self.assertEqual(len(urls), 2)
            hosts = [u.split("/")[2] for u in urls]
            self.assertNotEqual(hosts[0].split(".")[-2], hosts[1].split(".")[-2], name)

    def test_demo_chain_tables_agree(self):
        reg = __import__("fixtures").RG
        js = (ROOT / "tools" / "lib" / "chains.mjs").read_text()
        for name, (cid, urls) in reg.DEMO_CHAINS.items():
            m = re.search(name + r": \{ id: (\d+), rpcs: \[([^\]]*)\]", js)
            self.assertIsNotNone(m, name)
            self.assertEqual((int(m.group(1)), json.loads("[" + m.group(2) + "]")), (cid, list(urls)))
            self.assertNotIn(name, reg.CHAINS)

    def test_transfer_topic(self):
        reg = __import__("fixtures").RG
        js = (ROOT / "tools" / "lib" / "chains.mjs").read_text()
        self.assertIn(reg.TRANSFER_TOPIC, js)


if __name__ == "__main__":
    unittest.main()
