# Cortex v0.5.0 发布测试计划

> 目标：确保不同用户环境下 Cortex + cortex-bridge 插件 + Dashboard 集成面板稳定可用

---

## 一、环境矩阵

| 编号 | 场景 | 认证模式 | 端口 | 部署方式 |
|------|------|----------|------|----------|
| E1 | 默认部署（无 token） | 无认证 | 21100 | Docker |
| E2 | 单 Master Token | Bearer token | 21100 | Docker |
| E3 | 多 Agent Token | agent_id 绑定 | 21100 | Docker |
| E4 | 自定义端口 | Master Token | 9999 | Docker |
| E5 | 反代 + HTTPS | Master Token | 443 | Docker + Nginx |

---

## 二、Server 核心接口测试

### 2.1 Health（公开接口）

| # | 测试项 | 命令 | 预期 |
|---|--------|------|------|
| S1 | 无 token 访问 health | `curl http://HOST:PORT/api/v1/health` | 200, `{"status":"ok","version":"..."}` |
| S2 | health 返回版本号 | 同上 | version 字段与 package.json 一致 |
| S3 | health 返回 uptime | 同上 | uptime > 0 |

### 2.2 认证

| # | 测试项 | 命令 | 预期 |
|---|--------|------|------|
| S4 | 无 token 环境，所有接口开放 | E1 下 `curl /api/v1/memories?agent_id=test` | 200 |
| S5 | 有 token 环境，无 header 被拒 | E2 下同上 | 401 |
| S6 | 错误 token 被拒 | `Authorization: Bearer wrong` | 403 |
| S7 | 正确 master token | `Authorization: Bearer MASTER` | 200 |
| S8 | Agent token 访问自己的数据 | agent token for agent_a → `?agent_id=agent_a` | 200 |
| S9 | Agent token 访问别人的数据 | agent token for agent_a → `?agent_id=agent_b` | 403 |
| S10 | Master token 访问任意 agent | master → `?agent_id=agent_a` | 200 |

### 2.3 记忆 CRUD

| # | 测试项 | 预期 |
|---|--------|------|
| S11 | POST /api/v1/memories 创建记忆 | 201, 返回 id |
| S12 | GET /api/v1/memories?agent_id=X&limit=10 | 200, items 数组 |
| S13 | GET /api/v1/memories?sort=created_at&order=desc | 按时间倒序 |
| S14 | POST /api/v1/recall 语义搜索 | 200, context + meta |
| S15 | POST /api/v1/recall 空查询/闲聊 | 200, skipped:true |
| S16 | POST /api/v1/ingest 对话提取 | 200, extracted 数组 |
| S17 | GET /api/v1/stats?agent_id=X | 200, total_memories + layers |

---

## 三、cortex-bridge 插件测试

### 3.1 配置优先级

| # | 测试项 | 配置 | 预期 agentId |
|---|--------|------|--------------|
| P1 | 仅默认值 | 无 config, 无 env | `openclaw` |
| P2 | 环境变量 | `CORTEX_AGENT_ID=mybot` | `mybot` |
| P3 | 插件配置 | config.agentId = `prod` | `prod` |
| P4 | 两者都设，config 优先 | config=`prod`, env=`mybot` | `prod` |
| P5 | cortexUrl 优先级 | config > CORTEX_URL > 默认 | 同理 |
| P6 | authToken 优先级 | config > CORTEX_AUTH_TOKEN > 空 | 同理 |

### 3.2 工具（Tools）

| # | 测试项 | 预期 |
|---|--------|------|
| P7 | cortex_recall 正常查询 | 返回相关记忆 context |
| P8 | cortex_recall 无结果 | "No relevant memories found." |
| P9 | cortex_recall Cortex 不可达 | 返回错误信息，不崩溃 |
| P10 | cortex_remember 存储 | "Remembered: ..." |
| P11 | cortex_remember 无 token 时（E1） | 正常工作 |
| P12 | cortex_remember 错误 token | 返回 HTTP 401/403 错误 |
| P13 | cortex_ingest 提取对话 | "Conversation ingested — N memories extracted" |
| P14 | cortex_ingest 内容清洗 | XML/代码/JSON 被剔除 |
| P15 | cortex_relations 查询 | 返回关系列表或 "No relations" |
| P16 | cortex_health 在线 | `{"ok":true,"latency_ms":N}` |
| P17 | cortex_health 离线 | `{"ok":false,"error":"..."}` |

