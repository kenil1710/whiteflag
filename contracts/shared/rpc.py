# ==== shared rpc helpers: contracts/shared/rpc.py, inlined by tools/build.py; edit there ====

class ReadFailed(Exception):
    """An endpoint did not answer, or answered something that is not a
    JSON-RPC result. Nothing is guessed."""


def _status(res: typing.Any) -> int:
    s = getattr(res, "status_code", None)
    if s is None:
        s = getattr(res, "status", None)
    return 0 if s is None else int(s)


def _raw(res: typing.Any) -> bytes:
    b = getattr(res, "body", None)
    if b is None:
        return b""
    if isinstance(b, bytes):
        return b
    return str(b).encode("utf-8")


def rpc_url_allowed(url: str) -> bool:
    for table in (CHAINS, DEMO_CHAINS):
        for ch in table:
            if url in table[ch][1]:
                return True
    return False


def parse_batch(doc: typing.Any, n: int) -> list:
    """A JSON-RPC batch answer -> results in call order. Any error raises."""
    if isinstance(doc, dict):
        doc = [doc]
    if not isinstance(doc, list):
        raise ReadFailed("batch")
    by_id = {}
    for item in doc:
        if isinstance(item, dict) and isinstance(item.get("id"), int) and not isinstance(item.get("id"), bool):
            by_id[item["id"]] = item
    out = []
    for i in range(n):
        item = by_id.get(i)
        if item is None:
            raise ReadFailed("missing id")
        if "error" in item and item["error"] is not None:
            raise ReadFailed("rpc error")
        if "result" not in item:
            raise ReadFailed("no result")
        out.append(item["result"])
    return out


def rpc_send(url: str, calls: list) -> list:
    """One endpoint, every call, in batches of at most BATCH_MAX. A batch is
    retried (up to RPC_TRIES) on a transport failure, a 429 or 5xx, or an
    answer that is not a usable batch."""
    if not rpc_url_allowed(url):
        raise ReadFailed("rpc not allowed")
    out = []
    i = 0
    while i < len(calls):
        chunk = calls[i:i + BATCH_MAX]
        body = json.dumps([{"jsonrpc": "2.0", "id": j, "method": chunk[j][0], "params": chunk[j][1]}
                           for j in range(len(chunk))])
        got = None
        why = ""
        for _ in range(RPC_TRIES):
            try:
                res = gl.nondet.web.request(url, method="POST", body=body,
                                            headers={"Content-Type": "application/json"})
            except Exception:
                why = "transport"
                continue
            st = _status(res)
            if st != 200:
                why = "http " + str(st)
                if st != 429 and st < 500:
                    break
                continue
            try:
                got = parse_batch(json.loads(_raw(res).decode("utf-8", errors="replace")), len(chunk))
                break
            except ReadFailed as e:
                why = str(e)
            except Exception:
                why = "json"
        if got is None:
            raise ReadFailed(why)
        out = out + got
        i += BATCH_MAX
    return out


def project(tx: typing.Any, rc: typing.Any, hdr: typing.Any) -> typing.Any:
    """Only the fields the rule uses, so two honest RPCs compare equal: status,
    block, block hash, block time, sender, recipient, value and every
    3-topic Transfer log. None if the transaction or receipt is missing or
    malformed."""
    if not isinstance(tx, dict) or not isinstance(rc, dict) or not isinstance(hdr, dict):
        return None
    blk = _hex_int(rc.get("blockNumber"))
    ts = _hex_int(hdr.get("timestamp"))
    bh = _hash32(rc.get("blockHash", ""))
    frm = _addr(tx.get("from", ""))
    to = _addr(tx.get("to", "")) if tx.get("to") is not None else ""
    val = _hex_int(tx.get("value"))
    if blk < 0 or ts < 0 or bh == "" or frm == "" or val < 0 or _hex_int(hdr.get("number")) != blk:
        return None
    if _hash32(hdr.get("hash", "")) != bh:
        return None
    logs = []
    raw_logs = rc.get("logs", [])
    if not isinstance(raw_logs, list):
        return None
    for lg in raw_logs:
        if not isinstance(lg, dict):
            return None
        t = lg.get("topics", [])
        if not isinstance(t, list) or len(t) != 3 or str(t[0]).lower() != TRANSFER_TOPIC:
            continue
        t1 = _hash32(t[1])
        t2 = _hash32(t[2])
        li = _hex_int(lg.get("logIndex"))
        la = _addr(lg.get("address", ""))
        d = str(lg.get("data", "")).lower()
        amt = 0 if d == "0x" else _hex_int(d)
        if t1 == "" or t2 == "" or li < 0 or la == "" or amt < 0:
            return None
        if t1[2:26] != "0" * 24 or t2[2:26] != "0" * 24:
            continue        # not a canonical address topic: not an ERC-20 Transfer of an address
        logs.append({"i": li, "address": la, "from": "0x" + t1[26:], "to": "0x" + t2[26:], "amount": str(amt)})
    st = str(rc.get("status", "")).lower()
    return {"status": 1 if st == "0x1" else 0, "block": blk, "block_hash": bh, "time": ts,
            "from": frm, "to": to, "value": str(val), "logs": logs}


