# 事实必查、链接能读、表情包不重样

一次修三件事：被问歌词/歌名/影视/人物不再凭记忆编，小红书这类链接能读出标题和简介，聊天里发表情包先上网找、不重样，而且能回答「上次发的是哪张」。

## 改了什么

### 1. 事实题强制查（`src/web-search.js` + `src/tools.js`）

- `web_search` 的描述改成「事实题必用，换不同措辞至少搜两次；搜不到就照实说」——工具描述是模型唯一能看见的用法说明，写软了它就真不查。
- DeepSeek 搜索失败时不再直接报错：先重试一次，再退回**搜狗结果页抓取**（`sogouSearch()`，解析 `h3.vr-title`）。实测搜狗可抓，必应图片/网页在国内基本被降级成百科页。
- 新增 `read_link` 工具（`src/link-preview.js`）：读标题、og 简介、作者、JSON-LD、`<article>` 正文、页面内嵌 `"desc"`，正文上限 4000 字。

### 2. 小红书/短视频链接

`read_link` 对小红书、抖音、B 站、微博、知乎、公众号、YouTube、GitHub 分别标 `platform`。小红书实测：带 `xsec_token` 的分享链接能拿到标题和简介，正文 39 字（页面骨架）→ `bodyAvailable=false` 并附提示「只拿到标题和简介，别猜内容」；B 站无 JS 时回「出错啦」页 → 直接报错让模型去要截图，而不是把错误页当内容。

### 3. 表情包（`skills/whale-memes/`）

- `webFirst`（默认开）：给了关键词就先 `searchImages("关键词 表情包")`，有能发的就发网图；搜不到/全发失败才回退本地 2963 张图库。
- 发送时按**内容 sha1** 查重（`seenHash()`），同一会话里同样的图不再重复发——之前只按图库 id 去重，同一张图在不同条目里会重样。
- `state.json` 的 `sent[]` 增加 `hash` 与 `source`（web/gallery）。
- 新增工具 `whale-memes__recent_sent`：列出本会话最近发过的图（时间、来源、说明），用来回答「你上次发的是哪张」。
- `skill.json` 的 settings 增加 `webFirst`。

### 4. 人设（`data/config.json`，不进补丁）

把原来「被问事实…可以先 web_search」的两条软建议换成三条硬规则（第 10–12 条，后面的 12–19 顺延为 13–20）：

1. 该有标准答案的（歌词/歌名/歌手/电影/剧集/人物/地点/数据/新闻）必须先搜、换措辞至少两次、点开正文，查不到或说法矛盾就直说没查到，不许编。
2. 只有闲聊、感受、观点、梗、玩笑才不查；拿不准算不算事实题时按事实题处理。
3. 先看正文再下结论；正文打不开用 `read_link` 读标题简介，再把标题当关键词搜一次；仍拿不到就说拿不到。

## 应用

```bash
cd <QQ-agent 安装目录>
patch -p1 < modules/patches/2026-11-07-facts-links-memes/facts-links-memes.patch
```

`src/` 与技能代码都不会热重载，改完重启 QQ Agent。人设那三条要自己在 `data/config.json` 的 `persona.roleText` 里加，补丁不动用户配置。

## 验证记录

- `sogouSearch('红豆 歌词 王菲')` 返回 6 条，前三条是 QQ音乐/酷我/酷狗的红豆页面。
- `readLink(小红书分享链接)` → `{platform:'小红书', title:'豹儿打哈欠', description:'#海豹 #动物 ...', bodyAvailable:false}`。
- `readLink(B站视频)` → 抛「B站这次没打开…」。
- 技能实跑（桩 sender）：`send_meme({keyword:'摸鱼'})` 先发 `web:cbd15f78…`（690×426 jpeg），第二次同关键词时该网图被哈希去重、回退图库发 `#052`；`recent_sent` 正确列出两条。