### 3.3 命令（Commands）

| # | 测试项 | 命令 | 预期 |
|---|--------|------|------|
| P18 | cortex_status 在线 | `/cortex_status` | ✅ + version + uptime + memories + agent + url |
| P19 | cortex_status 离线 | 停 Cortex 后执行 | ❌ offline 信息 |
| P20 | cortex_search 有结果 | `/cortex_search 关键词` | 🔍 + 数量 + 耗时 + 内容 |
| P21 | cortex_search 无结果 | `/cortex_search xyzabc` | "没有找到相关记忆" |
| P22 | cortex_search 无参数 | `/cortex_search` | 用法提示 |
| P23 | cortex_search 长耗时 | 复杂查询 | 15秒内返回，不超时 |
| P24 | cortex_remember 成功 | `/cortex_remember 测试内容` | ✅ 已记住 |
| P25 | cortex_remember 无参数 | `/cortex_remember` | 用法提示 |
| P26 | cortex_recent 有数据 | `/cortex_recent` | 最近 N 条 + 时间 + 分类 |
| P27 | cortex_recent 空库 | 新 agent 下执行 | "暂无记忆" |
| P28 | Telegram 命令名下划线 | `/cortex_status` | 正常触发（非 cortex-status） |

### 3.4 Hooks

| # | 测试项 | 预期 |
|---|--------|------|
| P29 | before_agent_start 自动召回 | 日志显示 recalled N memories |
| P30 | agent_end 自动保存 | 日志显示 ingest ok |
| P31 | before_compaction flush | 压缩前紧急保存 |
| P32 | 闲聊不触发 ingest | 短消息/"ok"等不提取 |

### 3.5 边界情况

| # | 测试项 | 预期 |
|---|--------|------|
| P33 | Cortex 启动前加载插件 | 服务启动检查报 warn，不影响后续工作 |
| P34 | Cortex 中途挂掉 | 工具/命令返回错误，不崩溃 |
| P35 | Cortex 恢复后自愈 | 无需重启，下次请求自动恢复 |
| P36 | 超长内容 ingest | 清洗后正常提取 |
| P37 | 特殊字符（emoji/中文/日文） | 正常存储和召回 |

---

## 四、Dashboard 集成面板测试

### 4.1 通用

| # | 测试项 | 预期 |
|---|--------|------|
| D1 | 中文界面 | 所有文案正确显示 |
| D2 | 英文界面 | 所有文案正确显示 |
| D3 | cortexUrl 动态生成 | 代码示例中的 URL 与当前访问地址一致 |
| D4 | agentId 动态生成 | 代码示例中的 agent_id 与当前智能体一致 |

### 4.2 集成指南步骤

| # | 测试项 | 预期 |
|---|--------|------|
| D5 | Step 1 安装命令 | `openclaw plugins install @cortexmem/cortex-bridge` |
| D6 | Step 2 方式 A (openclaw.json) | JSON 格式正确，含 cortexUrl + authToken + agentId |
| D7 | Step 2 方式 B (.env) | 含 CORTEX_URL + CORTEX_AUTH_TOKEN + CORTEX_AGENT_ID |
| D8 | Step 2 方式 C (shell profile) | export 命令格式正确 |
| D9 | 方式标签无重复 | A / B / C 各不相同 |
| D10 | Step 3 功能列表完整 | 3 hooks + 2 tools + 4 commands |
| D11 | Step 4 测试说明 | 提到 /cortex_status（下划线） |

### 4.3 API / MCP / OpenClaw 面板

| # | 测试项 | 预期 |
|---|--------|------|
| D12 | API 面板 curl 示例 | 可直接复制执行 |
| D13 | JS 代码示例 | 语法正确，URL/agentId 动态 |
| D14 | Python 代码示例 | 语法正确，URL/agentId 动态 |
| D15 | MCP 面板配置示例 | 包含 CORTEX_AGENT_ID 环境变量 |

