// 跨会话共享记忆（确定性型 / plugins/，纯 hooks + 一个检索工具）
//
// 解决什么：记忆是按会话存的，A 会话里聊过的事，换个会话就断了。
// 这里把「最近 N 小时、别的会话」的摘要与印象压成一小段，每轮追加到请求尾部；
// 更早的内容交给 shared-memory__recall 工具按需检索（7 天内）。
//
// 数据来源（只读，不新建存储）：
//   data/memory-v2/chunks/*.json   由 plugins/conversation-memory 按小时自动留档
//   data/memory/<chat>/<uid>.json  核心的群友印象
//
// 分层：白名单私聊里的对方算「熟人」，可以问出内容与原话；其他人（含群里）只给
// 公开口径 —— 不报老大名字/号码，不提私聊内容。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';

const DEFAULTS = {
  enabled: true,
  hours: 6,
  days: 7,
  maxChars: 900,
  maxLines: 12,
  maxRecallChars: 3000,
  includeCurrentChat: false
};

let api = null;
let promptCorePromise = null;

const CHUNK_DIR = path.join(DATA_DIR, 'memory-v2', 'chunks');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');

function settings() {
  let raw = null;
  try {
    raw = api && typeof api.config === 'function' ? api.config() : null;
  } catch { raw = null; }
  if (!raw) {
    try { raw = getConfig()?.skills?.['shared-memory'] || null; } catch { raw = null; }
  }
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw || {})) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function cfg() {
  try { return getConfig() || {}; } catch { return {}; }
}

function ownerQq() {
  const c = cfg();
  return String(c?.skills?.affinity?.ownerQq || '10001');
}

function ownerName() {
  const notes = cfg()?.memberNotes || {};
  return String(notes[ownerQq()] || '主人');
}

const chatLabel = (chatKey) => {
  const [kind, id] = String(chatKey || '').split(':');
  const notes = cfg()?.memberNotes || {};
  const name = notes[String(id)] ? `(${notes[String(id)]})` : '';
  if (kind === 'group') return `群 ${id}`;
  if (kind === 'private') return `私聊 ${id}${name}`;
  return String(chatKey || '?');
};

/** 熟人口径：只在白名单私聊里成立。 */
function isTrusted(chatKey) {
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'private') return false;
  const allow = cfg()?.allow?.private || [];
  return allow.map(String).includes(String(id));
}

const hhmm = (ts) => {
  const d = new Date(Number(ts) || 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const cut = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 最近 N 小时的自动留档片段（别的会话）。 */
function recentChunks(hours, chatKey, trusted) {
  let names = [];
  try { names = fs.readdirSync(CHUNK_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const since = Date.now() - hours * 3600e3;
  const out = [];
  for (const f of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CHUNK_DIR, f), 'utf8'));
      const when = Number(j?.when) || 0;
      if (!when || when < since) continue;
      const key = String(j?.chatKey || '');
      if (!key || key === chatKey) continue;
      if (!trusted && key.startsWith('private:')) continue; // 非熟人不看私聊内容
      const text = cut(j?.summary || j?.title || '', 80);
      if (!text) continue;
      out.push({ chatKey: key, when, text });
    } catch { /* 单个坏文件跳过 */ }
  }
  out.sort((a, b) => b.when - a.when);
  return out;
}

/** 最近 N 小时的跨会话印象。 */
function recentImpressions(days, chatKey) {
  const since = Date.now() - days * 86400e3;
  const notes = cfg()?.memberNotes || {};
  const byUid = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(MEMORY_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && /^(group|private)_\d+$/.test(e.name)); } catch { return []; }
  for (const d of dirs) {
    const key = d.name.replace(/^([a-z]+)_(\d+)$/, '$1:$2');
    if (key === chatKey) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(MEMORY_DIR, d.name)); } catch { continue; }
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, d.name, f), 'utf8'));
        const uid = String(j?.userId || f.replace('.json', ''));
        const imps = (Array.isArray(j?.impressions) ? j.impressions : [])
          .filter((x) => Number(x?.createdAt) >= since)
          .map((x) => cut(x?.content, 60))
          .filter(Boolean);
        if (!imps.length) continue;
        const cur = byUid.get(uid) || { uid, name: notes[uid] || String(j?.name || '') || uid, imps: [], seen: new Set() };
        for (const t of imps) {
          if (cur.seen.has(t)) continue;
          cur.seen.add(t);
          cur.imps.push(t);
        }
        byUid.set(uid, cur);
      } catch { /* 跳过 */ }
    }
  }
  return [...byUid.values()].slice(0, 4).map((m) => ({
    ...m,
    imps: m.imps.slice(-3)
  }));
}

