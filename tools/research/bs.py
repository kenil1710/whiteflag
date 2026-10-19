"""Research helper: an address's outgoing transactions and token transfers from
a Blockscout explorer API (used only to FIND candidate return transactions;
every one is then read from two RPCs by tools/feasibility.mjs).

  python3 tools/research/bs.py eth.blockscout.com 0xADDR tx|tok [max_pages]
"""
import json
import sys
import urllib.request

host, a = sys.argv[1], sys.argv[2]
kind = sys.argv[3] if len(sys.argv) > 3 else "tx"
pages = int(sys.argv[4]) if len(sys.argv) > 4 else 6


def get(u):
    req = urllib.request.Request(u, headers={"User-Agent": "curl/8"})
    return json.load(urllib.request.urlopen(req, timeout=40))


path = "transactions" if kind == "tx" else "token-transfers"
base = f"https://{host}/api/v2/addresses/{a}/{path}?filter=from"
u, n = base, 0
while u and n < pages:
    d = get(u)
    n += 1
    for t in d.get("items", []):
        if kind == "tx":
            print(t["hash"], t["timestamp"][:19], (t["to"] or {}).get("hash"), int(t["value"]) / 1e18,
                  t["status"], t.get("method"))
        else:
            tok = t["token"]
            dec = int(tok.get("decimals") or 0)
            print(t["transaction_hash"], t["timestamp"][:19], t["to"]["hash"], tok.get("symbol"),
                  tok.get("address_hash") or tok.get("address"), int(t["total"].get("value") or 0) / 10 ** dec,
                  t.get("log_index"))
    p = d.get("next_page_params")
    u = base + "&" + "&".join(f"{k}={v}" for k, v in p.items()) if p else None
