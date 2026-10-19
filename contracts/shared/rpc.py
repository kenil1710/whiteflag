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
    for ch in CHAINS:
        if url in CHAINS[ch][1]:
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
    """One endpoint, one batch. Retried (up to RPC_TRIES) on a transport
    failure, a 429 or 5xx, or an answer that is not a usable batch."""
    if not rpc_url_allowed(url):
        raise ReadFailed("rpc not allowed")
    body = json.dumps([{"jsonrpc": "2.0", "id": j, "method": calls[j][0], "params": calls[j][1]}
                       for j in range(len(calls))])
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
            return parse_batch(json.loads(_raw(res).decode("utf-8", errors="replace")), len(calls))
        except ReadFailed as e:
            why = str(e)
        except Exception:
            why = "json"
    raise ReadFailed(why)


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
        logs.append({"i": li, "address": la, "from": "0x" + t1[26:], "to": "0x" + t2[26:], "amount": str(amt)})
    st = str(rc.get("status", "")).lower()
    return {"status": 1 if st == "0x1" else 0, "block": blk, "block_hash": bh, "time": ts,
            "from": frm, "to": to, "value": str(val), "logs": logs}


def read_one(url: str, chain_id: int, h: str) -> dict:
    """One RPC: [tx, receipt, finalized head, chain id], then the receipt's
    block header. {"reason": ...} or {"proj": ..., "finalized": n}."""
    got = rpc_send(url, [["eth_getTransactionByHash", [h]], ["eth_getTransactionReceipt", [h]],
                         ["eth_getBlockByNumber", ["finalized", False]], ["eth_chainId", []]])
    if _hex_int(got[3]) != chain_id:
        return {"reason": "WRONG_CHAIN_ID"}
    fin = got[2]
    fin_n = _hex_int(fin.get("number")) if isinstance(fin, dict) else -1
    if fin_n < 0:
        return {"reason": "RPC_UNREADABLE"}
    tx = got[0]
    rc = got[1]
    if tx is None:
        return {"reason": "TX_NOT_FOUND"}
    if rc is None:
        return {"reason": "TX_PENDING"}
    if not isinstance(rc, dict):
        return {"reason": "RPC_UNREADABLE"}
    hdr = rpc_send(url, [["eth_getBlockByNumber", [rc.get("blockNumber"), False]]])[0]
    p = project(tx, rc, hdr)
    if p is None:
        return {"reason": "RPC_UNREADABLE"}
    return {"proj": p, "finalized": fin_n}


def read_proof(chain: str, h: str) -> dict:
    """Both RPCs of the chain. {"reason": ...} on any error, a missing or
    pending transaction, or a disagreement; else {"read": projection,
    "final": the block is at or below BOTH RPCs' finalized heads}."""
    if chain not in CHAINS:
        return {"reason": "UNSUPPORTED_CHAIN"}
    cid = CHAINS[chain][0]
    views = []
    for url in CHAINS[chain][1]:
        try:
            views.append(read_one(url, cid, h))
        except ReadFailed:
            return {"reason": "RPC_UNREADABLE"}
        except Exception:
            return {"reason": "RPC_UNREADABLE"}
    a = views[0]
    b = views[1]
    if "reason" in a or "reason" in b:
        if "reason" in a and "reason" in b and a["reason"] == b["reason"]:
            return {"reason": a["reason"]}
        return {"reason": "RPC_DISAGREE"}
    if _canon(a["proj"]) != _canon(b["proj"]):
        return {"reason": "RPC_DISAGREE"}
    fin = a["finalized"] if a["finalized"] < b["finalized"] else b["finalized"]
    return {"read": a["proj"], "final": a["proj"]["block"] <= fin}
# ==== end shared rpc ====
