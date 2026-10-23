// 好友回信通知（确定性型 / plugins/，纯 hooks）
//
// 场景：主人在私聊里让呆猫去跟某个好友说句话（friend-dm 技能负责发）。
// 对方回了以后，主人想知道 —— 这里在每轮结束后把「对方说了什么 + 呆猫回了什么」
// 合并成一条，推到主人私聊。
//
// 为什么用 OneBot HTTP 而不是复用 sender：hook 的载荷里没有 sender（orchestrator
// 只传 chatKey/kind/model 等），自己 new 一个 OneBotClient 又会多开一条 WS 把事件
// 收两遍。HTTP 是一次性请求，没有副作用。
import { getConfig } from '../../src/config.js';

const DEFAULTS = {
  enabled: true,
  debounceSec: 15,
  maxChars: 400,
  dryRun: false
};

let api = null;
const pending = new Map(); // qq -> { peer: [], bot: [], timer }

const cut = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function settings() {
  let raw = null;
  try { raw = api && typeof api.config === 'function' ? api.config() : null; } catch { raw = null; }
  if (!raw) {
    try { raw = getConfig()?.skills?.['dm-notice'] || null; } catch { raw = null; }
  }
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw || {})) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function friendConfig() {
  const c = (() => { try { return getConfig() || {}; } catch { return {}; } })();
  const s = c?.skills?.['friend-dm'] || {};
  const friends = (Array.isArray(s.friends) ? s.friends : [])
    .map((f) => String(f?.qq ?? f?.id ?? '').trim())
    .filter((q) => /^\d{5,15}$/.test(q));
  const ownerIds = Array.isArray(s.ownerIds)
    ? s.ownerIds.map(String)
    : String(s.ownerIds ?? '').split(/[,，;；\s]+/).filter(Boolean);
  return { friends, owner: ownerIds[0] || '10001' };
}

async function sendToOwner(text) {
  const c = (() => { try { return getConfig() || {}; } catch { return {}; } })();
  const base = String(c?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(c?.snowluma?.httpAccessToken || c?.snowluma?.accessToken || '');
  const { owner } = friendConfig();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/send_private_msg`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ user_id: Number(owner), message: text, auto_escape: true })
  });
  const body = await res.text();
  if (!res.ok || !/"retcode":0/.test(body)) throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
  return body;
}

function flush(qq) {
  const job = pending.get(qq);
  if (!job) return;
  clearTimeout(job.timer);
  pending.delete(qq);
  if (!job.peer.length && !job.bot.length) return;

  const s = settings();
  const lines = [`【通知】${job.alias || `QQ ${qq}`} 那边`];
  if (job.peer.length) lines.push(`对方：${job.peer.join(' / ')}`);
  if (job.bot.length) lines.push(`呆猫：${job.bot.join(' / ')}`);
  let text = lines.join('\n');
  const max = Math.max(100, Number(s.maxChars) || 400);
  if (text.length > max) text = `${text.slice(0, max)}…`;

  if (s.dryRun) {
    api?.log?.(`[dm-notice] dryRun：${text.replace(/\n/g, ' | ')}`);
    return;
  }
  sendToOwner(text)
    .then(() => api?.log?.(`[dm-notice] 已通知主人：${qq}`))
    .catch((error) => api?.log?.(`[dm-notice] 通知失败：${error?.message ?? error}`));
}

export function setup(a) {
  api = a;
}

export function available() {
  return settings().enabled !== false;
}

export function activate() {
  const { friends } = friendConfig();
  api?.log?.(`好友回信通知已启用：名单 ${friends.join('、') || '（空）'}，去抖 ${settings().debounceSec} 秒`);
}

export function deactivate() {
  for (const [qq, job] of pending) clearTimeout(job.timer);
  pending.clear();
}

export const hooks = {
  async 'after-response'(ctx = {}) {
    const s = settings();
    if (s.enabled === false) return;
    try {
      const chatKey = String(ctx.chatKey || '');
      if (!chatKey.startsWith('private:')) return;
      const qq = chatKey.split(':')[1];
      const { friends } = friendConfig();
      if (!friends.includes(qq)) return;

      const peer = (Array.isArray(ctx.session?.triggerEntries) ? ctx.session.triggerEntries : [])
        .filter((m) => m && !m.self)
        .map((m) => cut(m.text || (m.isPoke ? '[拍一拍]' : ''), 60))
        .filter(Boolean)
        .slice(-3);
      const bot = (Array.isArray(ctx.session?.sent) ? ctx.session.sent : [])
        .filter((m) => m && typeof m.text === 'string' && (!m.to || String(m.to) === chatKey))
        .map((m) => cut(m.text, 60))
        .filter(Boolean)
        .slice(-3);
      if (!peer.length && !bot.length) return;

      const job = pending.get(qq) || { peer: [], bot: [], timer: null, alias: '' };
      for (const t of peer) if (!job.peer.includes(t)) job.peer.push(t);
      for (const t of bot) if (!job.bot.includes(t)) job.bot.push(t);
      job.alias = job.alias || (() => {
        try {
          const list = getConfig()?.skills?.['friend-dm']?.friends || [];
          const hit = list.find((f) => String(f?.qq) === qq);
          return String(hit?.alias || '');
        } catch { return ''; }
      })();
      clearTimeout(job.timer);
      job.timer = setTimeout(() => flush(qq), Math.max(3, Number(s.debounceSec) || 15) * 1000);
      job.timer.unref?.();
      pending.set(qq, job);
    } catch { /* 通知失败不影响主流程 */ }
  }
};
