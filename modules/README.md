# QQ Agent 扩展模块（modules/）

给 [QQ-agent](https://github.com/K0nd1us/QQ-agent) 用的四个本地扩展：跨会话共享记忆、好友回信通知、好友私信、7 天滚动清理。

都是**外挂**形态，不改 `src/` 核心代码。放进安装目录的 `plugins/`、`skills/` 即生效（插件热加载，技能需要在控制台启用）。出问题删目录就回滚。

## 兼容性

- QQ-agent **0.4.0**（实测版本）
- Node.js ≥ 20
- `qq-agent-retention` 额外需要 Linux + systemd

## 四个模块

| 模块 | 类型 | 做什么 |
| --- | --- | --- |
| `plugins/shared-memory` | 插件（hooks） | 每轮把最近 N 小时**其它会话**的摘要压成一小段注入提示词；另注册 `shared-memory__recall` 工具，可在保留期内跨会话检索 |
| `plugins/pinned-facts` | 插件（hooks） | 把长期不变的事实（谁是谁、别名、主人口径）每轮注入，不受记忆整理影响；号码类信息只在白名单私聊给出 |
| `plugins/dm-notice` | 插件（hooks） | 好友回消息后，把「对方说了什么 + 机器人回了什么」合并成一条，推到主人私聊 |
| `skills/friend-dm` | 技能（工具） | 让机器人在主人明确下命令时给名单里的好友发私聊；带名单白名单、静默时段、每日上限 |
| `scripts/qq-agent-retention` | 脚本 + systemd timer | 每天 04:00 按保留期清理聊天记录、群友印象、会话片段、对话会话，软删除到备份区 |

三者可以独立使用：

- 只用 `friend-dm`：机器人能按命令发私聊。
- 加 `dm-notice`：对方回了会通知你。
- 加 `shared-memory`：机器人记得住别的会话聊过的事。
- 加 `retention`：别让数据无限长大。

## 补丁

第三方技能的本地修复不整包转载，放在 [patches/](patches/) 下，以 diff 形式提供。

## 安装

### 方式一：脚本

```bash
# 先看它会做什么（默认 dry-run，不动文件）
./install.sh --app-dir /opt/qq-agent

# 真装
./install.sh --app-dir /opt/qq-agent --apply

# 顺便装清理定时器（需要 root）
sudo ./install.sh --app-dir /opt/qq-agent --apply --systemd
```

脚本会把同名目录先备份成 `<名字>.bak.<时间戳>`，不会碰 `data/` 和 `config.json`。

### 方式二：手动

```bash
cp -a plugins/shared-memory <安装目录>/plugins/
cp -a plugins/dm-notice   <安装目录>/plugins/
cp -a skills/friend-dm    <安装目录>/skills/
cp scripts/qq-agent-retention /usr/local/bin/ && chmod +x /usr/local/bin/qq-agent-retention
cp scripts/qq-agent-retention.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now qq-agent-retention.timer
```

装完 `journalctl -u qq-agent -n 20` 应能看到 `[skill:shared-memory]`、`[skill:dm-notice]` 的加载日志；技能需要在控制台「技能」页打开。

## 配置示例

插件/技能的设置存在安装目录的 `data/config.json` 里，形如：

```json
{
  "skills": {
    "shared-memory": { "enabled": true, "hours": 6, "days": 7, "maxChars": 900, "maxLines": 12 },
    "dm-notice": { "enabled": true, "debounceSec": 15, "maxChars": 400 },
    "friend-dm": {
      "enabled": true,
      "friends": [{ "qq": "10002", "alias": "示例好友", "note": "" }],
      "ownerIds": "10001",
      "autonomy": false,
      "manualDailyCap": 0
    }
  }
}
```

把 `10001` 换成你自己的 QQ 号、`10002` 换成目标好友的号。`ownerIds` 之外的人无法下发送指令。

`shared-memory` 的主人口径复用 `skills.affinity.ownerQq`；没装 affinity 时用 `10001` 兜底，记得改成自己的号。

## 安全提示

- `friend-dm` 是**名单制**：只有 `friends` 里的人和 `ownerIds` 的命令能触发发送，名单外一律拒绝。
- 打开 `tools.crossChatSend` 后机器人可以往任意白名单会话发消息（包括你的私聊），这是 `send_to` 工具的能力，按需开启。
- `qq-agent-retention` **会真删数据**：默认保留 7 天，删除前拷到 `data/backups/retention/<日期>/`，备份再留 7 天。第一次用建议先 `--dry-run`。
- `shared-memory` 会把别的会话的摘要注入当前会话；如果群里人多且不想互相看到，把 `maxChars` 调小或直接关掉。
- 两个插件都会读 `data/config.json` 的运行配置，不会向外发请求（`dm-notice` 只调本机 SnowLuma HTTP API）。

## 卸载

```bash
rm -rf <安装目录>/plugins/shared-memory <安装目录>/plugins/dm-notice <安装目录>/skills/friend-dm
systemctl disable --now qq-agent-retention.timer
rm -f /usr/local/bin/qq-agent-retention /etc/systemd/system/qq-agent-retention.*
systemctl daemon-reload
```

数据（`data/`）不会被删，需要的话自己清。

## 许可

MIT，见仓库根目录 `LICENSE`。来源说明见 [NOTICE.md](NOTICE.md)。