def _host(url: str) -> str:
    rest = url[url.find("//") + 2:] if url.find("//") >= 0 else url
    cut = rest.find("/")
    return rest if cut < 0 else rest[:cut]


def read_view(url: str, chain_id: int, hashes: list) -> list:
    """One RPC, every hash of one chain: one batch [tx, receipt] per hash +
    finalized head + chain id, then one batch of the receipts' block headers.
    -> per hash {"reason": ...} or {"proj": ..., "finalized": n}. A transport
    or JSON-RPC failure raises ReadFailed for the whole chain."""
    calls = []
    for h in hashes:
        calls.append(["eth_getTransactionByHash", [h]])
        calls.append(["eth_getTransactionReceipt", [h]])
    calls.append(["eth_getBlockByNumber", ["finalized", False]])
    calls.append(["eth_chainId", []])
    got = rpc_send(url, calls)
    n = len(hashes)
    if _hex_int(got[2 * n + 1]) != chain_id:
        return [{"reason": "WRONG_CHAIN_ID"} for _ in hashes]
    fin = got[2 * n]
    fin_n = _hex_int(fin.get("number")) if isinstance(fin, dict) else -1
    if fin_n < 0:
        raise ReadFailed("no finalized head")
    blocks = []
    for i in range(n):
        rc = got[2 * i + 1]
        if got[2 * i] is not None and isinstance(rc, dict):
            b = rc.get("blockNumber")
            if isinstance(b, str) and _hex_int(b) >= 0 and b not in blocks:
                blocks.append(b)
    hdrs = {}
    if len(blocks) > 0:
        hs = rpc_send(url, [["eth_getBlockByNumber", [b, False]] for b in blocks])
        for j in range(len(blocks)):
            hdrs[blocks[j]] = hs[j]
    out = []
    for i in range(n):
        tx = got[2 * i]
        rc = got[2 * i + 1]
        if tx is None:
            out.append({"reason": "TX_NOT_FOUND"})
            continue
        if rc is None:
            out.append({"reason": "TX_PENDING"})
            continue
        if not isinstance(rc, dict):
            raise ReadFailed("bad receipt")
        p = project(tx, rc, hdrs.get(rc.get("blockNumber")))
        if p is None:
            out.append({"reason": "RPC_UNREADABLE"})
            continue
        out.append({"proj": p, "finalized": fin_n})
    return out


def read_proofs(items: list, table: dict) -> list:
    """[[chain, hash], ...] -> per item, read from BOTH RPCs of its chain:
    {"reason": ..., "detail": ...} on any error, a missing or pending
    transaction, or a disagreement; else {"read": projection, "final": the
    block is at or below BOTH RPCs' finalized heads}. table: the chains the
    calling registry accepts."""
    out = [None for _ in items]
    chains = []
    for it in items:
        if it[0] not in chains:
            chains.append(it[0])
    for ch in chains:
        idx = [i for i in range(len(items)) if items[i][0] == ch]
        if ch not in table:
            for i in idx:
                out[i] = {"reason": "UNSUPPORTED_CHAIN", "detail": ""}
            continue
        cid = table[ch][0]
        hashes = [items[i][1] for i in idx]
        views = []
        failed = ""
        for url in table[ch][1]:
            try:
                views.append(read_view(url, cid, hashes))
            except ReadFailed as e:
                failed = _host(url) + ": " + str(e)[:60]
                break
            except Exception:
                failed = _host(url) + ": unexpected answer"
                break
        if failed != "":
            for i in idx:
                out[i] = {"reason": "RPC_UNREADABLE", "detail": failed}
            continue
        for k in range(len(idx)):
            a = views[0][k]
            b = views[1][k]
            if "reason" in a or "reason" in b:
                if "reason" in a and "reason" in b and a["reason"] == b["reason"]:
                    out[idx[k]] = {"reason": a["reason"], "detail": ""}
                else:
                    out[idx[k]] = {"reason": "RPC_DISAGREE", "detail": "one RPC has the transaction, the other does not"}
                continue
            if _canon(a["proj"]) != _canon(b["proj"]):
                out[idx[k]] = {"reason": "RPC_DISAGREE", "detail": "the two RPCs answer differently"}
                continue
            fin = a["finalized"] if a["finalized"] < b["finalized"] else b["finalized"]
            out[idx[k]] = {"read": a["proj"], "final": a["proj"]["block"] <= fin}
    return out
# ==== end shared rpc ====
