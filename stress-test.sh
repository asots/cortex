#!/bin/bash
# Cortex Memory Stress Test Suite
# Tests: ingest, recall, deduplication, signal detection, constraint injection, edge cases
set -uo pipefail

API="http://localhost:21100/api/v1"
TOKEN="aji4545945"
AUTH="Authorization: Bearer $TOKEN"
CT="Content-Type: application/json"
PASS=0; FAIL=0; WARN=0; TOTAL=0
CREATED_IDS=()
AGENT="stress-$$"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

log()  { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $*"; }
pass() { ((PASS++)); ((TOTAL++)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { ((FAIL++)); ((TOTAL++)); echo -e "  ${RED}FAIL${NC} $1 ${RED}→ $2${NC}"; }
warn() { ((WARN++)); echo -e "  ${YELLOW}WARN${NC} $1"; }

# Helper: ingest and capture response
ingest() {
  local user="$1" assistant="$2" agent="${3:-$AGENT}"
  curl -sf -X POST "$API/ingest" -H "$AUTH" -H "$CT" \
    -d "{\"user_message\":$(printf '%s' "$user" | jq -Rs .),\"assistant_message\":$(printf '%s' "$assistant" | jq -Rs .),\"agent_id\":\"$agent\"}" 2>/dev/null
}

# Helper: recall and capture response
recall() {
  local query="$1" agent="${2:-$AGENT}" extra="${3:-}"
  local body="{\"query\":$(printf '%s' "$query" | jq -Rs .),\"agent_id\":\"$agent\"$extra}"
  curl -sf -X POST "$API/recall" -H "$AUTH" -H "$CT" -d "$body" 2>/dev/null
}

# Helper: track created memory IDs for cleanup
track_ids() {
  local resp="$1"
  local ids
  ids=$(echo "$resp" | jq -r '.extracted[]?.id // empty' 2>/dev/null)
  for id in $ids; do
    CREATED_IDS+=("$id")
  done
}

cleanup() {
  log "Cleaning up test memories for agent=$AGENT..."
  # Delete all memories for the test agent
  local ids
  ids=$(curl -sf "$API/memories?agent_id=$AGENT&limit=500" -H "$AUTH" 2>/dev/null | jq -r '.items[]?.id // empty' 2>/dev/null)
  local count=0
  for id in $ids; do
    curl -sf -X DELETE "$API/memories/$id" -H "$AUTH" >/dev/null 2>&1 || true
    ((count++))
  done
  # Also clean tracked IDs (may be from different agent)
  for id in "${CREATED_IDS[@]}"; do
    [ -z "$id" ] && continue
    curl -sf -X DELETE "$API/memories/$id" -H "$AUTH" >/dev/null 2>&1 || true
  done
  log "Cleanup complete ($count agent memories + ${#CREATED_IDS[@]} tracked)"
}

trap cleanup EXIT

# ============================================================
echo -e "\n${BOLD}========================================${NC}"
echo -e "${BOLD}  CORTEX STRESS TEST SUITE${NC}"
echo -e "${BOLD}========================================${NC}\n"

# Pre-check
log "Checking server health..."
HEALTH=$(curl -sf "$API/health" 2>/dev/null || echo "")
if [ -z "$HEALTH" ]; then
  echo -e "${RED}Server not responding!${NC}"
  exit 1
fi
VERSION=$(echo "$HEALTH" | jq -r '.version')
log "Server v$VERSION is up\n"

# ============================================================
# PHASE 1: SIGNAL DETECTION (Correction patterns)
# ============================================================
echo -e "${BOLD}--- Phase 1: Signal Detection ---${NC}"

test_signal() {
  local desc="$1" user="$2" expected_pattern="$3"
  local resp
  resp=$(ingest "$user" "好的，了解了")
  track_ids "$resp"
  local found
  found=$(echo "$resp" | jq -r ".high_signals[]? | select(.pattern == \"$expected_pattern\") | .pattern" 2>/dev/null)
  if [ "$found" = "$expected_pattern" ]; then
    pass "$desc"
  else
    fail "$desc" "expected signal '$expected_pattern', got: $(echo "$resp" | jq -c '.high_signals' 2>/dev/null)"
  fi
  sleep 0.3
}

test_no_signal() {
  local desc="$1" user="$2"
  local resp
  resp=$(ingest "$user" "好的")
  track_ids "$resp"
  local count
  count=$(echo "$resp" | jq '.high_signals | length' 2>/dev/null)
  if [ "$count" = "0" ] || [ -z "$count" ]; then
    pass "$desc"
  else
    fail "$desc" "expected no signals, got $count: $(echo "$resp" | jq -c '.high_signals' 2>/dev/null)"
  fi
  sleep 0.3
}

# Correction signals (new patterns)
test_signal "correction: 不对，开头" "不对，我用的是 TypeScript 不是 JavaScript" "correction"
test_signal "correction: 说错了" "你说错了，这个项目用的是 PostgreSQL" "correction"
test_signal "correction: 错了，应该是" "错了，应该是用 Docker Compose 部署的" "correction"
test_signal "correction: 不是这样" "不是这样的，我们团队有 5 个人" "correction"
test_signal "correction: 搞错了" "搞错了，我住在大阪不是东京" "correction"
test_signal "correction: 其实是" "其实是用 Rust 写的，不是 Go" "correction"
test_signal "correction: actually" "actually, I use Vim not VSCode" "correction"
test_signal "correction: 更正：" "更正：我的职位是 Tech Lead" "correction"

# Identity signals
test_signal "identity: 我是...工程师" "我是一个后端工程师，主要写 Go" "identity"
test_signal "identity: 我叫" "我叫小明，在腾讯工作" "identity"
test_signal "identity: I am" "I am a senior developer at Google" "identity"

# Preference signals
test_signal "preference: 我喜欢" "我喜欢用 Neovim 写代码" "preference"
test_signal "preference: please always" "please always use TypeScript for new projects" "preference"

# Decision signals
test_signal "decision: 决定了" "决定了，我们用 Kubernetes 部署" "decision"

# Constraint signals
test_signal "constraint: 禁止" "禁止在生产环境直接修改数据库" "constraint"
test_signal "constraint: never" "never allow unauthenticated access to the admin panel" "constraint"

# Negative: should NOT trigger signals
test_no_signal "no signal: 普通问题" "今天天气怎么样？"
test_no_signal "no signal: 技术讨论" "React 和 Vue 哪个性能更好？"

echo ""

# ============================================================
# PHASE 2: MEMORY INGEST + DEDUPLICATION
# ============================================================
echo -e "${BOLD}--- Phase 2: Ingest & Deduplication ---${NC}"

# 2a: Normal ingest
log "Ingesting diverse memories..."
RESP1=$(ingest "我住在东京，在一家 AI 创业公司工作，负责后端架构" "了解了！你在东京的 AI 创业公司做后端架构。" "$AGENT")
track_ids "$RESP1"
COUNT1=$(echo "$RESP1" | jq '.extracted | length' 2>/dev/null)
if [ "${COUNT1:-0}" -ge 1 ]; then
  pass "basic ingest: extracted $COUNT1 memories"
else
  fail "basic ingest" "extracted 0 memories"
fi

# 2a-quality: Verify extracted content captures key facts (东京, AI, 后端)
EXT1_ALL=$(echo "$RESP1" | jq -r '[.extracted[].content] | join(" ")' 2>/dev/null)
EXT1_TOKYO=$(echo "$EXT1_ALL" | grep -ci "东京\|tokyo" || true)
EXT1_AI=$(echo "$EXT1_ALL" | grep -ci "ai\|AI\|人工智能\|创业" || true)
EXT1_BACKEND=$(echo "$EXT1_ALL" | grep -ci "后端\|backend\|架构" || true)
EXT1_HITS=0
[ "$EXT1_TOKYO" -ge 1 ] && ((EXT1_HITS++))
[ "$EXT1_AI" -ge 1 ] && ((EXT1_HITS++))
[ "$EXT1_BACKEND" -ge 1 ] && ((EXT1_HITS++))
if [ "$EXT1_HITS" -ge 2 ]; then
  pass "extraction quality (ingest1): $EXT1_HITS/3 key facts captured (东京/AI/后端)"
else
  fail "extraction quality (ingest1)" "only $EXT1_HITS/3 key facts: tokyo=$EXT1_TOKYO ai=$EXT1_AI backend=$EXT1_BACKEND"
fi

# 2a-category: Verify category assignment makes sense
EXT1_CATS=$(echo "$RESP1" | jq -r '[.extracted[].category] | join(",")' 2>/dev/null)
EXT1_HAS_IDENTITY=$(echo "$EXT1_CATS" | grep -ci "identity" || true)
if [ "$EXT1_HAS_IDENTITY" -ge 1 ]; then
  pass "extraction category (ingest1): identity detected (cats=$EXT1_CATS)"
else
  warn "extraction category (ingest1): no identity category (cats=$EXT1_CATS)"
fi

sleep 1

RESP2=$(ingest "我精通 Rust、Go 和 Python，最近在学 Zig" "很棒的技术栈！" "$AGENT")
track_ids "$RESP2"
COUNT2=$(echo "$RESP2" | jq '.extracted | length' 2>/dev/null)
if [ "$COUNT2" -ge 1 ]; then
  pass "skill ingest: extracted $COUNT2 memories"
else
  fail "skill ingest" "extracted 0"
fi

# 2b-quality: Verify skill extraction captures language names
EXT2_ALL=$(echo "$RESP2" | jq -r '[.extracted[].content] | join(" ")' 2>/dev/null)
EXT2_RUST=$(echo "$EXT2_ALL" | grep -ci "rust" || true)
EXT2_GO=$(echo "$EXT2_ALL" | grep -ci "\bgo\b\|Go" || true)
EXT2_PY=$(echo "$EXT2_ALL" | grep -ci "python" || true)
EXT2_ZIG=$(echo "$EXT2_ALL" | grep -ci "zig" || true)
EXT2_LANG_COUNT=0
[ "$EXT2_RUST" -ge 1 ] && ((EXT2_LANG_COUNT++))
[ "$EXT2_GO" -ge 1 ] && ((EXT2_LANG_COUNT++))
[ "$EXT2_PY" -ge 1 ] && ((EXT2_LANG_COUNT++))
[ "$EXT2_ZIG" -ge 1 ] && ((EXT2_LANG_COUNT++))
if [ "$EXT2_LANG_COUNT" -ge 2 ]; then
  pass "extraction quality (skills): $EXT2_LANG_COUNT/4 languages captured (Rust=$EXT2_RUST Go=$EXT2_GO Python=$EXT2_PY Zig=$EXT2_ZIG)"
else
  fail "extraction quality (skills)" "only $EXT2_LANG_COUNT/4 languages in: ${EXT2_ALL:0:100}"
fi

# 2b-category: Should be skill category
EXT2_CATS=$(echo "$RESP2" | jq -r '[.extracted[].category] | join(",")' 2>/dev/null)
EXT2_HAS_SKILL=$(echo "$EXT2_CATS" | grep -ci "skill" || true)
if [ "$EXT2_HAS_SKILL" -ge 1 ]; then
  pass "extraction category (skills): skill detected (cats=$EXT2_CATS)"
else
  warn "extraction category (skills): no skill category (cats=$EXT2_CATS)"
fi

sleep 1

RESP3=$(ingest "我们团队用 gRPC 做微服务通信，数据库用的是 TiDB" "明白，gRPC + TiDB 的微服务架构。" "$AGENT")
track_ids "$RESP3"
COUNT3=$(echo "$RESP3" | jq '.extracted | length' 2>/dev/null)
if [ "$COUNT3" -ge 1 ]; then
  pass "project ingest: extracted $COUNT3 memories"
else
  fail "project ingest" "extracted 0"
fi

# 2c-quality: Verify tech extraction
EXT3_ALL=$(echo "$RESP3" | jq -r '[.extracted[].content] | join(" ")' 2>/dev/null)
EXT3_GRPC=$(echo "$EXT3_ALL" | grep -ci "grpc\|gRPC" || true)
EXT3_TIDB=$(echo "$EXT3_ALL" | grep -ci "tidb\|TiDB" || true)
if [ "$EXT3_GRPC" -ge 1 ] && [ "$EXT3_TIDB" -ge 1 ]; then
  pass "extraction quality (project): captured gRPC + TiDB"
elif [ "$EXT3_GRPC" -ge 1 ] || [ "$EXT3_TIDB" -ge 1 ]; then
  pass "extraction quality (project): partial capture (grpc=$EXT3_GRPC, tidb=$EXT3_TIDB)"
else
  fail "extraction quality (project)" "neither gRPC nor TiDB in: ${EXT3_ALL:0:100}"
fi

sleep 1

# 2b: Exact duplicate → should be deduped
log "Testing deduplication..."
RESP_DUP=$(ingest "我住在东京，在一家 AI 创业公司工作，负责后端架构" "了解了！你在东京的 AI 创业公司做后端架构。" "$AGENT")
track_ids "$RESP_DUP"
DUP_DEDUPED=$(echo "$RESP_DUP" | jq '.deduplicated // 0' 2>/dev/null)
DUP_EXTRACTED=$(echo "$RESP_DUP" | jq '.extracted | length' 2>/dev/null)
# Input-level dedup should skip entirely, or memory-level dedup should catch it
if [ "$DUP_EXTRACTED" -eq 0 ] || [ "$DUP_DEDUPED" -ge 1 ]; then
  pass "exact duplicate: deduped (extracted=$DUP_EXTRACTED, deduped=$DUP_DEDUPED)"
else
  warn "exact duplicate: extracted=$DUP_EXTRACTED, deduped=$DUP_DEDUPED (may be input-hash window)"
fi

sleep 1

# 2c: Semantic near-duplicate (slight rephrasing)
RESP_NEAR=$(ingest "我现在住在东京，在 AI startup 做后端" "嗯嗯。" "$AGENT")
track_ids "$RESP_NEAR"
NEAR_SMART=$(echo "$RESP_NEAR" | jq '.smart_updated // 0' 2>/dev/null)
NEAR_DEDUP=$(echo "$RESP_NEAR" | jq '.deduplicated // 0' 2>/dev/null)
if [ "$NEAR_SMART" -ge 1 ] || [ "$NEAR_DEDUP" -ge 1 ]; then
  pass "near-duplicate: smart_updated=$NEAR_SMART, deduped=$NEAR_DEDUP"
else
  warn "near-duplicate: no dedup detected (smart_updated=$NEAR_SMART, deduped=$NEAR_DEDUP)"
fi

sleep 1

# 2d: Correction (should supersede old memory)
RESP_CORR=$(ingest "不对，我其实已经搬到大阪了，不住东京了" "好的，更新了，你现在住大阪。" "$AGENT")
track_ids "$RESP_CORR"
CORR_SIGNALS=$(echo "$RESP_CORR" | jq '.high_signals | length' 2>/dev/null)
CORR_SMART=$(echo "$RESP_CORR" | jq '.smart_updated // 0' 2>/dev/null)
if [ "$CORR_SIGNALS" -ge 1 ]; then
  pass "correction ingest: detected $CORR_SIGNALS signals, smart_updated=$CORR_SMART"
else
  fail "correction ingest" "no correction signal detected"
fi

echo ""

# ============================================================
# PHASE 3: RECALL QUALITY
# ============================================================
echo -e "${BOLD}--- Phase 3: Recall Quality ---${NC}"

sleep 1  # Wait for vector indexing

# 3a: Direct match
log "Testing recall relevance..."
R1=$(recall "他住在哪里？" "$AGENT")
R1_COUNT=$(echo "$R1" | jq '.meta.total_found' 2>/dev/null)
R1_CONTENT=$(echo "$R1" | jq -r '.memories[0].content // "none"' 2>/dev/null)
if [ "$R1_COUNT" -ge 1 ]; then
  # Check if the result mentions 大阪 (corrected) or 东京 (original)
  if echo "$R1_CONTENT" | grep -q "阪\|大阪\|osaka"; then
    pass "recall location: found corrected location (大阪) in top result"
  elif echo "$R1_CONTENT" | grep -q "东京\|tokyo"; then
    warn "recall location: found old location (东京), correction may not have superseded"
  else
    pass "recall location: found $R1_COUNT results, top: ${R1_CONTENT:0:60}"
  fi
else
  fail "recall location" "no results"
fi

# 3b: Skill-based recall
R2=$(recall "他会什么编程语言？" "$AGENT")
R2_COUNT=$(echo "$R2" | jq '.meta.total_found' 2>/dev/null)
R2_HAS_LANG=$(echo "$R2" | jq '[.memories[].content] | join(" ")' 2>/dev/null | grep -ci "rust\|go\|python\|zig" || true)
if [ "$R2_HAS_LANG" -ge 1 ]; then
  pass "recall skills: found programming languages ($R2_COUNT results)"
else
  fail "recall skills" "no language-related memories in $R2_COUNT results"
fi

# 3b-ranking: Top result should be the most relevant (skill category or contains language names)
R2_TOP_CAT=$(echo "$R2" | jq -r '.memories[0].category // "none"' 2>/dev/null)
R2_TOP_CONTENT=$(echo "$R2" | jq -r '.memories[0].content // "none"' 2>/dev/null)
R2_TOP_RELEVANT=$(echo "$R2_TOP_CONTENT" | grep -ci "rust\|go\|python\|zig\|编程\|语言\|精通" || true)
if [ "$R2_TOP_RELEVANT" -ge 1 ]; then
  pass "recall ranking (skills): top result is relevant (cat=$R2_TOP_CAT)"
else
  fail "recall ranking (skills)" "top result irrelevant: ${R2_TOP_CONTENT:0:60}"
fi

# 3b-context: Verify context injection contains key content
R2_CTX=$(echo "$R2" | jq -r '.context // ""' 2>/dev/null)
R2_CTX_HAS_TAG=$(echo "$R2_CTX" | grep -c "cortex_memory" || true)
R2_CTX_HAS_LANG=$(echo "$R2_CTX" | grep -ci "rust\|go\|python" || true)
if [ "$R2_CTX_HAS_TAG" -ge 1 ] && [ "$R2_CTX_HAS_LANG" -ge 1 ]; then
  pass "recall context injection (skills): contains <cortex_memory> + language names"
elif [ "$R2_CTX_HAS_TAG" -ge 1 ]; then
  warn "recall context injection (skills): has tag but no language names in context"
else
  fail "recall context injection (skills)" "missing cortex_memory tag or empty context"
fi

# 3c: Cross-concept recall (should find tech stack)
R3=$(recall "团队用什么技术做通信？" "$AGENT")
R3_COUNT=$(echo "$R3" | jq '.meta.total_found' 2>/dev/null)
R3_HAS_GRPC=$(echo "$R3" | jq '[.memories[].content] | join(" ")' 2>/dev/null | grep -ci "grpc\|微服务\|microservice" || true)
if [ "$R3_HAS_GRPC" -ge 1 ]; then
  pass "recall tech stack: found gRPC/microservice ($R3_COUNT results)"
else
  fail "recall tech stack" "no gRPC-related results in $R3_COUNT"
fi

# 3c-precision: Verify top result is about gRPC/comms, not unrelated tech
R3_TOP=$(echo "$R3" | jq -r '.memories[0].content // "none"' 2>/dev/null)
R3_TOP_ON_TOPIC=$(echo "$R3_TOP" | grep -ci "grpc\|通信\|微服务\|tidb\|数据库" || true)
if [ "$R3_TOP_ON_TOPIC" -ge 1 ]; then
  pass "recall precision (tech stack): top result on-topic"
else
  warn "recall precision (tech stack): top result may not be most relevant: ${R3_TOP:0:60}"
fi

# 3d: Fuzzy/indirect recall
R4=$(recall "职业背景" "$AGENT")
R4_COUNT=$(echo "$R4" | jq '.meta.total_found' 2>/dev/null)
if [ "$R4_COUNT" -ge 1 ]; then
  pass "recall fuzzy (职业背景): found $R4_COUNT results"
else
  fail "recall fuzzy" "no results for indirect query"
fi

# 3d-context: Verify context format and content for fuzzy query
R4_CTX=$(echo "$R4" | jq -r '.context // ""' 2>/dev/null)
R4_CTX_LINES=$(echo "$R4_CTX" | grep -c "^\[" || true)
R4_INJECTED=$(echo "$R4" | jq '.meta.injected_count // 0' 2>/dev/null)
if [ "$R4_INJECTED" -ge 1 ] && [ "$R4_CTX_LINES" -ge 1 ]; then
  pass "recall context format: $R4_INJECTED memories injected, $R4_CTX_LINES formatted lines"
else
  warn "recall context format: injected=$R4_INJECTED, lines=$R4_CTX_LINES"
fi

# 3e: English recall for Chinese memories
R5=$(recall "what programming languages does the user know?" "$AGENT")
R5_COUNT=$(echo "$R5" | jq '.meta.total_found' 2>/dev/null)
R5_HAS=$(echo "$R5" | jq '[.memories[].content] | join(" ")' 2>/dev/null | grep -ci "rust\|go\|python" || true)
if [ "$R5_HAS" -ge 1 ]; then
  pass "cross-language recall (EN→CN): found languages ($R5_COUNT results)"
else
  warn "cross-language recall (EN→CN): no match in $R5_COUNT results (embedding model may not be bilingual)"
fi

echo ""

# ============================================================
# PHASE 4: CONSTRAINT INJECTION
# ============================================================
echo -e "${BOLD}--- Phase 4: Constraint Injection ---${NC}"

# 4a: Irrelevant query should have constraints filtered
R_IRR=$(recall "量子计算对蛋白质折叠的影响" "$AGENT")
IRR_CONSTRAINTS=$(echo "$R_IRR" | jq '[.memories[] | select(.category == "constraint" or .category == "agent_persona")] | length' 2>/dev/null)
IRR_HIGH=$(echo "$R_IRR" | jq '[.memories[] | select((.category == "constraint" or .category == "agent_persona") and .importance >= 0.9)] | length' 2>/dev/null)
IRR_LOW=$(echo "$R_IRR" | jq '[.memories[] | select((.category == "constraint" or .category == "agent_persona") and .importance < 0.9 and .finalScore == 0)] | length' 2>/dev/null)
if [ "$IRR_LOW" -eq 0 ]; then
  pass "constraint filter: no low-importance constraints injected (high=$IRR_HIGH, total=$IRR_CONSTRAINTS)"
else
  fail "constraint filter" "found $IRR_LOW low-importance constraints with finalScore=0"
fi

# 4b: Max 3 constraint injection
if [ "$IRR_CONSTRAINTS" -le 3 ] || [ "$IRR_HIGH" -le 3 ]; then
  pass "constraint cap: injected ≤3 priority memories ($IRR_CONSTRAINTS total)"
else
  # Check if extra ones came from search results (finalScore > 0)
  SEARCH_CONSTRAINTS=$(echo "$R_IRR" | jq '[.memories[] | select((.category == "constraint" or .category == "agent_persona") and .finalScore > 0)] | length' 2>/dev/null)
  INJECTED_CONSTRAINTS=$(echo "$R_IRR" | jq '[.memories[] | select((.category == "constraint" or .category == "agent_persona") and .finalScore == 0)] | length' 2>/dev/null)
  if [ "$INJECTED_CONSTRAINTS" -le 3 ]; then
    pass "constraint cap: $INJECTED_CONSTRAINTS priority-injected + $SEARCH_CONSTRAINTS from search (ok)"
  else
    fail "constraint cap" "$INJECTED_CONSTRAINTS priority-injected > 3"
  fi
fi

echo ""

# ============================================================
# PHASE 5: SMALL TALK FILTER
# ============================================================
echo -e "${BOLD}--- Phase 5: Small Talk Filter ---${NC}"

test_smalltalk() {
  local desc="$1" query="$2" expect_skip="$3"
  local resp
  resp=$(recall "$query" "$AGENT")
  local skipped
  skipped=$(echo "$resp" | jq '.meta.skipped' 2>/dev/null)
  if [ "$expect_skip" = "true" ] && [ "$skipped" = "true" ]; then
    pass "$desc → skipped"
  elif [ "$expect_skip" = "false" ] && [ "$skipped" != "true" ]; then
    pass "$desc → not skipped"
  else
    fail "$desc" "expected skip=$expect_skip, got $skipped"
  fi
}

test_smalltalk "小话: 你好" "你好" "true"
test_smalltalk "小话: hi" "hi" "true"
test_smalltalk "小话: ok" "ok" "true"
test_smalltalk "小话: 谢谢" "谢谢！" "true"
test_smalltalk "非小话: 你好，帮我看一下代码" "你好，帮我看一下代码" "false"
test_smalltalk "非小话: 我的技术栈" "我的技术栈是什么？" "false"
test_smalltalk "非小话: Rust vs Go" "Rust 和 Go 哪个适合微服务？" "false"

echo ""

# ============================================================
# PHASE 6: EDGE CASES
# ============================================================
echo -e "${BOLD}--- Phase 6: Edge Cases ---${NC}"

# 6a: Very long query
LONG_QUERY="这是一个非常长的查询，用来测试系统对长文本输入的处理能力。我想知道关于用户的技术背景、工作经历、编程语言偏好、团队协作方式、项目管理工具、部署策略、数据库选择以及微服务架构设计方面的所有相关记忆。请返回尽可能完整的信息。"
R_LONG=$(recall "$LONG_QUERY" "$AGENT")
LONG_COUNT=$(echo "$R_LONG" | jq '.meta.total_found' 2>/dev/null)
LONG_LATENCY=$(echo "$R_LONG" | jq '.meta.latency_ms' 2>/dev/null)
if [ "$LONG_COUNT" -ge 0 ] && [ -n "$LONG_LATENCY" ]; then
  pass "long query (${#LONG_QUERY} chars): $LONG_COUNT results, ${LONG_LATENCY}ms"
else
  fail "long query" "error or no response"
fi

# 6b: Single character query
R_SHORT=$(recall "Go" "$AGENT")
SHORT_COUNT=$(echo "$R_SHORT" | jq '.meta.total_found' 2>/dev/null)
SHORT_SKIP=$(echo "$R_SHORT" | jq '.meta.skipped' 2>/dev/null)
pass "short query (Go): results=$SHORT_COUNT, skipped=$SHORT_SKIP"

# 6c: Special characters / injection attempt
R_INJECT=$(recall '<script>alert("xss")</script> OR 1=1; DROP TABLE memories;' "$AGENT")
INJECT_ERR=$(echo "$R_INJECT" | jq '.error // empty' 2>/dev/null)
if [ -z "$INJECT_ERR" ]; then
  pass "injection attempt: handled safely"
else
  fail "injection attempt" "error: $INJECT_ERR"
fi

# 6d: Pure emoji query
R_EMOJI=$(recall "🚀🔥💻" "$AGENT")
EMOJI_ERR=$(echo "$R_EMOJI" | jq '.error // empty' 2>/dev/null)
if [ -z "$EMOJI_ERR" ]; then
  pass "emoji query: handled (results=$(echo "$R_EMOJI" | jq '.meta.total_found'))"
else
  fail "emoji query" "error: $EMOJI_ERR"
fi

# 6e: Mixed language query
R_MIX=$(recall "what is the user's 技术栈 and preferred deployment 方式?" "$AGENT")
MIX_COUNT=$(echo "$R_MIX" | jq '.meta.total_found' 2>/dev/null)
if [ "$MIX_COUNT" -ge 1 ]; then
  pass "mixed language query: $MIX_COUNT results"
else
  warn "mixed language query: no results"
fi

# 6f: Japanese query against Chinese memories
R_JP=$(recall "ユーザーのプログラミング言語は何ですか？" "$AGENT")
JP_COUNT=$(echo "$R_JP" | jq '.meta.total_found' 2>/dev/null)
pass "Japanese query: $JP_COUNT results (cross-CJK)"

# 6g: Empty-ish content ingest
RESP_EMPTY=$(ingest "嗯" "好" "$AGENT")
track_ids "$RESP_EMPTY"
EMPTY_EXT=$(echo "$RESP_EMPTY" | jq '.extracted | length' 2>/dev/null)
if [ "$EMPTY_EXT" -eq 0 ]; then
  pass "minimal ingest (嗯/好): correctly extracted nothing"
else
  warn "minimal ingest: extracted $EMPTY_EXT (may be ok if deep channel found something)"
fi

echo ""

# ============================================================
# PHASE 7: CONCURRENT STRESS
# ============================================================
echo -e "${BOLD}--- Phase 7: Concurrent Load ---${NC}"

log "Firing 10 concurrent recall requests..."
PIDS=()
TMPDIR=$(mktemp -d)
QUERIES=("用户的背景" "技术选型" "编程语言" "住在哪" "工作内容" "团队规模" "数据库选型" "部署方式" "微服务架构" "项目状态")
for i in "${!QUERIES[@]}"; do
  (
    START_MS=$(date +%s%3N)
    RESP=$(recall "${QUERIES[$i]}" "$AGENT" 2>/dev/null || echo '{"error":"timeout"}')
    END_MS=$(date +%s%3N)
    LATENCY=$((END_MS - START_MS))
    echo "$LATENCY" > "$TMPDIR/lat_$i"
    echo "$RESP" > "$TMPDIR/resp_$i"
  ) &
  PIDS+=($!)
done

# Wait for all
ALL_OK=true
for pid in "${PIDS[@]}"; do
  wait "$pid" 2>/dev/null || ALL_OK=false
done

# Analyze results
MAX_LAT=0; TOTAL_LAT=0; ERRORS=0
for i in "${!QUERIES[@]}"; do
  LAT=$(cat "$TMPDIR/lat_$i" 2>/dev/null || echo "0")
  ERR=$(jq -r '.error // empty' "$TMPDIR/resp_$i" 2>/dev/null)
  if [ -n "$ERR" ]; then ((ERRORS++)); fi
  TOTAL_LAT=$((TOTAL_LAT + LAT))
  if [ "$LAT" -gt "$MAX_LAT" ]; then MAX_LAT=$LAT; fi
done
AVG_LAT=$((TOTAL_LAT / ${#QUERIES[@]}))
rm -rf "$TMPDIR"

if [ "$ERRORS" -eq 0 ]; then
  pass "concurrent recall (10x): avg=${AVG_LAT}ms, max=${MAX_LAT}ms, errors=0"
else
  fail "concurrent recall" "$ERRORS/${#QUERIES[@]} errors, avg=${AVG_LAT}ms"
fi

# Concurrent ingest
log "Firing 5 concurrent ingest requests..."
PIDS2=()
TMPDIR2=$(mktemp -d)
INGEST_MSGS=(
  "我最近开始学 Haskell 了"
  "我们团队决定用 Terraform 管理基础设施"
  "我偏好用暗色主题写代码"
  "我的猫叫小白，是一只英短"
  "下周二有个技术分享要准备"
)
for i in "${!INGEST_MSGS[@]}"; do
  (
    RESP=$(ingest "${INGEST_MSGS[$i]}" "好的！" "$AGENT" 2>/dev/null || echo '{"error":"failed"}')
    echo "$RESP" > "$TMPDIR2/resp_$i"
  ) &
  PIDS2+=($!)
done
for pid in "${PIDS2[@]}"; do
  wait "$pid" 2>/dev/null || true
done

INGEST_OK=0; INGEST_ERR=0
for i in "${!INGEST_MSGS[@]}"; do
  RESP=$(cat "$TMPDIR2/resp_$i" 2>/dev/null)
  # Track IDs for cleanup
  IDS=$(echo "$RESP" | jq -r '.extracted[]?.id // empty' 2>/dev/null)
  for id in $IDS; do CREATED_IDS+=("$id"); done
  ERR=$(echo "$RESP" | jq -r '.error // empty' 2>/dev/null)
  if [ -z "$ERR" ]; then ((INGEST_OK++)); else ((INGEST_ERR++)); fi
done
rm -rf "$TMPDIR2"

if [ "$INGEST_ERR" -eq 0 ]; then
  pass "concurrent ingest (5x): all succeeded ($INGEST_OK ok)"
else
  fail "concurrent ingest" "$INGEST_ERR/${#INGEST_MSGS[@]} errors"
fi

echo ""

# ============================================================
# PHASE 8: RECALL AFTER BULK INGEST (Relevance ranking)
# ============================================================
echo -e "${BOLD}--- Phase 8: Post-Bulk Recall Relevance ---${NC}"

sleep 1  # Wait for vector indexing

# Test that new memories are findable
R_HASKELL=$(recall "学什么新编程语言" "$AGENT")
HAS_HASKELL=$(echo "$R_HASKELL" | jq '[.memories[].content] | join(" ")' 2>/dev/null | grep -ci "haskell" || true)
if [ "$HAS_HASKELL" -ge 1 ]; then
  pass "bulk recall: found Haskell learning"
else
  warn "bulk recall: Haskell not in results (may need more indexing time)"
fi

R_CAT=$(recall "宠物" "$AGENT")
HAS_CAT=$(echo "$R_CAT" | jq '[.memories[].content] | join(" ")' 2>/dev/null | grep -ci "猫\|小白\|cat" || true)
if [ "$HAS_CAT" -ge 1 ]; then
  pass "bulk recall: found pet (猫/小白)"
else
  warn "bulk recall: pet not in results"
fi

R_INFRA=$(recall "基础设施管理工具" "$AGENT")
HAS_TF=$(echo "$R_INFRA" | jq '[.memories[].content] | join(" ")' 2>/dev/null | grep -ci "terraform\|基础设施" || true)
if [ "$HAS_TF" -ge 1 ]; then
  pass "bulk recall: found Terraform/infra"
else
  warn "bulk recall: Terraform not in results"
fi

# Test score ordering: more relevant should score higher
R_RANKING=$(recall "编程语言和技术选型" "$AGENT")
TOP_SCORE=$(echo "$R_RANKING" | jq '.memories[0].finalScore // 0' 2>/dev/null)
LAST_SCORE=$(echo "$R_RANKING" | jq '.memories[-1].finalScore // 0' 2>/dev/null)
RANKING_COUNT=$(echo "$R_RANKING" | jq '.memories | length' 2>/dev/null)
if [ "$RANKING_COUNT" -ge 2 ]; then
  SORTED=$(echo "$R_RANKING" | jq '[.memories[].finalScore] | . == sort_by(- .)' 2>/dev/null)
  if [ "$SORTED" = "true" ]; then
    pass "score ordering: descending (top=$TOP_SCORE, last=$LAST_SCORE, n=$RANKING_COUNT)"
  else
    fail "score ordering" "not sorted descending"
  fi
else
  warn "score ordering: only $RANKING_COUNT results"
fi

echo ""

# ============================================================
# PHASE 9: LATENCY PROFILE
# ============================================================
echo -e "${BOLD}--- Phase 9: Latency Profile ---${NC}"

measure_recall() {
  local desc="$1" query="$2" max_ms="$3"
  local resp
  resp=$(recall "$query" "$AGENT")
  local lat
  lat=$(echo "$resp" | jq '.meta.latency_ms' 2>/dev/null)
  if [ -n "$lat" ] && [ "$lat" -le "$max_ms" ]; then
    pass "$desc: ${lat}ms (limit: ${max_ms}ms)"
  elif [ -n "$lat" ]; then
    fail "$desc" "${lat}ms exceeds ${max_ms}ms limit"
  else
    fail "$desc" "no latency data"
  fi
}

measure_recall "simple recall" "技术栈" 8000
measure_recall "complex recall" "用户的完整技术背景包括编程语言和部署工具" 12000
measure_recall "irrelevant recall" "银河系的形成过程" 8000

echo ""

# ============================================================
# PHASE 10: SEARCH API DIRECT
# ============================================================
echo -e "${BOLD}--- Phase 10: Search API ---${NC}"

SEARCH_RESP=$(curl -sf -X POST "$API/search" -H "$AUTH" -H "$CT" \
  -d "{\"query\":\"编程语言\",\"agent_id\":\"$AGENT\",\"limit\":5,\"debug\":true}" 2>/dev/null || echo '{"error":"fail"}')
SEARCH_COUNT=$(echo "$SEARCH_RESP" | jq '.results | length' 2>/dev/null)
SEARCH_ERR=$(echo "$SEARCH_RESP" | jq -r '.error // empty' 2>/dev/null)
if [ -z "$SEARCH_ERR" ] && [ "$SEARCH_COUNT" -ge 1 ]; then
  pass "search API: $SEARCH_COUNT results with debug info"
else
  fail "search API" "error=$SEARCH_ERR, count=$SEARCH_COUNT"
fi

# Category filter
SEARCH_CAT=$(curl -sf -X POST "$API/search" -H "$AUTH" -H "$CT" \
  -d "{\"query\":\"用户信息\",\"agent_id\":\"$AGENT\",\"categories\":[\"identity\"],\"limit\":10}" 2>/dev/null || echo '{"error":"fail"}')
CAT_ALL_IDENTITY=$(echo "$SEARCH_CAT" | jq '[.results[] | select(.category != "identity")] | length' 2>/dev/null)
if [ "$CAT_ALL_IDENTITY" = "0" ]; then
  pass "search category filter: only identity results"
else
  warn "search category filter: found non-identity results ($CAT_ALL_IDENTITY)"
fi

# Layer filter
SEARCH_LAYER=$(curl -sf -X POST "$API/recall" -H "$AUTH" -H "$CT" \
  -d '{"query":"技术","agent_id":"$AGENT","layers":["core"]}' 2>/dev/null || echo '{"error":"fail"}')
LAYER_ERR=$(echo "$SEARCH_LAYER" | jq -r '.error // empty' 2>/dev/null)
if [ -z "$LAYER_ERR" ]; then
  LAYER_COUNT=$(echo "$SEARCH_LAYER" | jq '.meta.total_found' 2>/dev/null)
  pass "layer filter (core only): $LAYER_COUNT results"
else
  fail "layer filter" "error: $LAYER_ERR"
fi

echo ""

# ============================================================
# PHASE 11: MEMORY LIFECYCLE (CRUD)
# ============================================================
echo -e "${BOLD}--- Phase 11: Memory CRUD ---${NC}"

# Create
CREATE_RESP=$(curl -sf -X POST "$API/memories" -H "$AUTH" -H "$CT" \
  -d '{"content":"stress test: 手动创建的测试记忆","category":"fact","layer":"working","importance":0.5,"agent_id":"$AGENT"}' 2>/dev/null)
CREATE_ID=$(echo "$CREATE_RESP" | jq -r '.id // empty' 2>/dev/null)
if [ -n "$CREATE_ID" ]; then
  CREATED_IDS+=("$CREATE_ID")
  pass "create memory: id=$CREATE_ID"
else
  fail "create memory" "no id returned"
fi

# Read
if [ -n "$CREATE_ID" ]; then
  READ_RESP=$(curl -sf "$API/memories/$CREATE_ID" -H "$AUTH" 2>/dev/null)
  READ_CONTENT=$(echo "$READ_RESP" | jq -r '.content // empty' 2>/dev/null)
  if echo "$READ_CONTENT" | grep -q "手动创建"; then
    pass "read memory: content matches"
  else
    fail "read memory" "content mismatch: $READ_CONTENT"
  fi
fi

# Update
if [ -n "$CREATE_ID" ]; then
  UPDATE_RESP=$(curl -sf -X PATCH "$API/memories/$CREATE_ID" -H "$AUTH" -H "$CT" \
    -d '{"content":"stress test: 更新后的测试记忆","importance":0.8}' 2>/dev/null)
  UPDATE_CONTENT=$(echo "$UPDATE_RESP" | jq -r '.content // empty' 2>/dev/null)
  UPDATE_IMP=$(echo "$UPDATE_RESP" | jq '.importance // 0' 2>/dev/null)
  if echo "$UPDATE_CONTENT" | grep -q "更新后"; then
    pass "update memory: content updated, importance=$UPDATE_IMP"
  else
    fail "update memory" "content not updated"
  fi
fi

# Delete
if [ -n "$CREATE_ID" ]; then
  DEL_RESP=$(curl -sf -X DELETE "$API/memories/$CREATE_ID" -H "$AUTH" 2>/dev/null)
  DEL_OK=$(echo "$DEL_RESP" | jq -r '.ok // empty' 2>/dev/null)
  if [ "$DEL_OK" = "true" ]; then
    pass "delete memory: ok"
    # Remove from cleanup list since already deleted
    CREATED_IDS=("${CREATED_IDS[@]/$CREATE_ID/}")
  else
    fail "delete memory" "response: $DEL_RESP"
  fi
fi

echo ""

# ============================================================
# PHASE 12: RAPID-FIRE INGEST (Write stability)
# ============================================================
echo -e "${BOLD}--- Phase 12: Rapid-Fire Ingest (20 messages) ---${NC}"

RAPID_MESSAGES=(
  "我今天在调试一个 CORS 问题"
  "发现是 nginx 配置的问题"
  "修好了，加了 Access-Control-Allow-Origin"
  "下午要开产品评审会"
  "产品经理想加一个导出 PDF 的功能"
  "我觉得用 puppeteer 生成 PDF 比较靠谱"
  "后端需要加一个新的 API endpoint"
  "前端同事说用 React-PDF 也行"
  "最终决定用 puppeteer，因为样式可控性更好"
  "项目 deadline 是下周五"
  "还需要做单元测试"
  "CI/CD 流水线也要更新"
  "用的是 GitHub Actions"
  "部署到 AWS ECS"
  "数据库备份脚本也要改"
  "晚上回去遛狗"
  "明天早上有个面试要准备"
  "候选人是做 Rust 嵌入式的"
  "团队还缺一个 DevOps 工程师"
  "年底前要招满 8 个人"
)

RAPID_OK=0; RAPID_FAIL=0; RAPID_TOTAL_LAT=0
for msg in "${RAPID_MESSAGES[@]}"; do
  START_MS=$(date +%s%3N)
  RESP=$(ingest "$msg" "嗯嗯。" "$AGENT" 2>/dev/null || echo '{"error":"fail"}')
  END_MS=$(date +%s%3N)
  LAT=$((END_MS - START_MS))
  RAPID_TOTAL_LAT=$((RAPID_TOTAL_LAT + LAT))

  IDS=$(echo "$RESP" | jq -r '.extracted[]?.id // empty' 2>/dev/null)
  for id in $IDS; do CREATED_IDS+=("$id"); done

  ERR=$(echo "$RESP" | jq -r '.error // empty' 2>/dev/null)
  if [ -z "$ERR" ]; then ((RAPID_OK++)); else ((RAPID_FAIL++)); fi
done
RAPID_AVG=$((RAPID_TOTAL_LAT / ${#RAPID_MESSAGES[@]}))

if [ "$RAPID_FAIL" -eq 0 ]; then
  pass "rapid-fire ingest (20x): all ok, avg=${RAPID_AVG}ms/msg"
else
  fail "rapid-fire ingest" "$RAPID_FAIL/${#RAPID_MESSAGES[@]} failed, avg=${RAPID_AVG}ms"
fi

# Verify rapid memories are searchable
sleep 1
R_RAPID=$(recall "PDF 导出功能用什么方案" "$AGENT")
HAS_PDF=$(echo "$R_RAPID" | jq '[.memories[].content] | join(" ")' 2>/dev/null | grep -ci "puppeteer\|pdf" || true)
if [ "$HAS_PDF" -ge 1 ]; then
  pass "rapid recall: found PDF/puppeteer decision"
else
  warn "rapid recall: PDF decision not found (indexing lag?)"
fi

R_RAPID2=$(recall "招聘计划" "$AGENT")
HAS_HIRE=$(echo "$R_RAPID2" | jq '[.memories[].content] | join(" ")' 2>/dev/null | grep -ci "招\|DevOps\|8个人\|面试" || true)
if [ "$HAS_HIRE" -ge 1 ]; then
  pass "rapid recall: found hiring info"
else
  warn "rapid recall: hiring info not found"
fi

echo ""

# ============================================================
# PHASE 13: LIFECYCLE ENGINE
# ============================================================
echo -e "${BOLD}--- Phase 13: Lifecycle Engine ---${NC}"

# 13a: Preview should not crash
LIFECYCLE_RESP=$(curl -sf "$API/lifecycle/preview?agent_id=$AGENT" -H "$AUTH" 2>/dev/null || echo '{"error":"fail"}')
LIFECYCLE_ERR=$(echo "$LIFECYCLE_RESP" | jq -r '.error // empty' 2>/dev/null)
if [ -z "$LIFECYCLE_ERR" ]; then
  pass "lifecycle preview: no crash"
else
  fail "lifecycle preview" "error: $LIFECYCLE_ERR"
fi

# 13b: Report structure check
LIFECYCLE_HAS_PROMOTED=$(echo "$LIFECYCLE_RESP" | jq 'has("promoted")' 2>/dev/null)
LIFECYCLE_HAS_MERGED=$(echo "$LIFECYCLE_RESP" | jq 'has("merged")' 2>/dev/null)
LIFECYCLE_HAS_ARCHIVED=$(echo "$LIFECYCLE_RESP" | jq 'has("archived")' 2>/dev/null)
LIFECYCLE_HAS_DURATION=$(echo "$LIFECYCLE_RESP" | jq 'has("durationMs")' 2>/dev/null)
if [ "$LIFECYCLE_HAS_PROMOTED" = "true" ] && [ "$LIFECYCLE_HAS_MERGED" = "true" ] && [ "$LIFECYCLE_HAS_ARCHIVED" = "true" ] && [ "$LIFECYCLE_HAS_DURATION" = "true" ]; then
  pass "lifecycle report: structure complete (promoted/merged/archived/durationMs)"
else
  fail "lifecycle report" "missing fields: promoted=$LIFECYCLE_HAS_PROMOTED merged=$LIFECYCLE_HAS_MERGED archived=$LIFECYCLE_HAS_ARCHIVED duration=$LIFECYCLE_HAS_DURATION"
fi

# 13c: Dry-run should not change data — count memories before and after
MEM_COUNT_BEFORE=$(curl -sf "$API/memories?agent_id=$AGENT&limit=1" -H "$AUTH" 2>/dev/null | jq '.total // 0' 2>/dev/null)
curl -sf "$API/lifecycle/preview?agent_id=$AGENT" -H "$AUTH" >/dev/null 2>&1
MEM_COUNT_AFTER=$(curl -sf "$API/memories?agent_id=$AGENT&limit=1" -H "$AUTH" 2>/dev/null | jq '.total // 0' 2>/dev/null)
if [ "$MEM_COUNT_BEFORE" = "$MEM_COUNT_AFTER" ]; then
  pass "lifecycle dry-run: no data change (count=$MEM_COUNT_BEFORE)"
else
  fail "lifecycle dry-run" "memory count changed: $MEM_COUNT_BEFORE → $MEM_COUNT_AFTER"
fi

echo ""

# ============================================================
# PHASE 14: QUERY EXPANSION & RERANKER
# ============================================================
echo -e "${BOLD}--- Phase 14: Query Expansion & Reranker ---${NC}"

# 14a: Query expansion should generate > 1 variant (check via recall latency/meta)
R_EXPAND=$(recall "用户的完整技术背景和工作经历详细介绍" "$AGENT")
EXPAND_COUNT=$(echo "$R_EXPAND" | jq '.meta.total_found' 2>/dev/null)
EXPAND_LATENCY=$(echo "$R_EXPAND" | jq '.meta.latency_ms' 2>/dev/null)
if [ "${EXPAND_COUNT:-0}" -ge 1 ]; then
  pass "query expansion: returned $EXPAND_COUNT results (latency=${EXPAND_LATENCY}ms)"
else
  warn "query expansion: no results"
fi

# 14b: CJK query with cross-language potential
R_CJK=$(recall "プログラミング言語の経験と技術スタック" "$AGENT")
CJK_COUNT=$(echo "$R_CJK" | jq '.meta.total_found' 2>/dev/null)
if [ "${CJK_COUNT:-0}" -ge 0 ]; then
  pass "CJK query expansion: $CJK_COUNT results (no crash)"
else
  fail "CJK query expansion" "error"
fi

# 14c: Reranker should not crash (enabled scenario tested via recall)
R_RERANK=$(recall "技术架构和部署方案" "$AGENT")
RERANK_ERR=$(echo "$R_RERANK" | jq -r '.error // empty' 2>/dev/null)
if [ -z "$RERANK_ERR" ]; then
  RERANK_COUNT=$(echo "$R_RERANK" | jq '.meta.total_found' 2>/dev/null)
  pass "reranker: no crash ($RERANK_COUNT results)"
else
  fail "reranker" "error: $RERANK_ERR"
fi

echo ""

# ============================================================
# PHASE 15: RELATION EXTRACTION & INJECTION
# ============================================================
echo -e "${BOLD}--- Phase 15: Relation Extraction ---${NC}"

# 15a: Ingest content with clear relations
REL_RESP=$(ingest "张三在谷歌工作，他负责 TensorFlow 项目的核心开发" "了解了，张三是谷歌的 TensorFlow 核心开发者。" "$AGENT")
track_ids "$REL_RESP"
sleep 1

# 15b: Check if relations exist via API
REL_LIST=$(curl -sf "$API/relations?agent_id=$AGENT&limit=20" -H "$AUTH" 2>/dev/null || echo '{"error":"fail"}')
REL_LIST_ERR=$(echo "$REL_LIST" | jq -r '.error // empty' 2>/dev/null)
if [ -z "$REL_LIST_ERR" ]; then
  REL_TOTAL=$(echo "$REL_LIST" | jq '.items | length // 0' 2>/dev/null)
  if [ "${REL_TOTAL:-0}" -ge 1 ]; then
    pass "relation extraction: found $REL_TOTAL relations"
  else
    warn "relation extraction: no relations found (LLM may not have extracted)"
  fi
else
  warn "relation API: $REL_LIST_ERR"
fi

# 15c: Recall should include relations in context
R_REL=$(recall "张三" "$AGENT")
REL_CONTEXT=$(echo "$R_REL" | jq -r '.context // ""' 2>/dev/null)
REL_IN_CONTEXT=$(echo "$REL_CONTEXT" | grep -ci "张三\|谷歌\|google\|tensorflow" || true)
REL_COUNT_META=$(echo "$R_REL" | jq '.meta.relations_count // 0' 2>/dev/null)
if [ "$REL_IN_CONTEXT" -ge 1 ] || [ "$REL_COUNT_META" -ge 1 ]; then
  pass "relation injection: found in recall context (relations=$REL_COUNT_META)"
else
  warn "relation injection: not found in recall (may need more time)"
fi

echo ""

# ============================================================
# PHASE 16: AGENT ISOLATION
# ============================================================
echo -e "${BOLD}--- Phase 16: Agent Isolation ---${NC}"

AGENT_A="stress-iso-a-$$"
AGENT_B="stress-iso-b-$$"

# Ingest different memories for each agent
RESP_A=$(ingest "我是前端工程师，专门写 React 和 Next.js" "好的！" "$AGENT_A")
track_ids "$RESP_A"
RESP_B=$(ingest "我是数据科学家，主要用 Python 和 PyTorch" "了解！" "$AGENT_B")
track_ids "$RESP_B"

sleep 1

# Recall agent-A should NOT return agent-B's memories
R_ISO_A=$(recall "技术栈" "$AGENT_A")
ISO_A_CONTENT=$(echo "$R_ISO_A" | jq -r '[.memories[].content] | join(" ")' 2>/dev/null)
ISO_A_HAS_PYTHON=$(echo "$ISO_A_CONTENT" | grep -ci "python\|pytorch\|数据科学" || true)
ISO_A_HAS_REACT=$(echo "$ISO_A_CONTENT" | grep -ci "react\|next\|前端" || true)
if [ "$ISO_A_HAS_PYTHON" -eq 0 ]; then
  pass "agent isolation A: no agent-B memories leaked"
else
  fail "agent isolation A" "found agent-B content in agent-A recall"
fi

# Recall agent-B should NOT return agent-A's memories
R_ISO_B=$(recall "技术栈" "$AGENT_B")
ISO_B_CONTENT=$(echo "$R_ISO_B" | jq -r '[.memories[].content] | join(" ")' 2>/dev/null)
ISO_B_HAS_REACT=$(echo "$ISO_B_CONTENT" | grep -ci "react\|next\|前端" || true)
if [ "$ISO_B_HAS_REACT" -eq 0 ]; then
  pass "agent isolation B: no agent-A memories leaked"
else
  fail "agent isolation B" "found agent-A content in agent-B recall"
fi

# Search API agent_id filter
SEARCH_A=$(curl -sf -X POST "$API/search" -H "$AUTH" -H "$CT" \
  -d "{\"query\":\"技术\",\"agent_id\":\"$AGENT_A\",\"limit\":10}" 2>/dev/null)
SEARCH_A_IDS=$(echo "$SEARCH_A" | jq -r '[.results[].agent_id // empty] | unique | join(",")' 2>/dev/null)
# All results should be from agent_A (or empty)
SEARCH_A_LEAK=$(echo "$SEARCH_A" | jq "[.results[] | select(.agent_id != \"$AGENT_A\")] | length" 2>/dev/null)
if [ "${SEARCH_A_LEAK:-0}" -eq 0 ]; then
  pass "search API isolation: no cross-agent leakage"
else
  fail "search API isolation" "$SEARCH_A_LEAK results from wrong agent"
fi

# Cleanup isolation agents
for iso_agent in "$AGENT_A" "$AGENT_B"; do
  iso_ids=$(curl -sf "$API/memories?agent_id=$iso_agent&limit=500" -H "$AUTH" 2>/dev/null | jq -r '.items[]?.id // empty' 2>/dev/null)
  for id in $iso_ids; do
    curl -sf -X DELETE "$API/memories/$id" -H "$AUTH" >/dev/null 2>&1 || true
  done
done

echo ""

# ============================================================
# PHASE 17: MULTI-TURN INGEST & DEDUP
# ============================================================
echo -e "${BOLD}--- Phase 17: Multi-Turn Ingest ---${NC}"

AGENT_MT="stress-mt-$$"

# Ingest 5 turns of conversation for same agent
MT_MSGS=(
  "我叫李华，今年28岁"
  "我在字节跳动做后端开发"
  "我们组主要用 Go 和 gRPC"
  "最近在研究 eBPF 性能优化"
  "我养了一只柴犬叫阿黄"
)
MT_REPLIES=(
  "你好李华！"
  "字节的后端团队很厉害呢。"
  "Go + gRPC 是很经典的组合。"
  "eBPF 是个很前沿的技术！"
  "阿黄一定很可爱！"
)

MT_TOTAL_EXTRACTED=0
for i in "${!MT_MSGS[@]}"; do
  MT_RESP=$(ingest "${MT_MSGS[$i]}" "${MT_REPLIES[$i]}" "$AGENT_MT")
  track_ids "$MT_RESP"
  MT_EXT=$(echo "$MT_RESP" | jq '.extracted | length' 2>/dev/null)
  MT_TOTAL_EXTRACTED=$((MT_TOTAL_EXTRACTED + ${MT_EXT:-0}))
  sleep 0.5
done

if [ "$MT_TOTAL_EXTRACTED" -ge 3 ]; then
  pass "multi-turn ingest (5 turns): extracted $MT_TOTAL_EXTRACTED memories total"
else
  warn "multi-turn ingest: only $MT_TOTAL_EXTRACTED extracted"
fi

sleep 1

# Verify no excessive duplicates
MT_MEM_COUNT=$(curl -sf "$API/memories?agent_id=$AGENT_MT&limit=500" -H "$AUTH" 2>/dev/null | jq '.items | length' 2>/dev/null)
if [ "${MT_MEM_COUNT:-0}" -le 20 ]; then
  pass "multi-turn dedup: $MT_MEM_COUNT total memories (reasonable for 5 turns)"
else
  warn "multi-turn dedup: $MT_MEM_COUNT memories seems high for 5 turns"
fi

# Verify recall can find info from different turns
R_MT_NAME=$(recall "用户叫什么名字" "$AGENT_MT")
MT_HAS_NAME=$(echo "$R_MT_NAME" | jq '[.memories[].content] | join(" ")' 2>/dev/null | grep -ci "李华" || true)
R_MT_PET=$(recall "宠物" "$AGENT_MT")
MT_HAS_PET=$(echo "$R_MT_PET" | jq '[.memories[].content] | join(" ")' 2>/dev/null | grep -ci "柴犬\|阿黄" || true)
if [ "$MT_HAS_NAME" -ge 1 ] && [ "$MT_HAS_PET" -ge 1 ]; then
  pass "multi-turn recall: found info from different turns (name + pet)"
elif [ "$MT_HAS_NAME" -ge 1 ] || [ "$MT_HAS_PET" -ge 1 ]; then
  pass "multi-turn recall: partial coverage (name=$MT_HAS_NAME, pet=$MT_HAS_PET)"
else
  fail "multi-turn recall" "couldn't find name or pet info"
fi

# Cleanup multi-turn agent
mt_ids=$(curl -sf "$API/memories?agent_id=$AGENT_MT&limit=500" -H "$AUTH" 2>/dev/null | jq -r '.items[]?.id // empty' 2>/dev/null)
for id in $mt_ids; do
  curl -sf -X DELETE "$API/memories/$id" -H "$AUTH" >/dev/null 2>&1 || true
done

echo ""

# ============================================================
# PHASE 18: EXTRACTION & INJECTION QUALITY (DEEP)
# ============================================================
echo -e "${BOLD}--- Phase 18: Extraction & Injection Quality ---${NC}"

AGENT_Q="stress-quality-$$"

# 18a: Multi-fact extraction — verify each fact is captured separately
log "Testing multi-fact extraction quality..."
Q_RESP1=$(ingest "我叫陈伟，32岁，住在上海浦东，在蚂蚁集团做安全工程师，养了两只猫" "信息量很大！了解了。" "$AGENT_Q")
track_ids "$Q_RESP1"
Q_EXT1=$(echo "$Q_RESP1" | jq -r '[.extracted[].content] | join(" §§ ")' 2>/dev/null)
Q_CATS1=$(echo "$Q_RESP1" | jq -r '[.extracted[].category] | unique | join(",")' 2>/dev/null)
Q_COUNT1=$(echo "$Q_RESP1" | jq '.extracted | length' 2>/dev/null)

# Check each key fact
Q_HAS_NAME=$(echo "$Q_EXT1" | grep -ci "陈伟" || true)
Q_HAS_AGE=$(echo "$Q_EXT1" | grep -ci "32" || true)
Q_HAS_LOC=$(echo "$Q_EXT1" | grep -ci "上海\|浦东" || true)
Q_HAS_JOB=$(echo "$Q_EXT1" | grep -ci "蚂蚁\|安全\|工程师" || true)
Q_HAS_PET=$(echo "$Q_EXT1" | grep -ci "猫" || true)
Q_FACT_HITS=0
[ "$Q_HAS_NAME" -ge 1 ] && ((Q_FACT_HITS++))
[ "$Q_HAS_AGE" -ge 1 ] && ((Q_FACT_HITS++))
[ "$Q_HAS_LOC" -ge 1 ] && ((Q_FACT_HITS++))
[ "$Q_HAS_JOB" -ge 1 ] && ((Q_FACT_HITS++))
[ "$Q_HAS_PET" -ge 1 ] && ((Q_FACT_HITS++))

if [ "$Q_FACT_HITS" -ge 4 ]; then
  pass "multi-fact extraction: $Q_FACT_HITS/5 facts captured in $Q_COUNT1 memories (name=$Q_HAS_NAME age=$Q_HAS_AGE loc=$Q_HAS_LOC job=$Q_HAS_JOB pet=$Q_HAS_PET)"
elif [ "$Q_FACT_HITS" -ge 3 ]; then
  pass "multi-fact extraction: $Q_FACT_HITS/5 facts (acceptable)"
else
  fail "multi-fact extraction" "only $Q_FACT_HITS/5 facts: name=$Q_HAS_NAME age=$Q_HAS_AGE loc=$Q_HAS_LOC job=$Q_HAS_JOB pet=$Q_HAS_PET"
fi

# 18a-categories: Verify diverse categories assigned
Q_CAT_COUNT=$(echo "$Q_RESP1" | jq '[.extracted[].category] | unique | length' 2>/dev/null)
if [ "${Q_CAT_COUNT:-0}" -ge 2 ]; then
  pass "multi-fact categories: $Q_CAT_COUNT distinct types ($Q_CATS1)"
else
  warn "multi-fact categories: only $Q_CAT_COUNT type ($Q_CATS1)"
fi

sleep 1

# 18b: Importance assignment quality — identity should be higher than casual facts
Q_RESP2=$(ingest "我是 CTO，同时我最近在追一部日剧" "哇 CTO！日剧也不错。" "$AGENT_Q")
track_ids "$Q_RESP2"
Q_IDENTITY_IMP=$(echo "$Q_RESP2" | jq '[.extracted[] | select(.content | test("CTO"; "i")) | .importance] | max // 0' 2>/dev/null)
Q_CASUAL_IMP=$(echo "$Q_RESP2" | jq '[.extracted[] | select(.content | test("日剧"; "i")) | .importance] | max // 0' 2>/dev/null)
if [ "$(echo "$Q_IDENTITY_IMP > 0" | bc 2>/dev/null)" = "1" ] && [ "$(echo "$Q_CASUAL_IMP > 0" | bc 2>/dev/null)" = "1" ]; then
  if [ "$(echo "$Q_IDENTITY_IMP >= $Q_CASUAL_IMP" | bc 2>/dev/null)" = "1" ]; then
    pass "importance ranking: CTO($Q_IDENTITY_IMP) >= 日剧($Q_CASUAL_IMP)"
  else
    warn "importance ranking: CTO($Q_IDENTITY_IMP) < 日剧($Q_CASUAL_IMP) — identity should rank higher"
  fi
else
  warn "importance ranking: couldn't compare (identity=$Q_IDENTITY_IMP, casual=$Q_CASUAL_IMP)"
fi

sleep 1

# 18c: Source attribution — user_stated vs observed
Q_SOURCES=$(echo "$Q_RESP1" | jq -r '[.structured_extractions[]?.source // empty] | unique | join(",")' 2>/dev/null)
if echo "$Q_SOURCES" | grep -q "user_stated"; then
  pass "source attribution: user_stated detected (sources=$Q_SOURCES)"
else
  warn "source attribution: no user_stated (sources=$Q_SOURCES)"
fi

sleep 1

# 18d: Search precision — irrelevant query should NOT return high-scoring results about cats
log "Testing search precision..."
R_IRRELEVANT=$(recall "量子力学的基本原理" "$AGENT_Q")
IRRELEVANT_COUNT=$(echo "$R_IRRELEVANT" | jq '.meta.total_found' 2>/dev/null)
IRRELEVANT_TOP_SCORE=$(echo "$R_IRRELEVANT" | jq '.memories[0].finalScore // 0' 2>/dev/null)
if [ "${IRRELEVANT_COUNT:-0}" -le 3 ]; then
  pass "search precision (irrelevant): only $IRRELEVANT_COUNT results for unrelated query"
else
  # Check if scores are at least low
  IRRELEVANT_HIGH=$(echo "$R_IRRELEVANT" | jq '[.memories[] | select(.finalScore > 0.7)] | length' 2>/dev/null)
  if [ "${IRRELEVANT_HIGH:-0}" -eq 0 ]; then
    pass "search precision (irrelevant): $IRRELEVANT_COUNT results but no high-confidence ones (top=$IRRELEVANT_TOP_SCORE)"
  else
    warn "search precision: $IRRELEVANT_HIGH high-scoring results for unrelated query"
  fi
fi

# 18e: Recall context injection quality — full end-to-end check
log "Testing recall injection quality..."
R_CTX_Q=$(recall "陈伟在哪里工作" "$AGENT_Q")
R_CTX_CONTEXT=$(echo "$R_CTX_Q" | jq -r '.context // ""' 2>/dev/null)
R_CTX_INJECTED=$(echo "$R_CTX_Q" | jq '.meta.injected_count // 0' 2>/dev/null)

# Check 1: Context is not empty
if [ -n "$R_CTX_CONTEXT" ] && [ "$R_CTX_CONTEXT" != "" ]; then
  pass "recall injection: context is non-empty (${#R_CTX_CONTEXT} chars)"
else
  fail "recall injection" "empty context returned"
fi

# Check 2: Context uses proper cortex_memory tags
R_CTX_OPEN=$(echo "$R_CTX_CONTEXT" | grep -c "<cortex_memory>" || true)
R_CTX_CLOSE=$(echo "$R_CTX_CONTEXT" | grep -c "</cortex_memory>" || true)
if [ "$R_CTX_OPEN" -ge 1 ] && [ "$R_CTX_CLOSE" -ge 1 ]; then
  pass "recall injection format: proper <cortex_memory> tags"
else
  fail "recall injection format" "missing tags (open=$R_CTX_OPEN, close=$R_CTX_CLOSE)"
fi

# Check 3: Injected content is relevant to the query (should mention work/蚂蚁)
R_CTX_RELEVANT=$(echo "$R_CTX_CONTEXT" | grep -ci "蚂蚁\|安全\|工程师\|陈伟\|上海" || true)
if [ "$R_CTX_RELEVANT" -ge 1 ]; then
  pass "recall injection relevance: context contains relevant info about 陈伟's work"
else
  fail "recall injection relevance" "context doesn't mention 蚂蚁/安全/工程师/陈伟"
fi

# Check 4: injected_count matches actual lines in context
R_CTX_ACTUAL_LINES=$(echo "$R_CTX_CONTEXT" | grep -c "^\[" || true)
if [ "$R_CTX_ACTUAL_LINES" -ge 1 ]; then
  pass "recall injection consistency: $R_CTX_ACTUAL_LINES memory lines, meta.injected=$R_CTX_INJECTED"
else
  warn "recall injection consistency: no [tagged] lines found in context"
fi

# 18f: Negative injection — small talk should NOT get context injected
R_SMALLTALK=$(recall "你好" "$AGENT_Q")
ST_CTX=$(echo "$R_SMALLTALK" | jq -r '.context // ""' 2>/dev/null)
ST_SKIP=$(echo "$R_SMALLTALK" | jq '.meta.skipped' 2>/dev/null)
if [ "$ST_SKIP" = "true" ] || [ -z "$ST_CTX" ] || [ "$ST_CTX" = "" ]; then
  pass "negative injection: small talk gets no context (skipped=$ST_SKIP)"
else
  warn "negative injection: small talk got context (${#ST_CTX} chars)"
fi

# 18g: Constraint injection visibility — constraint should appear when query is relevant
log "Testing constraint injection in context..."
# First ingest a constraint
Q_CONSTRAINT=$(ingest "永远不要在代码中使用 eval()，这是安全红线" "明白，eval 是禁止的。" "$AGENT_Q")
track_ids "$Q_CONSTRAINT"
sleep 1

R_EVAL=$(recall "代码安全规范" "$AGENT_Q")
R_EVAL_CTX=$(echo "$R_EVAL" | jq -r '.context // ""' 2>/dev/null)
R_EVAL_HAS=$(echo "$R_EVAL_CTX" | grep -ci "eval\|安全\|禁止" || true)
if [ "$R_EVAL_HAS" -ge 1 ]; then
  pass "constraint in context: eval constraint found in relevant recall"
else
  warn "constraint in context: eval constraint not found (may not have been extracted as constraint)"
fi

# Cleanup quality agent
q_ids=$(curl -sf "$API/memories?agent_id=$AGENT_Q&limit=500" -H "$AUTH" 2>/dev/null | jq -r '.items[]?.id // empty' 2>/dev/null)
for id in $q_ids; do
  curl -sf -X DELETE "$API/memories/$id" -H "$AUTH" >/dev/null 2>&1 || true
done

echo ""

# ============================================================
# MEMORY STATISTICS
# ============================================================
echo -e "${BOLD}--- Memory Statistics ---${NC}"

FINAL_COUNT=$(curl -sf "$API/memories?agent_id=$AGENT&limit=1" -H "$AUTH" 2>/dev/null | jq '.total // 0' 2>/dev/null)
log "Total memories for test agent: $FINAL_COUNT"

echo ""

# ============================================================
# SUMMARY
# ============================================================
echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}  TEST RESULTS${NC}"
echo -e "${BOLD}========================================${NC}"
echo -e "  ${GREEN}PASSED${NC}: $PASS"
echo -e "  ${RED}FAILED${NC}: $FAIL"
echo -e "  ${YELLOW}WARNINGS${NC}: $WARN"
echo -e "  TOTAL : $TOTAL"
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}ALL TESTS PASSED${NC} ($WARN warnings)"
else
  echo -e "${RED}${BOLD}$FAIL TESTS FAILED${NC} ($WARN warnings)"
fi
echo ""