/** 非熟人：把老大的名字与号码换成"老大"。 */
function scrub(text) {
  const name = ownerName();
  const qq = ownerQq();
  let out = String(text || '');
  for (const token of [name, qq]) {
    if (token) out = out.split(token).join('老大');
  }
  return out;
}

function buildDigest(chatKey, s = settings()) {
  const trusted = isTrusted(chatKey);
  const lines = [];
  for (const c of recentChunks(Number(s.hours) || 6, chatKey, trusted)) {
    lines.push(`· ${chatLabel(c.chatKey)} ${hhmm(c.when)}：${c.text}`);
  }
  for (const m of recentImpressions(Number(s.days) || 7, chatKey)) {
    const who = String(m.uid) === ownerQq()
      ? (trusted ? `${ownerName()}(QQ:${m.uid})` : '老大')
      : `${m.name}(QQ:${m.uid})`;
    lines.push(`· 你对 ${who} 的印象：${m.imps.join('｜')}`);
  }
  if (!lines.length) return { text: '', lines: 0, trusted };

  const head = `【共享记忆 · 最近 ${Number(s.hours) || 6} 小时你在别的会话里知道的事】`;
  const tail = [
    '（这些跨会话的事可以自然用上；7 天前的事已经忘了，别硬编。被问到细节不确定时，先调 shared-memory__recall 再答。）'
  ];
  if (!trusted) {
    tail.push('（对这个人/这个群：不要说出老大的名字或号码，也不要复述任何私聊内容。）');
  }

  const maxLines = Math.max(1, Number(s.maxLines) || 12);
  const maxChars = Math.max(100, Number(s.maxChars) || 900);
  const kept = [];
  let chars = head.length + tail.join('').length;
  for (const line of lines) {
    const text = trusted ? line : scrub(line);
    if (kept.length >= maxLines) break;
    if (chars + text.length > maxChars) break;
    kept.push(text);
    chars += text.length;
  }
  if (!kept.length) return { text: '', lines: 0, trusted };
  return { text: [head, ...kept, ...tail].join('\n'), lines: kept.length, trusted };
}

/** 追加到请求尾部（保 system 前缀缓存）；核心没有该函数时自己追加。 */
async function appendToTail(messages, text) {
  if (!Array.isArray(messages) || !text) return false;
  if (!promptCorePromise) {
    promptCorePromise = import('../../src/prompt.js').catch(() => null);
  }
  const core = await promptCorePromise;
  if (core && typeof core.appendDynamicTail === 'function') {
    try { if (core.appendDynamicTail(messages, text)) return true; } catch { /* 继续走回退 */ }
  }
  const block = `\n\n${String(text).trim()}`;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') { m.content += block; return true; }
    if (Array.isArray(m.content)) { m.content.push({ type: 'text', text: block }); return true; }
  }
  messages.push({ role: 'user', content: block.trim() });
  return true;
}

// ── 检索 ─────────────────────────────────────────────────────────────────

function searchChunks(query, { days, chatKey, trusted, limit }) {
  const since = Date.now() - Math.max(1, days) * 86400e3;
  const terms = String(query || '').toLowerCase().split(/[\s,，。？?！!、；;：:]+/).filter((t) => t.length >= 1);
  let names = [];
  try { names = fs.readdirSync(CHUNK_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const hits = [];
  for (const f of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CHUNK_DIR, f), 'utf8'));
      const when = Number(j?.when) || 0;
      if (!when || when < since) continue;
      const key = String(j?.chatKey || '');
      if (!trusted && key.startsWith('private:')) continue;
      const hay = [
        j?.title, j?.summary, ...(Array.isArray(j?.keywords) ? j.keywords : []),
        ...(Array.isArray(j?.snippets) ? j.snippets.map((x) => x?.text || '') : [])
      ].join(' ').toLowerCase();
      if (!hay) continue;
      let score = 0;
      for (const t of terms) {
        if (!t) continue;
        const idx = hay.indexOf(t);
        if (idx >= 0) score += 1;
      }
      if (!score) continue;
      hits.push({ chatKey: key, when, score, text: cut(j?.summary || j?.title || '', 160) });
    } catch { /* 跳过 */ }
  }
  hits.sort((a, b) => (b.score - a.score) || (b.when - a.when));
  return hits.slice(0, Math.max(1, limit));
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
  registerRecallTool(a);
}

