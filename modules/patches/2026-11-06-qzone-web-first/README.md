# qzone 配图改为网图优先

## 目的

发 QQ 空间时先在网上找图（memecub），网图没有合适的才退回本地 DeepSeek娘图库；两边都不搭就发纯文字，不硬配。

## 原来的问题

- 汇总段判断用的是 `rules().webMemeEnabled`，而 `rules()` 里只定义了 `webMemecub` → 该条件恒为假，**图库命中时网图补充从来没执行过**。
- `source=auto` 的语义是「图库为主、网图补充」，实际表现是配图基本全是本地图库。
- 网图候选的「来源」还硬编码成「网图（必应图片）」，与只剩 memecub 的现实不符。

## 改法

- 修 `rules().webMemeEnabled` → `rules().webMemecub`。
- 新增网图优先分支：`source=auto`（默认）且给了关键词时，先 `webPick()`；有合格候选就只返回网图（`source:'web'`），带冷却去重与尺寸/长宽比过滤。
- 网图为空或出错才走本地图库；两路都没有仍返回 `found:false`，提示发纯文字。
- `source=web` / `source=gallery` 的显式语义保留。
- 候选来源标签统一成「网图（memecub）」，工具描述与发空间提醒同步改成「先搜网图，找不到再用图库」。

## 应用

```bash
cd <QQ-agent 安装目录>
patch -p1 < modules/patches/2026-11-06-qzone-web-first/qzone-web-first.patch
```

`lib/` 下的模块热重载换不掉，改完重启 QQ Agent。
