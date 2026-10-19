#!/bin/sh
# Research helper: a transaction's sender, recipient, block time and input decoded as text.  sh msg.sh <rpc> <hash>
R=$1; H=$2
curl -s "$R" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionByHash\",\"params\":[\"$H\"]}" > /tmp/wf_msg_tx.json
B=$(python3 -c "import json;print(json.load(open('/tmp/wf_msg_tx.json'))['result']['blockNumber'])")
curl -s "$R" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"$B\",false]}" > /tmp/wf_msg_blk.json
python3 - <<'PY'
import json,datetime
t=json.load(open('/tmp/wf_msg_tx.json'))['result']; b=json.load(open('/tmp/wf_msg_blk.json'))['result']
print('from',t['from'],'to',t['to'],'block',int(b['number'],16),datetime.datetime.utcfromtimestamp(int(b['timestamp'],16)).isoformat()+'Z')
print(bytes.fromhex(t['input'][2:]).decode('utf8','replace'))
PY
