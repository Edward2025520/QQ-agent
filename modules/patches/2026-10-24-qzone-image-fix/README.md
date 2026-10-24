# qzone 配图被拦 —— 修复补丁

## 问题

带图说说发不出去，日志里是 `配图=无`，模型的说法是"图被拦住了"。

两个原因叠加：

1. **图床白名单太窄**：`lib/safe-topic.js` 的 `ALLOWED_IMAGE_HOSTS` 只允许 `aigengtu`、`soutula` 两个域名。搜图工具返回的图基本都在别的站点，判定失败后 `publish_qzone_post` **静默降级成纯文字**。
2. **中转地址是死链**：白名单内的图会改写成 `http://127.0.0.1:3210/api/qzone-img/<key>`，但代码库里没有这个路由，走中转必然 404。

## 改法

- 新增 `lib/image-check.js`：
  - `isPublicHttpUrl()` 只放行公网 http(s)，挡 `localhost` / `127.*` / `10.*` / `192.168.*` / `172.16-31.*` / `.local`
  - `headCheck()` 用 HEAD 粗筛（405 退回 GET Range 0-1023），要求 `image/jpeg|png|webp|gif`、≤ 8MB
  - `downloadHash()` 完整下载复核并算 sha256
  - `seenRecently()` / `remember()` 90 天查重，存 `data/qzone/used-images.json`
- `lib/safe-topic.js`：`isAllowedImageUrl()` 改为调用 `isPublicHttpUrl()`
- `lib/meme-search.js`：图床检查放开，缓存结果附带内容哈希
- `index.js`：删掉死链中转；发布前 HEAD → 下载算哈希 → 查重；失败**明确报错**让模型换图；发布成功记哈希；挑图时跳过最近发过的

## 应用

```bash
cd <QQ-agent 安装目录>
patch -p1 < modules/patches/2026-10-24-qzone-image-fix/qzone-image-fix.patch
```

然后重启 QQ Agent（`lib/` 下的模块热重载换不掉）。

如果 `patch` 报冲突，说明你的 `skills/qzone` 版本不同：把 `a/` 一侧的旧文件与本补丁对照，手工迁移 4 处改动即可。

## 兼容性

- 针对 2026-10-24 的 `skills/qzone`（作者「明」，`skill.json` 作者字段）。
- 补丁只包含 diff 与新增文件，**不包含原技能代码**；使用时仍需自行取得原技能。

## 验证

```bash
node --input-type=module -e "
import { headCheck, downloadHash, seenRecently, remember } from 'file://<安装目录>/skills/qzone/lib/image-check.js';
console.log(await headCheck(fetch, 'https://www.python.org/static/img/python-logo.png'));
console.log(await headCheck(fetch, 'https://example.com/'));
"
```

第一条应 `ok:true` 且 `mime:image/png`，第二条应 `ok:false`（text/html）。