---

## 五、发布前 Checklist

- [ ] 所有 `localhost:21100` 仅出现在默认值位置（非硬编码）
- [ ] 无个人信息（IP/token/用户名）泄漏到代码库
- [ ] package.json 版本号已 bump
- [ ] CHANGELOG 已更新
- [ ] 插件 npm 包编译通过
- [ ] Docker 镜像构建通过
- [ ] `git diff` 确认所有改动
- [ ] 单元测试通过 (`pnpm test`)
- [ ] E2 场景（单 token）端到端通过
- [ ] E3 场景（多 agent token）端到端通过
- [ ] cortex-bridge 插件 npm publish
- [ ] Docker 镜像推送 GHCR
- [ ] GitHub Release 创建

---

## 六、自动化测试脚本

```bash
#!/bin/bash
# release-test.sh - 快速冒烟测试
set -e

CORTEX_URL=${1:-http://localhost:21100}
TOKEN=${2:-""}
AGENT=${3:-openclaw}

AUTH=""
[ -n "$TOKEN" ] && AUTH="-H \"Authorization: Bearer $TOKEN\""

echo "🧪 Testing Cortex at $CORTEX_URL (agent: $AGENT)"

# S1: Health
echo -n "S1 Health... "
STATUS=$(eval curl -s -o /dev/null -w '%{http_code}' $CORTEX_URL/api/v1/health)
[ "$STATUS" = "200" ] && echo "✅" || echo "❌ ($STATUS)"

# S2: Version
echo -n "S2 Version... "
VERSION=$(curl -s $CORTEX_URL/api/v1/health | python3 -c "import sys,json;print(json.load(sys.stdin).get('version','?'))")
echo "✅ $VERSION"

# S11: Create memory
echo -n "S11 Create... "
STATUS=$(eval curl -s -o /dev/null -w '%{http_code}' -X POST $CORTEX_URL/api/v1/memories \
  -H 'Content-Type: application/json' $AUTH \
  -d "{\"content\":\"release test $(date +%s)\",\"agent_id\":\"$AGENT\",\"category\":\"fact\",\"layer\":\"working\"}")
[ "$STATUS" = "201" ] && echo "✅" || echo "❌ ($STATUS)"

# S12: List memories
echo -n "S12 List... "
STATUS=$(eval curl -s -o /dev/null -w '%{http_code}' $AUTH "$CORTEX_URL/api/v1/memories?agent_id=$AGENT&limit=1")
[ "$STATUS" = "200" ] && echo "✅" || echo "❌ ($STATUS)"

# S14: Recall
echo -n "S14 Recall... "
STATUS=$(eval curl -s -o /dev/null -w '%{http_code}' -X POST $CORTEX_URL/api/v1/recall \
  -H 'Content-Type: application/json' $AUTH \
  -d "{\"query\":\"release test\",\"agent_id\":\"$AGENT\"}")
[ "$STATUS" = "200" ] && echo "✅" || echo "❌ ($STATUS)"

# S17: Stats
echo -n "S17 Stats... "
STATUS=$(eval curl -s -o /dev/null -w '%{http_code}' $AUTH "$CORTEX_URL/api/v1/stats?agent_id=$AGENT")
[ "$STATUS" = "200" ] && echo "✅" || echo "❌ ($STATUS)"

# Auth tests (only if token provided)
if [ -n "$TOKEN" ]; then
  echo -n "S5 No-auth rejected... "
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$CORTEX_URL/api/v1/memories?agent_id=$AGENT")
  [ "$STATUS" = "401" ] && echo "✅" || echo "❌ ($STATUS)"

  echo -n "S6 Wrong token rejected... "
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrongtoken" "$CORTEX_URL/api/v1/memories?agent_id=$AGENT")
  [ "$STATUS" = "403" ] && echo "✅" || echo "❌ ($STATUS)"
fi

echo "🏁 Done!"
```
