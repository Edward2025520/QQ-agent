# pinned-facts · 固定事实

把"长期不变、不能被改写"的事实单独存一份，每轮注入提示词。

## 为什么不用记忆

核心的记忆整理会用模型重新生成的印象**整条替换**成员文件，手写进去的事实随时可能被冲掉。固定事实走独立文件 + 每轮注入，整理逻辑碰不到。

## 数据文件

`<安装目录>/data/pinned-facts.json`（不进仓库）：

```json
{
  "ownerQq": "10001",
  "facts": [
    "老大就是坑位，也叫 Kengway，是同一个人。",
    "老大的 QQ 号是 {{ownerQq}}，认人只认这个号。",
    "转达目标：private:{{ownerQq}}"
  ]
}
```

- `{{ownerQq}}` 会在渲染时替换：白名单私聊换真实号码，群聊换成"（号码不公开）"。
- 以「转达目标」开头的事实只在私聊注入，群里不出现。

## 排查

```bash
node --input-type=module -e "
import { providers } from 'file://<安装目录>/plugins/pinned-facts/index.js';
console.log(providers['pinned-facts.preview']({ chatKey: 'group:123' }).text);
"
```
