// 固定事实（确定性型 / plugins/，纯 hooks）
//
// 用途：把"长期不变、绝不能被记忆整理改写"的事实单独存一份，每轮注入提示词。
// 数据在 data/pinned-facts.json，代码里不放任何个人信息。
//
// 为什么不用记忆：核心的记忆整理（orchestrator.consolidateMemoryForChat）会用模型
// 重新生成的印象**整条替换**成员文件，手写进去的事实随时可能被改写或丢掉。
// 固定事实走独立文件 + 每轮注入，整理逻辑碰不到它。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';

const DEFAULTS = { enabled: true };
const FACTS_FILE = path.join(DATA_DIR, 'pinned-facts.json');

let api = null;
let promptCorePromise = null;

function settings() {
  let raw = null;
  try { raw = api && typeof api.config === 'function' ? api.config() : null; } catch { raw = null; }
  if (!raw) {
    try { raw = getConfig()?.skills?.['pinned-facts'] || null; } catch { raw = null; }
  }
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw || {})) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function readFacts() {
  try {
    const raw = JSON.parse(fs.readFileSync(FACTS_FILE, 'utf8'));
    const facts = (Array.isArray(raw?.facts) ? raw.facts : [])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean);
    return { ownerQq: String(raw?.ownerQq || '').trim(), facts };
  } catch {
    return { ownerQq: '', facts: [] };
  }
}

/** 只有白名单私聊能拿到真实号码；群聊一律打码。 */
function isTrusted(chatKey) {
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'private') return false;
  let allow = [];
  try { allow = getConfig()?.allow?.private || []; } catch { allow = []; }
  return allow.map(String).includes(String(id));
}

function buildBlock(chatKey) {
  const { ownerQq, facts } = readFacts();
  if (!facts.length) return '';
  const trusted = isTrusted(chatKey);
  const qqText = trusted ? ownerQq : '（号码不公开）';
  const usable = trusted ? facts : facts.filter((f) => !/^转达目标/.test(f));
  const lines = usable.map((f) => `- ${f.split('{{ownerQq}}').join(qqText || '（号码不公开）')}`);
  return [
    '【固定事实 · 长期有效】',
    ...lines,
    '（这些是长期不变的事实，不要被聊天内容推翻；有新对话、记忆整理之后也照这个来。）'
  ].join('\n');
}

async function appendToTail(messages, text) {
  if (!Array.isArray(messages) || !text) return false;
  if (!promptCorePromise) promptCorePromise = import('../../src/prompt.js').catch(() => null);
  const core = await promptCorePromise;
  if (core && typeof core.appendDynamicTail === 'function') {
    try { if (core.appendDynamicTail(messages, text)) return true; } catch { /* 走回退 */ }
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

export function setup(a) {
  api = a;
}

export function available() {
  return settings().enabled !== false;
}

export function activate() {
  const { facts, ownerQq } = readFacts();
  api?.log?.(`固定事实已启用：${facts.length} 条${ownerQq ? '，主人号已配置' : '，未配置主人号'}`);
}

export function deactivate() {
  promptCorePromise = null;
}

export const hooks = {
  async 'before-llm-messages'(ctx = {}) {
    const s = settings();
    if (s.enabled === false) return;
    try {
      const text = buildBlock(String(ctx.chatKey || ''));
      if (!text) return;
      await appendToTail(ctx.messages, text);
    } catch { /* 注入失败不影响对话 */ }
  }
};

export const providers = {
  /** 预览某个会话会看到的固定事实。args: { chatKey } */
  'pinned-facts.preview': (args = {}) => {
    const chatKey = String(args?.chatKey || '');
    const text = buildBlock(chatKey);
    return { ok: true, chatKey, trusted: isTrusted(chatKey), chars: text.length, text };
  }
};
