#!/usr/bin/env python3
"""One-time memory deduplication for Cortex.
Usage: python3 dedup-memories.py [agent_id] [threshold] [--execute]
"""
import json, sys, urllib.request
from difflib import SequenceMatcher

API = "http://localhost:21100/api/v1"
TOKEN = "aji4545945"
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

agent = sys.argv[1] if len(sys.argv) > 1 else "openclaw"
threshold = float(sys.argv[2]) if len(sys.argv) > 2 else 0.80
execute = "--execute" in sys.argv

print(f"=== Cortex Memory Deduplication ===")
print(f"Agent: {agent}  Threshold: {threshold:.0%}  Mode: {'EXECUTE' if execute else 'DRY RUN'}")
print()

# Fetch all memories
req = urllib.request.Request(f"{API}/memories?agent_id={agent}&limit=1000", headers=HEADERS)
data = json.loads(urllib.request.urlopen(req).read())
memories = data["items"]
print(f"Total active memories: {data['total']}")

# Find near-duplicate pairs
pairs = []
removed_ids = set()

for i in range(len(memories)):
    if memories[i]["id"] in removed_ids:
        continue
    for j in range(i + 1, len(memories)):
        if memories[j]["id"] in removed_ids:
            continue
        a, b = memories[i], memories[j]
        la, lb = len(a["content"]), len(b["content"])
        if abs(la - lb) > max(la, lb) * 0.5:
            continue
        ratio = SequenceMatcher(None, a["content"], b["content"]).ratio()
        if ratio >= threshold:
            # Keep newer (usually more accurate), prefer higher importance
            if a["created_at"] >= b["created_at"]:
                keep, remove = a, b
            else:
                keep, remove = b, a
            if remove["importance"] > keep["importance"] + 0.1:
                keep, remove = remove, keep
            pairs.append((ratio, keep, remove))
            removed_ids.add(remove["id"])

pairs.sort(key=lambda x: -x[0])
print(f"Found {len(pairs)} duplicate pairs\n")

for ratio, keep, remove in pairs:
    print(f"  {ratio:.0%} similar")
    print(f"    KEEP   [{keep['category']}] imp={keep['importance']} {keep['content'][:70]}")
    print(f"    REMOVE [{remove['category']}] imp={remove['importance']} {remove['content'][:70]}")
    print()

if not execute:
    print(f"DRY RUN: {len(pairs)} memories would be removed. Add --execute to proceed.")
    sys.exit(0)

print(f"Executing {len(pairs)} deletions...")
ok = fail = 0
for _, keep, remove in pairs:
    try:
        req = urllib.request.Request(
            f"{API}/memories/{remove['id']}",
            headers={"Authorization": f"Bearer {TOKEN}"},
            method="DELETE",
        )
        urllib.request.urlopen(req)
        ok += 1
    except Exception as e:
        print(f"  FAIL: {remove['id']} → {e}")
        fail += 1

print(f"\nDone: {ok} removed, {fail} failed")
print(f"Remaining memories: ~{data['total'] - ok}")
