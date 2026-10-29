# qq-file-reader 支持老 .doc（2026-10-29）

`skills/qq-file-reader` 原来只认 `.pdf/.docx/.xlsx/.pptx`，Word 97-2003 的 `.doc` 直接被拒（"不支持的格式"）。

## 补丁做了什么

1. 扩展名白名单加 `.doc` / `.rtf` / `.wps`，并新增 `LEGACY_EXTS`。
2. 新增 `convertLegacy()`：先用 `soffice --headless --convert-to docx` 转换（45 秒超时，独立临时 profile），再用原有的 `extract.py` 抽取（表格会保留成 `单元格 | 单元格`）。
3. LibreOffice 不可用或超时 → 退 `antiword` 出纯文本；都不行才报错并提示"存成 docx 再发我"。
4. 两个入口都接上了：`read_file_message`（聊天里收到的文件）和 `read_local_doc`（白名单目录里的文件）。

## 依赖

```bash
apt-get install -y --no-install-recommends libreoffice-writer antiword
```

- `libreoffice-writer` 约 300~400MB，转换时瞬时吃 150~300MB 内存；1.7G 内存的机器建议先看 `free -m`。
- `antiword` 几十 KB，只作为兜底。

## 应用

```bash
cd <QQ-agent 安装目录>
patch -p1 < modules/patches/2026-10-29-qq-file-reader-doc/qq-file-reader-doc.patch
systemctl restart qq-agent
```

补丁基于 2026-10-24 的本机版本；如果你的 `qq-file-reader` 版本不同，按上面 4 点手工迁移。

## 验证

```bash
# 造一份带表格的 docx 再转 doc，走 read_local_doc 读一次
soffice --headless --convert-to doc --outdir /tmp /tmp/test.docx
```

期望输出里同时有正文和 `R1C1 | R1C2` 这样的表格行。

## 已知限制

- 老 `.doc` 里如果是图片版表格（截图），文本抽取读不到，只能靠视觉模型。
- 转换首次会建 LibreOffice profile，第一次 20~40 秒，之后快。
