// 好友申请 / 入群邀请：通知主人 + 一句话批准。
//
// 背景：core 的 app.js 会把 post_type=request 交给 skillManager 的 friend.request /
// group.request 钩子；share-card 那套是"自动同意"思路，和本机口径（只通知、由主人决定）
// 不一样，所以单独做一个插件，行为完全可控。
//
// 安全：只有 ownerIds 里的人能批准/拒绝；flag 只落盘不写日志。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';

const DEFAULTS = { enabled: true, ownerIds: '10001', notify: true, ttlMinutes: 30, maxRecords: 50 };
const FILE = path.join(DATA_DIR, 'friend-requests.json');

let api = null;

const cut = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function settings() {
  let raw = null;
  try { raw = api && typeof api.config === 'function' ? api.config() : null; } catch { raw = null; }
  if (!raw) {
    try { raw = getConfig()?.skills?.['friend-requests'] || null; } catch { raw = null; }
  }
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw || {})) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

function owners() {
  return String(settings().ownerIds || '')
    .split(/[,，;；\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^\d{5,15}$/.test(x));
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(raw?.items) ? raw.items : [];
  } catch { return []; }
}

function save(items) {
  const max = Math.max(10, Number(settings().maxRecords) || 50);
  const trimmed = items.slice(-max);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: trimmed }, null, 1), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch { /* 落盘失败不影响通知 */ }
  return trimmed;
}

function nextId(items) {
  return items.reduce((n, x) => Math.max(n, Number(x.id) || 0), 0) + 1;
}

async function notifyOwner(text) {
  const c = (() => { try { return getConfig() || {}; } catch { return {}; } })();
  const base = String(c?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(c?.snowluma?.httpAccessToken || c?.snowluma?.accessToken || '');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (const owner of owners()) {
    try {
      const res = await fetch(`${base}/send_private_msg`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ user_id: Number(owner), message: text, auto_escape: true })
      });
      const body = await res.text();
      if (!res.ok || !/"retcode":0/.test(body)) throw new Error(`HTTP ${res.status} ${body.slice(0, 80)}`);
    } catch (error) {
      api?.log?.(`[friend-requests] 通知 ${owner} 失败：${error?.message ?? error}`);
    }
  }
}

function recordFrom(kind, event) {
  const userId = String(event?.user_id ?? '');
  const groupId = event?.group_id != null ? String(event.group_id) : '';
  return {
    kind,
    userId,
    groupId,
    nickname: String(event?.nickname || event?.name || event?.user_name || '').slice(0, 40),
    comment: cut(event?.comment, 200),
    flag: String(event?.flag || ''),
    subType: String(event?.sub_type || ''),
    at: Date.now(),
    status: 'pending'
  };
}

function summary(item, ttlMs) {
  const head = item.kind === 'friend'
    ? `【好友申请 #${item.id}】${item.nickname || '昵称未知'}${item.userId && item.userId !== '0' ? `（QQ ${item.userId}）` : ''}`
    : `【入群邀请 #${item.id}】群 ${item.groupId || '?'}，邀请人 ${item.userId || '?'}`;
  const left = Math.max(0, Math.round((ttlMs - (Date.now() - item.at)) / 60000));
  // 单行短消息：多行在 QQ 里容易被折叠，主人可能只看到第一行。
  const parts = [head];
  if (item.comment) parts.push(`理由：${item.comment}`);
  parts.push(item.status === 'pending'
    ? `回数字 ${item.id} 同意，回「拒 ${item.id}」拒绝（约 ${left} 分钟有效）`
    : `状态：${item.status}`);
  return parts.join('｜');
}

function callerId(ctx) {
  const trig = Array.isArray(ctx?.session?.trigger) ? ctx.session.trigger : [];
  for (let i = trig.length - 1; i >= 0; i -= 1) {
    const id = String(trig[i]?.senderId ?? '').trim();
    if (id && id !== 'self' && trig[i]?.self !== true) return id;
  }
  if (ctx?.kind === 'private') return String(ctx?.chatId ?? '');
  return '';
}

