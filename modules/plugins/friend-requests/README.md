# friend-requests · 好友申请通知

有人加机器人好友、或有入群邀请时，把「编号 + 理由」推到主人私聊；主人回一个数字就能批准。

不自动同意，决定权在主人。

## 它做什么

- 监听核心的 `friend.request` / `group.request` 钩子（`src/app.js` 收到 `post_type=request` 时触发）。
- 把请求落盘到 `<安装目录>/data/friend-requests.json`（保留最近 50 条，flag 只存不打印）。
- 用本机 SnowLuma HTTP `send_private_msg` 推一条单行通知给主人。
- 注册两个工具：
  - `friend-requests__list`：列出待处理的申请
  - `friend-requests__handle({ id, approve, reason })`：同意/拒绝，只接受主人号

## 通知长什么样

```
【好友申请 #3】昵称未知｜理由：我是某某｜回数字 3 同意，回「拒 3」拒绝（约 30 分钟有效）
```

QQ 里多行消息容易被折叠，所以刻意压成一行。

## 配置

```json
{
  "skills": {
    "friend-requests": {
      "enabled": true,
      "ownerIds": "10001",
      "notify": true,
      "ttlMinutes": 30,
      "maxRecords": 50
    }
  }
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| ownerIds | `10001` | 只有这些号能看列表、能批准。换成你自己的号 |
| notify | true | 关掉后只记录不推送 |
| ttlMinutes | 30 | QQ 的申请 flag 有时效，超时批准会失败 |
| maxRecords | 50 | 记录上限 |

## 配合人设

光有工具不够，模型得知道"主人回一个数字就是在批准"。建议在人设里加：

```
- 主人回一个纯数字（例如「1」）就是同意对应编号的好友申请；回「拒 1」「拒绝 1」是拒绝。
  看到这种消息立刻调 friend-requests__handle（id=数字，approve=true/false），不要反问。
```

## 已知限制

- 事件里的 `user_id` 可能是 `0`：SnowLuma 只给 uid 形式的 `flag`，不给 QQ 号，所以通知只能显示「昵称未知」+ 申请理由。通过后从好友列表才看得到昵称。
- flag 有时效（约 30 分钟）；隔太久再批准会失败，工具会提示去 QQ 里手动点。
- 只处理 `post_type=request` 的事件；如果协议端根本不推，这个插件收不到任何东西。

## 排查

```bash
# 事件有没有到（应用的日志在 data/logs/ 下，不在 journal）
grep '\[request\]' <安装目录>/data/logs/qq-agent-*.log | tail
# 插件有没有接住
journalctl -u qq-agent | grep friend-requests | tail
```