export function available() {
  return settings().enabled !== false;
}

export function activate() {
  let chats = 0;
  try {
    chats = new Set(
      fs.readdirSync(CHUNK_DIR).filter((f) => f.endsWith('.json')).map((f) => {
        try { return String(JSON.parse(fs.readFileSync(path.join(CHUNK_DIR, f), 'utf8'))?.chatKey || ''); } catch { return ''; }
      }).filter(Boolean)
    ).size;
  } catch { chats = 0; }
  api?.log?.(`共享记忆已启用：${chats} 个会话有留档，热窗口 ${settings().hours} 小时，保留 ${settings().days} 天`);
}

export function deactivate() {
  promptCorePromise = null;
}

export const hooks = {
  async 'before-llm-messages'(ctx = {}) {
    const s = settings();
    if (s.enabled === false) return;
    try {
      const chatKey = String(ctx.chatKey || '');
      const { text } = buildDigest(chatKey, s);
      if (!text) return;
      await appendToTail(ctx.messages, text);
    } catch { /* 注入失败不影响正常回复 */ }
  }
};

// ── 工具 ──────────────────────────────────────────────────────────────────

function registerRecallTool(a) {
  if (!a || typeof a.registerTool !== 'function') return;
  a.registerTool({
    id: 'recall',
    name: '跨会话记忆检索',
    description:
      '检索最近 7 天内所有会话（群聊和私聊）的聊天留档，用来回答"别人/别的群最近聊了什么""某人说过什么"这类你不在场时发生的事。' +
      '被问到这类问题，先调用它再回答，不要凭印象编。query 传关键词或人名，可以多试几个词。',
    category: 'query',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词、人名或想找的话题' },
        days: { type: 'number', description: '回溯天数，默认 7，最大 7' },
        limit: { type: 'number', description: '最多返回几条，默认 5' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        const s = settings();
        const chatKey = String(ctx?.chatKey || '');
        const trusted = isTrusted(chatKey);
        const days = Math.min(Number(s.days) || 7, Math.max(1, Number(args?.days) || 7));
        const limit = Math.max(1, Math.min(10, Number(args?.limit) || 5));
        const query = String(args?.query ?? '').trim();
        if (!query) return { content: '请给一个关键词。', isError: true };
        const hits = searchChunks(query, { days, chatKey, trusted, limit });
        if (!hits.length) {
          return { content: `最近 ${days} 天没有和「${query}」相关的留档。` };
        }
        const lines = hits.map((h) => {
          const t = `${chatLabel(h.chatKey)} ${hhmm(h.when)}：${h.text}`;
          return `· ${trusted ? t : scrub(t)}`;
        });
        let text = `【跨会话检索 · 关键词「${query}」】\n${lines.join('\n')}`;
        const max = Math.max(200, Number(s.maxRecallChars) || 3000);
        if (text.length > max) text = `${text.slice(0, max)}…`;
        return { content: text };
      } catch (error) {
        return { content: `检索失败：${String(error?.message ?? error)}`, isError: true };
      }
    }
  });
}

// ── 能力：排查用 ─────────────────────────────────────────────────────────

export const providers = {
  /** 预览某个会话此刻会看到的注入文本。args: { chatKey } */
  'memory.shared-preview': (args = {}) => {
    const chatKey = String(args?.chatKey || '');
    const s = settings();
    const d = buildDigest(chatKey, s);
    return {
      ok: true,
      chatKey,
      trusted: d.trusted,
      lines: d.lines,
      chars: d.text.length,
      text: d.text
    };
  }
};
