# dm-notice · 好友回信通知

配合 `skills/friend-dm` 用：你让机器人去跟某个好友说句话，对方回了，插件把这一轮**对方说了什么 + 机器人回了什么**合并成一条，推到你的私聊。

## 它做什么

- 监听 `after-response` 钩子，只在「好友名单里的私聊会话」触发。
- 同一批来回合并成一条，默认 15 秒去抖，避免刷屏。
- 通过本机 SnowLuma 的 HTTP API `send_private_msg` 发送，**不新开 WebSocket**，不会重复收事件。

## 依赖

- `skills/friend-dm`：提供好友名单（`skills["friend-dm"].friends`）和主人号（`ownerIds`）。
- SnowLuma 的 HTTP 接口可访问（默认 `http://127.0.0.1:3000`，令牌读 `config.snowluma.httpAccessToken`）。

## 配置

```json
{
  "skills": {
    "dm-notice": { "enabled": true, "debounceSec": 15, "maxChars": 400, "dryRun": false }
  }
}
```

`dryRun: true` 时只写日志不真发，用来先看内容是否合适。

## 通知长什么样

```
【通知】示例好友 那边
对方：在吗
呆猫：在喵
```

对方多条只取最近 3 条、每条截 60 字。

## 注意

- 通知只发给你，不会转发给对方。
- 通知消息是机器人账号自己发的，核心会忽略自己发出的私聊（`app.js` 对 `selfId` 有过滤），不会触发新一轮对话。
- 发送失败只记日志、不重试，不影响正常回复。

## 关掉

`skills["dm-notice"].enabled = false`，或删目录。
