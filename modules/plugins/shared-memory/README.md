# shared-memory · 跨会话共享记忆

让机器人在 A 会话里知道的事，到 B 会话还能接上。

QQ-agent 的记忆本来就是按会话存的：群里的印象私聊读不到，私聊聊过的群里也不会提。这个插件补的就是这条断层。

## 它做什么

1. **每轮自动带**：把最近 `hours` 小时里**其它会话**的摘要（来自 `conversation-memory` 的按小时留档）和群友印象压成一小段，追加到请求尾部。默认 6 小时、900 字、12 行；设成 12 小时、1400 字、20 行也跑得动。
2. **按需检索**：注册 `shared-memory__recall` 工具，在 `days` 天内所有会话里搜关键词，返回带出处和时间的片段。被问到"别处/刚才/某人说过什么"时模型会调它。
3. **分层脱敏**，三档：
   - **白名单私聊**（`allow.private` 里的人）：算「熟人」，其它会话的私聊内容照常给，名字照实显示。
   - **白名单群**（`allow.groups` 里的群）：算「半熟人」，能看到内容，但只给名字、不给号码，并追加一句「别主动提老大私聊的事，只有别人直接问起时才引用」。
   - **其它会话**：群聊仅注入公开印象，非白名单私聊的内容一概不看，老大相关内容替换掉。

## 依赖

- `plugins/conversation-memory`（QQ-agent 自带）：提供 `data/memory-v2/chunks/` 的按小时摘要。没有它，插件只会注入群友印象那一层。
- 核心的 `data/memory/<chat>/<uid>.json` 印象。

## 配置

```json
{
  "skills": {
    "shared-memory": {
      "enabled": true,
      "hours": 12,
      "days": 7,
      "maxChars": 1400,
      "maxLines": 20,
      "maxRecallChars": 3000,
      "includeCurrentChat": false
    }
  }
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| hours | 6 | 每轮自动带最近几小时；想记更多就调大（12 也可以） |
| days | 7 | 可检索的最大年龄，建议与清理脚本保持一致 |
| maxChars / maxLines | 900 / 12 | 注入预算，超了从最旧截断；1400 / 20 是放宽档 |
| maxRecallChars | 3000 | 工具单次返回上限 |
| includeCurrentChat | false | 当前会话的印象由核心注入，默认不重复 |

`skills.affinity.ownerQq` 决定"谁是主人"；没装 affinity 时按 `10001` 兜底，记得改。

## 排查

看某个会话此刻会注入什么：

```bash
cd <安装目录>
node --input-type=module -e "
import { providers } from 'file://$(pwd)/plugins/shared-memory/index.js';
console.log(providers['memory.shared-preview']({ chatKey: 'private:10001' }));
"
```

返回里的 `trusted` 表示这个会话是否白名单私聊，`semi` 表示白名单群，`chars` 是实际字数。

## 关掉

`skills["shared-memory"].enabled = false`，或直接删目录。
