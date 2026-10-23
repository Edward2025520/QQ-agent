// 好友私信：知道自己的好友列表，并能给名单里的人发私聊。
//
// 设计取舍：
//   · 名单是**唯一可信来源**，不在名单里的一律不发，避免模型手滑发给陌生人。
//   · 名单与 QQ 私聊白名单联动：加人时同时写 allow.private，否则对方回消息会被入口丢掉。
//   · 自主发送没有独立的调度器可用（setup 与钩子都拿不到 sender），
//     所以沿用同类插件的做法：首次工具执行时记住 ctx，之后用定时器复查。
//   · 内容由模型用 chatCompletion 现写，不套模板。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = globalThis.__qqAgentRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { DATA_DIR, getConfig, updateConfig } = await import(pathToFileURL(path.join(appRoot, 'src/config.js')).href);

const SKILL_ID = 'friend-dm';
const QQ_ID = /^\d{5,15}$/;
const TICK_MS = 60_000;
const MAX_CONTENT = 500;
const STATE_FILE = path.join(DATA_DIR, SKILL_ID, 'state.json');

let settingsFn = () => ({});
let apiRef = null;
let liveCtx = null;
let timer = null;
let ticking = false;

const now = () => Date.now();
const bjDay = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const ok = (v) => ({ content: JSON.stringify(v, null, 2) });
const fail = (msg) => ({ content: JSON.stringify({ ok: false, error: msg }), isError: true });

function toInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function parseIds(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，;；\s]+/);
  const out = [];
  for (const item of list) {
    const id = String(item ?? '').trim();
    if (QQ_ID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function cfg() {
  const c = settingsFn() || {};
  return {
    ownerIds: parseIds(c.ownerIds),
    autonomy: c.autonomy !== false,
    dailyCapPerFriend: toInt(c.dailyCapPerFriend, 1, 0, 50),
    manualDailyCap: toInt(c.manualDailyCap, 5, 0, 100),
    minIntervalHours: toInt(c.minIntervalHours, 24, 1, 24 * 30),
    quietStart: String(c.quietStart ?? '22:00'),
    quietEnd: String(c.quietEnd ?? '08:00'),
    maxAutonomyPerDay: toInt(c.maxAutonomyPerDay, 3, 0, 50),
    reportToOwner: c.reportToOwner !== false,
    dryRun: c.dryRun === true
  };
}

// ── 名单 ──

function roster() {
  const raw = settingsFn()?.friends;
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const qq = String(item?.qq ?? item?.id ?? '').trim();
    if (!QQ_ID.test(qq)) continue;
    if (out.some((f) => f.qq === qq)) continue;
    out.push({ qq, alias: String(item?.alias ?? '').trim(), note: String(item?.note ?? '').trim() });
  }
  return out;
}

function saveRoster(list) {
  // 技能配置是**扁平的**：getSkillConfig 直接读 config.skills[id] 的顶层键，
  // 写成 { settings: {...} } 会让 api.config() 永远读不到名单。
  updateConfig({ skills: { [SKILL_ID]: { friends: list } } });
}

function findFriend(target) {
  const key = String(target ?? '').trim();
  if (!key) return null;
  const list = roster();
  return list.find((f) => f.qq === key) || list.find((f) => f.alias && f.alias === key) || null;
}

// ── 状态 ──

function emptyState() {
  return { version: 1, sent: {}, autonomy: { day: '', count: 0 }, log: [] };
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s?.version !== 1 || typeof s.sent !== 'object') return emptyState();
    if (!s.autonomy || typeof s.autonomy !== 'object') s.autonomy = { day: '', count: 0 };
    if (!Array.isArray(s.log)) s.log = [];
    return s;
  } catch {
    return emptyState();
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function record(state, qq, text, autonomous) {
  const ts = now();
  const day = bjDay(ts);
  const prev = state.sent[qq] || { last: 0, day: '', count: 0 };
  state.sent[qq] = { last: ts, day, count: prev.day === day ? prev.count + 1 : 1 };
  if (autonomous) {
    state.autonomy = state.autonomy?.day === day
      ? { day, count: Number(state.autonomy.count || 0) + 1 }
      : { day, count: 1 };
  }
  state.log.push({ at: ts, qq, autonomous, text: String(text).slice(0, 200) });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
  saveState(state);
}

// ── 时间窗 ──

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function inQuietHours(ts, start, end) {
  const s = minutesOf(start);
  const e = minutesOf(end);
  if (s === null || e === null || s === e) return false;
  const d = new Date(ts + 8 * 3600_000);
  const cur = d.getUTCHours() * 60 + d.getUTCMinutes();
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

// ── 调用者判定 ──

function callerId(ctx) {
  const trigger = Array.isArray(ctx?.session?.trigger) ? ctx.session.trigger : [];
  for (let i = trigger.length - 1; i >= 0; i -= 1) {
    const entry = trigger[i];
    const id = String(entry?.senderId ?? '').trim();
    if (id && id !== 'self' && entry?.self !== true) return id;
  }
  if (ctx?.kind === 'private') return String(ctx?.chatId ?? '');
  return '';
}

function ownerOnly(ctx) {
  const id = callerId(ctx);
  if (!id) return '无法确认发送者身份，拒绝操作';
  if (String(ctx?.kind) !== 'private') return '好友私信命令只接受私聊里下的';
  if (!cfg().ownerIds.includes(id)) return `QQ ${id} 不在主人名单里，拒绝操作`;
  return '';
}

// ── 限额 ──

// mode: 'auto' 走静默时段 + 严格间隔 + 每人每日 1 条；
//       'manual' 是主人明确下的指令，不受静默时段和最短间隔约束，只保留每日上限，
//       否则半夜被叫去传话会被自己的规则拦下来。
function limitReason(qq, state, c = cfg(), mode = 'auto') {
  const ts = now();
  const manual = mode === 'manual';
  if (!manual && inQuietHours(ts, c.quietStart, c.quietEnd)) {
    return `现在是静默时段（${c.quietStart}–${c.quietEnd}），不发`;
  }
  const rec = state.sent[qq];
  if (rec) {
    const cap = manual ? c.manualDailyCap : c.dailyCapPerFriend;
    if (cap > 0 && rec.day === bjDay(ts) && rec.count >= cap) {
      return `今天已经给他发过 ${rec.count} 条，达到每日上限（${cap} 条）`;
    }
    if (!manual && rec.last && ts - rec.last < c.minIntervalHours * 3600_000) {
      const left = Math.ceil((c.minIntervalHours * 3600_000 - (ts - rec.last)) / 3600_000);
      return `距离上次发送不足 ${c.minIntervalHours} 小时，还要等约 ${left} 小时`;
    }
  }
  return '';
}

// ── 发送 ──

async function deliver(ctx, qq, text) {
  await ctx.sender.sendTextBatch(`private:${qq}`, [text], {});
}

function aliasOf(friend) {
  return friend.alias || friend.qq;
}

// ── 上下文：记忆与最近对话 ──
// 自主发送最容易出的问题是"凭空写一句"，所以尽量把已知信息喂给模型：
// 印象来自核心的 memory 文件，最近对话来自该私聊的存档（不存在就跳过）。

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function memoryOf(qq) {
  const data = readJson(path.join(DATA_DIR, 'memory', `private_${qq}`, `${qq}.json`));
  const list = Array.isArray(data?.impressions) ? data.impressions : [];
  return list.slice(-3).map((x) => String(x?.content ?? '').trim()).filter(Boolean);
}

function recentChatOf(qq, limit = 8) {
  const data = readJson(path.join(DATA_DIR, 'messages', `private_${qq}.json`));
  const list = Array.isArray(data?.messages) ? data.messages : [];
  return list.slice(-limit).map((m) => {
    const who = m?.self ? '我' : String(m?.senderName ?? '对方');
    return `${who}: ${String(m?.text ?? '').replace(/\s+/g, ' ').slice(0, 80)}`;
  }).filter((line) => line.length > 4);
}

function contextFor(friend) {
  const parts = [];
  const impressions = memoryOf(friend.qq);
  if (impressions.length) parts.push(`你对这个人的印象：\n${impressions.map((t) => `- ${t}`).join('\n')}`);
  const recent = recentChatOf(friend.qq);
  if (recent.length) parts.push(`你们最近聊过：\n${recent.join('\n')}`);
  if (friend.note) parts.push(`主人给他的备注：${friend.note}`);
  return parts.join('\n\n');
}

/** 模型偶尔会把整句包在引号里或带回车，发送前统一收一下。 */
function cleanOut(text) {
  let out = String(text ?? '').trim();
  out = out.replace(/\r/g, '').replace(/\n+/g, ' ');
  out = out.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  out = out.replace(/^[-—*·]\s*/, '');
  return out;
}

/** 同一句话在 24 小时内不重复发给同一个人。 */
function isRepeat(state, qq, text) {
  const ts = now();
  return (state.log || []).some((item) => item?.qq === qq
    && typeof item.text === 'string'
    && ts - Number(item.at || 0) < 86400_000
    && item.text.trim() === text.trim());
}

// ── 自主发送 ──

function startTimer() {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref?.();
}

async function compose(friend, state) {
  const { chatCompletion } = await import(pathToFileURL(path.join(appRoot, 'src/llm.js')).href);
  const persona = String(getConfig()?.persona?.roleText ?? '').slice(0, 1800);
  const last = state.sent?.[friend.qq]?.last;
  const lastText = last ? `${Math.floor((now() - last) / 86400_000)} 天前联系过` : '还没联系过';
  const context = contextFor(friend);
  const messages = [
    {
      role: 'system',
      content: `${persona}\n\n现在你要主动给一个朋友发一条 QQ 私聊。对方不知道你是机器人，也不要说自己是。只输出要发的那句话本身，不要解释、不要加引号、不要括号动作。`
    },
    {
      role: 'user',
      content: `${context ? `${context}\n\n` : ''}朋友：${aliasOf(friend)}\n上次联系：${lastText}\n写一句自然、具体、不超过 40 个字的话。不要重复你们已经说过的内容。`
    }
  ];
  const res = await chatCompletion({ messages, temperature: 1, maxTokens: 200 });
  return String(res?.message?.content ?? '').trim();
}

async function tick() {
  if (ticking || !liveCtx) return;
  const c = cfg();
  if (!c.autonomy || c.dryRun) return;
  // 没有主人号就别自主发：没人能叫停，也没人收回报
  if (!c.ownerIds.length) return;
  // 开关关掉后 deactivate 会清定时器，但兜一层：技能被判失效时不发
  try {
    if (apiRef && !apiRef.isSkillActive(SKILL_ID, liveCtx)) return;
  } catch { /* 判定本身失败时按"不确定"处理，继续走限额检查 */ }
  ticking = true;
  try {
    const state = loadState();
    const day = bjDay(now());
    const usedToday = state.autonomy?.day === day ? Number(state.autonomy.count || 0) : 0;
    if (c.maxAutonomyPerDay > 0 && usedToday >= c.maxAutonomyPerDay) return;

    const due = roster()
      .filter((f) => !limitReason(f.qq, state, c))
      .sort((a, b) => (state.sent?.[a.qq]?.last || 0) - (state.sent?.[b.qq]?.last || 0));
    const friend = due[0];
    if (!friend) return;

    const text = cleanOut(await compose(friend, state)).slice(0, MAX_CONTENT);
    if (!text) return;
    // compose 期间可能有过一次手动发送，写盘前重新读，避免覆盖掉那次的计数
    const fresh = loadState();
    if (isRepeat(fresh, friend.qq, text)) return;
    if (limitReason(friend.qq, fresh, c)) return;
    await deliver(liveCtx, friend.qq, text);
    record(fresh, friend.qq, text, true);

    if (c.reportToOwner) {
      for (const owner of c.ownerIds) {
        try {
          await liveCtx.sender.sendTextBatch(`private:${owner}`, [`刚给${aliasOf(friend)}发了：${text}`], {});
        } catch { /* 回报失败不影响已经发出的那条 */ }
      }
    }
  } catch (error) {
    try {
      const state = loadState();
      state.log.push({ at: now(), error: String(error?.message ?? error).slice(0, 200) });
      saveState(state);
    } catch { /* 日志写不进去不影响主流程 */ }
  } finally {
    ticking = false;
  }
}

// ── 工具 ──

async function friendRoster(ctx, args = {}) {
  liveCtx = ctx;
  startTimer();
  const op = String(args.op ?? 'list').trim();
  const list = roster();

  if (op === 'list') {
    const c = cfg();
    const state = loadState();
    return ok({
      ok: true,
      friends: list.map((f) => ({
        qq: f.qq,
        alias: aliasOf(f),
        note: f.note,
        lastSent: state.sent?.[f.qq]?.last ? new Date(state.sent[f.qq].last).toLocaleString('zh-CN') : null,
        todayCount: state.sent?.[f.qq]?.day === bjDay(now()) ? state.sent[f.qq].count : 0
      })),
      limits: {
        dailyCapPerFriend: c.dailyCapPerFriend,
        manualDailyCap: c.manualDailyCap,
        minIntervalHours: c.minIntervalHours,
        quiet: `${c.quietStart}–${c.quietEnd}`,
        autonomy: c.autonomy,
        dryRun: c.dryRun
      }
    });
  }

  const deny = ownerOnly(ctx);
  if (deny) return fail(deny);

  if (op === 'add') {
    const qq = String(args.qq ?? '').trim();
    if (!QQ_ID.test(qq)) return fail('QQ 号格式不对，应为 5~15 位数字');
    if (qq === String(ctx?.selfId ?? '')) return fail('不能把自己加进好友名单');
    if (list.some((f) => f.qq === qq)) return fail(`QQ ${qq} 已经在名单里`);

    let friends = [];
    try {
      const raw = await ctx.onebot.call('get_friend_list');
      friends = Array.isArray(raw) ? raw : (raw?.data ?? []);
    } catch (error) {
      return fail(`读取好友列表失败：${error?.message ?? error}`);
    }
    const hit = friends.find((f) => String(f?.user_id ?? '') === qq);
    if (!hit) return fail(`QQ ${qq} 不在机器人的好友列表里，拒绝添加`);

    const alias = String(args.alias ?? '').trim() || String(hit.remark || hit.nickname || qq);
    const note = String(args.note ?? '').trim();
    saveRoster([...list, { qq, alias, note }]);

    const core = getConfig();
    const allowPrivate = Array.isArray(core?.allow?.private) ? core.allow.private.map(String) : [];
    let whitelisted = allowPrivate.includes(qq);
    if (!whitelisted) {
      updateConfig({ allow: { private: [...allowPrivate, qq] } });
      whitelisted = true;
    }
    return ok({ ok: true, added: { qq, alias, note }, whitelisted });
  }

  if (op === 'remove') {
    const qq = String(args.qq ?? '').trim();
    const next = list.filter((f) => f.qq !== qq);
    if (next.length === list.length) return fail(`QQ ${qq} 不在名单里`);
    saveRoster(next);
    let unwhitelisted = false;
    if (args.alsoUnwhitelist === true) {
      const core = getConfig();
      const allowPrivate = Array.isArray(core?.allow?.private) ? core.allow.private.map(String) : [];
      if (allowPrivate.includes(qq)) {
        updateConfig({ allow: { private: allowPrivate.filter((id) => id !== qq) } });
        unwhitelisted = true;
      }
    }
    return ok({
      ok: true,
      removed: qq,
      unwhitelisted,
      note: unwhitelisted
        ? '已从名单和私聊白名单移除，他再发消息机器人不会处理。'
        : '只从好友名单移除，私聊白名单没动；要一起移除请传 alsoUnwhitelist=true。'
    });
  }

  if (op === 'set_note') {
    const qq = String(args.qq ?? '').trim();
    const next = list.map((f) => (f.qq === qq
      ? { ...f, alias: String(args.alias ?? f.alias).trim() || f.alias, note: String(args.note ?? f.note).trim() }
      : f));
    if (!next.some((f) => f.qq === qq)) return fail(`QQ ${qq} 不在名单里`);
    saveRoster(next);
    return ok({ ok: true, updated: qq });
  }

  return fail(`未知操作：${op}，只支持 list / add / remove / set_note`);
}

async function friendDm(ctx, args = {}) {
  liveCtx = ctx;
  startTimer();

  const deny = ownerOnly(ctx);
  if (deny) return fail(deny);

  const friend = findFriend(args.target);
  if (!friend) return fail(`「${args.target ?? ''}」不在好友名单里，先用 friend_roster 添加`);

  const text = String(args.content ?? '').trim();
  if (!text) return fail('消息内容不能为空');
  if ([...text].length > MAX_CONTENT) return fail(`消息太长，上限 ${MAX_CONTENT} 字`);

  const c = cfg();
  const state = loadState();
  const reason = limitReason(friend.qq, state, c, 'manual');
  if (reason) return fail(reason);

  if (c.dryRun) {
    state.log.push({ at: now(), qq: friend.qq, dryRun: true, text: text.slice(0, 200) });
    saveState(state);
    return ok({ ok: true, dryRun: true, wouldSendTo: aliasOf(friend), text });
  }

  try {
    await deliver(ctx, friend.qq, text);
  } catch (error) {
    return fail(`发送失败：${error?.message ?? error}`);
  }
  record(state, friend.qq, text, false);
  return ok({ ok: true, sentTo: aliasOf(friend), text });
}

async function friendDmStatus(ctx) {
  liveCtx = ctx;
  startTimer();
  const c = cfg();
  const state = loadState();
  const day = bjDay(now());
  return ok({
    ok: true,
    ownerIds: c.ownerIds,
    autonomy: c.autonomy,
    dryRun: c.dryRun,
    quiet: `${c.quietStart}–${c.quietEnd}`,
    inQuietHours: inQuietHours(now(), c.quietStart, c.quietEnd),
    limits: { dailyCapPerFriend: c.dailyCapPerFriend, manualDailyCap: c.manualDailyCap, minIntervalHours: c.minIntervalHours, maxAutonomyPerDay: c.maxAutonomyPerDay },
    manualNote: `主人手动发送：不受静默时段、不受最短间隔；每人每日上限 ${c.manualDailyCap === 0 ? '不限' : `${c.manualDailyCap} 条`}`,
    quietAppliesToManual: false,
    autonomyUsedToday: state.autonomy?.day === day ? state.autonomy.count : 0,
    recent: (state.log || []).slice(-5).map((item) => ({
      at: new Date(Number(item.at || 0)).toLocaleString('zh-CN'),
      qq: item.qq || null,
      autonomous: item.autonomous === true,
      dryRun: item.dryRun === true,
      text: item.text || null,
      error: item.error || null
    })),
    friends: roster().map((f) => ({
      qq: f.qq,
      alias: aliasOf(f),
      note: f.note,
      lastSent: state.sent?.[f.qq]?.last ? new Date(state.sent[f.qq].last).toLocaleString('zh-CN') : null,
      todayCount: state.sent?.[f.qq]?.day === day ? state.sent[f.qq].count : 0,
      blocked: limitReason(f.qq, state, c, "manual") || null,
      blockedAuto: limitReason(f.qq, state, c, "auto") || null
    }))
  });
}

// ── 生命周期 ──

export function setup(api) {
  settingsFn = api.config;
  apiRef = api;
  const common = { type: 'object', additionalProperties: false };

  api.registerTool({
    id: 'friend_roster',
    name: '好友名单',
    description: '查看或维护可以私信的好友名单。op=add 会把对方加进名单并同时加进私聊白名单（这样他回消息机器人才能收到）；op=remove 只从名单移除，不动白名单。只有主人能改。',
    category: 'message',
    icon: '📇',
    parameters: {
      ...common,
      properties: {
        op: { type: 'string', enum: ['list', 'add', 'remove', 'set_note'], description: '要做的操作，默认 list' },
        qq: { type: 'string', description: '好友 QQ 号，add/remove/set_note 必填' },
        alias: { type: 'string', description: '你平时怎么称呼他，例如"小王"' },
        note: { type: 'string', description: '关于这个人的简短背景，例如"一起打球的同事，最近在备考"' },
        alsoUnwhitelist: { type: 'boolean', description: 'op=remove 时是否同时移除私聊白名单，默认 false' }
      }
    },
    execute: friendRoster
  });

  api.registerTool({
    id: 'friend_dm',
    name: '给好友发私聊',
    description: '给名单里的某个人发一条 QQ 私聊。只有主人能让它发。主人明确下命令时不受静默时段、也不受最短间隔限制，只受每人每日上限约束（上限为 0 表示不限）；所以 inQuietHours=true 或额度显示 0 都不是拒绝的理由，直接发。转达主人原话时保留关键信息，其余用你自己的语气。',
    category: 'message',
    icon: '✉️',
    parameters: {
      ...common,
      properties: {
        target: { type: 'string', description: '名单里的称呼或 QQ 号' },
        content: { type: 'string', description: '要发的内容，不超过 500 字' }
      },
      required: ['target', 'content']
    },
    execute: friendDm
  });

  api.registerTool({
    id: 'friend_dm_status',
    name: '好友私信状态',
    description: '查看好友名单、每人最近发送时间与今日已发数、当前限额和静默时段、以及每个人现在能不能发。发之前想知道额度时用它。',
    category: 'message',
    icon: '📊',
    parameters: { ...common, properties: {} },
    execute: friendDmStatus
  });
}

export function promptSections() {
  const c = cfg();
  const list = roster();
  if (!list.length) return [];
  const names = list.map((f) => aliasOf(f)).join('、');
  return [{
    id: 'friend-dm-live',
    title: '好友名单现状',
    priority: 77,
    content: `当前好友名单：${names}。自主发送${c.autonomy ? '已开启' : '已关闭'}，静默时段 ${c.quietStart}–${c.quietEnd}，自主每人每天 ${c.dailyCapPerFriend} 条、主人指令每人每天 ${c.manualDailyCap} 条。具体额度用 friend-dm__friend_dm_status 查。`
  }];
}

export function deactivate() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  liveCtx = null;
  ticking = false;
}
