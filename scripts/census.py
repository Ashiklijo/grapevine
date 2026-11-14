"""How many bounties posted on Sputnik DAOs were ever finished?

Reads every DAO made by the mainnet factory `sputnik-dao.near` over public RPC and counts the
bounties each one has posted with Sputnik's built-in bounty feature, and how many of those still
have unpaid slots. Read-only. Needs only Python 3.

    python scripts/census.py            fetch and report, about ten minutes on free RPC
    python scripts/census.py report     report again from data/bounties.json

A Sputnik bounty has `times` slots. Each approved BountyDone proposal pays one and lowers `times`
by one (sputnikdao2/src/proposals.rs, internal_callback_proposal_success), and a claim is refused
once the claims reach `times` (bounties.rs, bounty_claim). So the `times` a DAO reports for a
bounty is the number of slots nobody was paid for: 0 means it was done every time it was offered.
"""
import base64
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "bounties.json")
FACTORY = "sputnik-dao.near"
RPCS = ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.near.org"]
# Filed by software, not people. Left out of the counts, and named here so the choice is visible.
SKIP = {"bridge-validator.sputnik-dao.near"}


def view(account, method, args=None, tries=6):
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "query",
        "params": {
            "request_type": "call_function", "finality": "final", "account_id": account,
            "method_name": method,
            "args_base64": base64.b64encode(json.dumps(args or {}).encode()).decode(),
        },
    }).encode()
    last = None
    for attempt in range(tries):
        url = RPCS[attempt % len(RPCS)]
        try:
            req = urllib.request.Request(url, data=body, headers={"content-type": "application/json", "user-agent": "census"})
            with urllib.request.urlopen(req, timeout=40) as res:
                answer = json.loads(res.read())
            if "result" in answer and "result" in answer["result"]:
                return json.loads(bytes(answer["result"]["result"]).decode() or "null")
            last = str(answer.get("error") or answer.get("result", {}).get("error"))
            # A contract that has no such method, or no code at all, will not answer on a retry either.
            if "MethodNotFound" in last or "CodeDoesNotExist" in last or "does not exist" in last or "wasm execution failed" in last:
                return None
        except Exception as err:  # network trouble: try the next endpoint
            last = str(err)
        time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(f"{account}.{method}: {last}")


def one_dao(dao):
    try:
        last_id = view(dao, "get_last_bounty_id")
        if not last_id:
            return {"dao": dao, "posted": 0, "open": []}
        open_now = []
        for start in range(0, last_id, 50):
            for b in view(dao, "get_bounties", {"from_index": start, "limit": 50}) or []:
                open_now.append({"id": b.get("id"), "times": b.get("times"), "amount": b.get("amount"), "token": b.get("token")})
        return {"dao": dao, "posted": last_id, "open": open_now}
    except Exception as err:
        return {"dao": dao, "error": str(err)}


def fetch():
    count = view(FACTORY, "get_number_daos")
    daos = []
    for start in range(0, count, 400):
        daos += view(FACTORY, "get_daos", {"from_index": start, "limit": 400})
    daos = [d for d in daos if d not in SKIP]
    print(f"{len(daos)} DAOs on {FACTORY}", flush=True)
    rows = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        for i, row in enumerate(pool.map(one_dao, daos)):
            rows.append(row)
            if (i + 1) % 200 == 0:
                print(f"  {i + 1} read", flush=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({"fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "factory": FACTORY, "skipped": sorted(SKIP), "daos": rows}, f)


def report():
    with open(OUT) as f:
        data = json.load(f)
    rows = [r for r in data["daos"] if "error" not in r]
    with_bounties = [r for r in rows if r["posted"] > 0]
    bounties = [b for r in with_bounties for b in r["open"]]
    finished = [b for b in bounties if b["times"] == 0]
    never = sum(1 for r in with_bounties if not any(b["times"] == 0 for b in r["open"]))
    summary = {
        "fetched_at": data["fetched_at"],
        "factory": data["factory"],
        "daos_read": len(rows),
        "daos_unreadable": len(data["daos"]) - len(rows),
        "daos_that_ever_posted_a_bounty": len(with_bounties),
        "bounties_posted": len(bounties),
        "bounties_done_every_time_offered": len(finished),
        "bounties_with_unpaid_slots": len(bounties) - len(finished),
        "share_with_unpaid_slots": round((len(bounties) - len(finished)) / len(bounties), 3) if bounties else None,
        "daos_where_no_bounty_was_ever_finished": never,
    }
    print(json.dumps(summary, indent=2))
    with open(os.path.join(ROOT, "data", "bounties-summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
        f.write(chr(10))


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] != "report":
        fetch()
    report()
