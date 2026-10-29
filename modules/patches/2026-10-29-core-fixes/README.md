# 核心修复补丁（2026-10-29）

针对 QQ-agent 0.4 上游源码的三处本地改动。上游更新后行号可能漂移，按下面的说明手工迁移。

## 内容

| 补丁 | 改了什么 |
| --- | --- |
| `src-tools.patch` | ① `get_message_images` 遇到 QQ 图片链接过期（HTTP 400）时，用协议端 `get_image` 按 `file` 刷新重试；② `set_reminder` 支持 `targetChatKey`，主人可以在自己的会话里给别人设提醒（目标必须过白名单） |
| `src-orchestrator.patch` | ① 提醒到点**原样发送**，去掉 `⏰ 提醒：` 前缀；② 超过 `config.reminders.staleMinutes`（默认 30 分钟）的逾期提醒直接作废，不补发 |
| `src-app.patch` | 事件入口加一行调试日志，由 `config.debug.events` 控制（默认关）。排查"事件有没有到达"时打开 |

## 应用

```bash
cd <QQ-agent 安装目录>
patch -p1 < modules/patches/2026-10-29-core-fixes/src-tools.patch
patch -p1 < modules/patches/2026-10-29-core-fixes/src-orchestrator.patch
patch -p1 < modules/patches/2026-10-29-core-fixes/src-app.patch
systemctl restart qq-agent   # 核心改动必须重启
```

## 验证

```bash
# 提醒：应无 ⏰ 前缀
node --check src/tools.js && node --check src/orchestrator.js

# 图片刷新：拿一条历史图片消息的 file 调 get_image，应返回新链接
```

## 兼容

- 基于 2026-10-29 的 `0.4` 源码；补丁只含 diff，不含上游代码。
- `src-app.patch` 只加日志，不影响行为，可单独跳过。
