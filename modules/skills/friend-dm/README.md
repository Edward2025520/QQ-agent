# friend-dm · 好友私信

让机器人知道自己的好友列表，并在主人要求时，给名单里的好友发 QQ 私聊。

默认**不启用**。装进安装目录后，技能会出现在控制台「技能」页，状态是未启用，需要手动打开。

## 它做什么

- `friend-dm__friend_roster`：查看、添加、移除名单里的人（只有主人能改）
- `friend-dm__friend_dm`：给名单里的人发一条私聊（只有主人能下指令）
- `friend-dm__friend_dm_status`：查名单、每人最近发送时间、今日已发数、当前限额

工具名带 `friend-dm__` 前缀是核心加载时加的，模型必须用全名调用。

## 安装

```bash
cp -a friend-dm <安装目录>/skills/
```

热重载会自动发现它，不需要重启。然后在控制台「技能」页打开 `friend-dm`。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `ownerIds` | `10001` | 只有这些 QQ 号能下指令、改名单；留空则指令类和名单类工具全部拒绝 |
| `friends` | `[]` | 名单，形如 `[{"qq":"10002","alias":"示例好友","note":""}]` |
| `autonomy` | `false` | 是否允许机器人自主发起（默认关，只在主人下命令时发） |
| `manualDailyCap` | `0` | 主人手动发送的每人每日上限，`0` = 不限 |
| `dailyCapPerFriend` | `1` | 自主发送的每人每日上限 |
| `minIntervalHours` | `24` | 自主发送的最短间隔；**手动发送不受这个限制** |
| `quietStart` / `quietEnd` | `22:00` / `08:00` | 静默时段，只约束自主发送；**手动发送不受限制** |
| `reportToOwner` | `true` | 自主发送后在主人私聊回报一行 |
| `dryRun` | `false` | 只记录不真发 |

两个容易踩的点：

1. `manualDailyCap` 为 `0` 表示**不限**，不是"零条"。
2. `friend_dm_status` 里的 `blocked` 是按手动口径判定的（现在能不能发），`blockedAuto` 才是自主发送的限制。静默时段只影响 `blockedAuto`。

## 行为边界

- 名单是唯一可信来源：不在 `friends` 里的人一律不发。
- 只有 `ownerIds` 里的人能下指令；指令只在私聊里接受，群里说的不执行。
- 手动发送的内容上限 500 字。
- 同一个 QQ 在 24 小时内不会重复发同一句话（去重用）。

## 卸载

```bash
rm -rf <安装目录>/skills/friend-dm
```

`data/friend-dm/state.json`（发送记录）不会被删，需要的话自己清。