function ok(v) { return { content: JSON.stringify(v, null, 2) }; }
function fail(msg) { return { content: JSON.stringify({ ok: false, error: msg }), isError: true }; }

export function setup(a) {
  api = a;
  const common = { type: 'object', additionalProperties: false };

  a.registerTool({
    id: 'list',
    name: '待处理的好友申请',
    description: '列出还没处理的好友申请和入群邀请（带编号）。主人专用。',
    category: 'query',
    icon: '📨',
    parameters: { ...common, properties: {} },
    async execute(ctx) {
      if (!owners().includes(callerId(ctx))) return fail('只有主人能查看');
      const ttl = Math.max(5, Number(settings().ttlMinutes) || 30) * 60000;
      const items = load().filter((x) => x.status === 'pending');
      if (!items.length) return ok({ ok: true, count: 0, note: '目前没有待处理的申请' });
      return ok({ ok: true, count: items.length, items: items.map((x) => summary(x, ttl)) });
    }
  });

  a.registerTool({
    id: 'handle',
    name: '处理好友申请',
    description: '同意或拒绝一条好友申请 / 入群邀请。参数 id 是通知里的编号，approve 为 true 表示同意。只有主人能用。',
    category: 'message',
    icon: '✅',
    parameters: {
      ...common,
      properties: {
        id: { type: 'number', description: '通知里的编号，例如 3' },
        approve: { type: 'boolean', description: 'true=同意，false=拒绝' },
        reason: { type: 'string', description: '拒绝理由，可选' }
      },
      required: ['id', 'approve']
    },
    async execute(ctx, args) {
      if (!owners().includes(callerId(ctx))) return fail('只有主人能处理');
      const id = Number(args?.id);
      if (!Number.isFinite(id)) return fail('id 不对');
      const items = load();
      const item = items.find((x) => Number(x.id) === id);
      if (!item) return fail(`没有 #${id} 这条申请`);
      if (item.status !== 'pending') return fail(`#${id} 已经处理过了（${item.status}）`);
      if (!item.flag) return fail('这条申请没带 flag，无法处理');
      const approve = args?.approve === true;
      const action = item.kind === 'friend' ? 'set_friend_add_request' : 'set_group_add_request';
      const params = item.kind === 'friend'
        ? { flag: item.flag, approve }
        : { flag: item.flag, sub_type: item.subType || 'invite', approve, reason: String(args?.reason || '') };
      try {
        await ctx.onebot.call(action, params);
      } catch (error) {
        item.status = 'failed';
        item.error = String(error?.message ?? error).slice(0, 200);
        save(items);
        return fail(`处理失败：${item.error}。flag 可能已过期，去 QQ 里手动点一下。`);
      }
      item.status = approve ? 'approved' : 'rejected';
      item.handledAt = Date.now();
      save(items);
      return ok({ ok: true, id, result: item.status, who: item.nickname || item.userId });
    }
  });
}

export function available() {
  return settings().enabled !== false;
}

export function activate() {
  const pending = load().filter((x) => x.status === 'pending').length;
  api?.log?.(`好友申请通知已启用：主人 ${owners().join('、') || '（未配置）'}，待处理 ${pending} 条`);
}

export const hooks = {
  async 'friend.request'(payload = {}) { await onRequest('friend', payload); },
  async 'group.request'(payload = {}) { await onRequest('group', payload); }
};

async function onRequest(kind, payload) {
  const s = settings();
  if (s.enabled === false) return;
  const event = payload?.event || {};
  if (!String(event.flag || '')) return;
  const items = load();
  const rec = recordFrom(kind, event);
  rec.id = nextId(items);
  items.push(rec);
  save(items);
  api?.log?.(`[friend-requests] 收到 ${kind} 请求 #${rec.id}（${rec.nickname || rec.userId || rec.groupId}）`);
  if (s.notify === false) return;
  const ttl = Math.max(5, Number(s.ttlMinutes) || 30) * 60000;
  await notifyOwner(summary(rec, ttl));
}
