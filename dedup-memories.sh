#!/bin/bash
# One-time memory deduplication script for Cortex
# Finds near-duplicate memories and supersedes the older one
set -uo pipefail

API="http://localhost:21100/api/v1"
TOKEN="aji4545945"
AUTH="Authorization: Bearer $TOKEN"
CT="Content-Type: application/json"
AGENT="${1:-openclaw}"
THRESHOLD="${2:-0.80}"  # similarity threshold (0.80 = 80%)
DRY_RUN="${3:-true}"    # true = preview only, false = actually supersede

echo "=== Cortex Memory Deduplication ==="
echo "Agent: $AGENT"
echo "Threshold: $THRESHOLD"
echo "Dry run: $DRY_RUN"
echo ""

# Fetch all memories for this agent
MEMORIES=$(curl -sf "$API/memories?agent_id=$AGENT&limit=1000" -H "$AUTH" 2>/dev/null)
TOTAL=$(echo "$MEMORIES" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])")
echo "Total memories: $TOTAL"
echo ""

# Find duplicates and generate actions
python3 -c "
import json, sys
from difflib import SequenceMatcher
from datetime import datetime

data = json.loads('''$(echo "$MEMORIES" | python3 -c "import json,sys; json.dump(json.load(sys.stdin), sys.stdout)")''')
memories = data['items']
threshold = float('$THRESHOLD')
dry_run = '$DRY_RUN' == 'true'

# Find all near-duplicate pairs
pairs = []
seen_ids = set()

for i in range(len(memories)):
    for j in range(i+1, len(memories)):
        a = memories[i]
        b = memories[j]
        # Skip if either already marked for removal
        if a['id'] in seen_ids or b['id'] in seen_ids:
            continue
        # Quick length filter
        la, lb = len(a['content']), len(b['content'])
        if abs(la - lb) > max(la, lb) * 0.5:
            continue
        ratio = SequenceMatcher(None, a['content'], b['content']).ratio()
        if ratio >= threshold:
            # Keep the newer one (usually more accurate/updated)
            a_time = a.get('created_at', '')
            b_time = b.get('created_at', '')
            if a_time >= b_time:
                keep, remove = a, b
            else:
                keep, remove = b, a
            # If one has higher importance, prefer that
            if remove['importance'] > keep['importance'] + 0.1:
                keep, remove = remove, keep
            pairs.append((ratio, keep, remove))
            seen_ids.add(remove['id'])

pairs.sort(key=lambda x: -x[0])

print(f'Found {len(pairs)} duplicate pairs to merge')
print()

actions = []
for ratio, keep, remove in pairs:
    print(f'  {ratio:.0%} similar')
    print(f'    KEEP   [{keep[\"category\"]}] imp={keep[\"importance\"]} {keep[\"content\"][:70]}')
    print(f'    REMOVE [{remove[\"category\"]}] imp={remove[\"importance\"]} {remove[\"content\"][:70]}')
    print()
    actions.append({'keep': keep['id'], 'remove': remove['id']})

if dry_run:
    print(f'DRY RUN: {len(actions)} memories would be superseded. Run with dry_run=false to execute.')
else:
    print(f'Executing {len(actions)} supersede operations...')

# Output actions as JSON for the bash script to execute
with open('/tmp/dedup_actions.json', 'w') as f:
    json.dump({'actions': actions, 'dry_run': dry_run}, f)
"

if [ "$DRY_RUN" = "false" ]; then
  ACTIONS=$(python3 -c "import json; d=json.load(open('/tmp/dedup_actions.json')); print(len(d['actions']))")
  echo ""
  echo "Superseding $ACTIONS old memories..."

  OK=0
  FAIL=0
  python3 -c "
import json, urllib.request

actions = json.load(open('/tmp/dedup_actions.json'))['actions']
ok = 0
fail = 0

for a in actions:
    # Update the old memory: set superseded_by to the kept memory's ID
    req = urllib.request.Request(
        '$API/memories/' + a['remove'],
        data=json.dumps({'superseded_by': a['keep']}).encode(),
        headers={'Authorization': 'Bearer $TOKEN', 'Content-Type': 'application/json'},
        method='PATCH'
    )
    try:
        resp = urllib.request.urlopen(req)
        ok += 1
    except Exception as e:
        # Try DELETE as fallback
        try:
            req2 = urllib.request.Request(
                '$API/memories/' + a['remove'],
                headers={'Authorization': 'Bearer $TOKEN'},
                method='DELETE'
            )
            urllib.request.urlopen(req2)
            ok += 1
        except:
            print(f'  FAIL: {a[\"remove\"]} → {e}')
            fail += 1

print(f'Done: {ok} superseded, {fail} failed')
"
fi

rm -f /tmp/dedup_actions.json
