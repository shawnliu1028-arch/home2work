#!/usr/bin/env node
// skm — 轻量跨 coding agent 技能管理器
// 单文件、零依赖。术语见 CONTEXT.md，决策见 docs/adr/。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

// ---------- paths ----------

const HOME = process.env.SKM_HOME || os.homedir();
const AGENTS_ROOT = path.join(HOME, '.agents');
const CENTRAL = path.join(AGENTS_ROOT, 'skills');
const CONFIG_PATH = path.join(AGENTS_ROOT, 'skm.config.json');
const LOCK_PATH = path.join(AGENTS_ROOT, 'skm.lock.json');
const OLD_LOCK_PATH = path.join(AGENTS_ROOT, '.skill-lock.json');

// 默认注册表只内置 claude；其余 agent 由用户按需 skm agent add 添加。
// 注意：这只影响首次生成的配置，已存在的 skm.config.json 不会被裁剪（其中的注册项归用户所有）。
const DEFAULT_AGENTS = {
  claude: '.claude/skills',
};

// ---------- config & lock ----------

function defaultConfig() {
  return { agents: { ...DEFAULT_AGENTS }, enablement: {} };
}

function loadConfig() {
  fs.mkdirSync(AGENTS_ROOT, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = defaultConfig();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return cfg;
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!cfg.agents) cfg.agents = { ...DEFAULT_AGENTS };
  if (!cfg.enablement) cfg.enablement = {};
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function loadLock() {
  if (!fs.existsSync(LOCK_PATH)) return { version: 1, collections: {} };
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  if (!lock.collections) lock.collections = {};
  return lock;
}

function saveLock(lock) {
  fs.mkdirSync(AGENTS_ROOT, { recursive: true });
  fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2));
}

function agentDir(cfg, agent) {
  const rel = cfg.agents[agent];
  if (!rel) throw new Error(`未知 agent "${agent}"。已注册：${Object.keys(cfg.agents).join(', ')}（可用 skm agent add 添加）`);
  // resolve：相对 HOME 解析；注册项本身是绝对路径（如 Windows 其他盘符）时原样保留
  return path.resolve(HOME, rel);
}

// enablement 条目归一化：字符串 或 { collection, exclude: [] }
function normalizeEntry(e) {
  return typeof e === 'string' ? { collection: e, exclude: [] } : { collection: e.collection, exclude: e.exclude ?? [] };
}

function enabledCollections(cfg, agent) {
  return (cfg.enablement[agent] ?? []).map(normalizeEntry);
}

// ---------- fs utils ----------

function lstatSafe(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function hashDir(dir) {
  const h = crypto.createHash('sha1');
  const walk = (d, rel) => {
    const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else {
        h.update(r);
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

// 递归发现技能：含 SKILL.md 的文件夹为技能，不再深入
function discoverSkills(root, rootSkillName) {
  if (fs.existsSync(path.join(root, 'SKILL.md'))) {
    return [{ name: rootSkillName, path: root }];
  }
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (fs.existsSync(path.join(p, 'SKILL.md'))) found.push({ name: e.name, path: p });
      else walk(p);
    }
  };
  walk(root);
  return found;
}

function centralCollectionDir(collection) {
  return path.join(CENTRAL, collection);
}

function collectionSkillNames(collection) {
  const dir = centralCollectionDir(collection);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

// 合集名同时是中心存储下的一级目录名，必须能安全地当单个路径段用。
// 采用「拒绝非法」而非白名单：合集名可以是任意语言，不该被字符集限死。
function validateCollectionName(name, label = '合集名') {
  const s = String(name ?? '');
  if (!s) throw new Error(`${label}不能为空`);
  if (s !== s.trim()) throw new Error(`${label}首尾不能有空白："${s}"`);
  if (s === '.' || s === '..') throw new Error(`${label}不能是 "." 或 ".."`);
  if (/[\\/:*?"<>|\x00-\x1f]/.test(s)) {
    throw new Error(`${label}含非法字符（不得含 \\ / : * ? " < > | 或控制字符）："${s}"`);
  }
  return s;
}

// 目录移动：同盘 rename 原子完成；跨盘或目标被占用时降级为拷贝 + 删源
function moveDir(from, to) {
  try {
    fs.renameSync(from, to);
  } catch {
    copyDir(from, to);
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// enablement 条目序列化：无排除项时回到字符串写法，配置文件保持简洁
function serializeEntry(e) {
  return e.exclude.length ? { collection: e.collection, exclude: e.exclude } : e.collection;
}

// ---------- links ----------

function pathKey(p) {
  return path.resolve(String(p)).toLowerCase();
}

function pointsIntoCentral(targetStr) {
  const abs = pathKey(targetStr);
  const c = pathKey(CENTRAL);
  return abs === c || abs.startsWith(c + path.sep);
}

function readLinkTarget(p) {
  const st = lstatSafe(p);
  if (!st || !st.isSymbolicLink()) return null;
  return fs.readlinkSync(p);
}

function createLink(target, linkPath) {
  // junction：Windows 上无需特权、支持目录，优先使用；其余平台回退符号链接
  if (process.platform === 'win32') {
    fs.symlinkSync(target, linkPath, 'junction');
  } else {
    try {
      fs.symlinkSync(target, linkPath, 'dir');
    } catch {
      fs.symlinkSync(target, linkPath, 'junction');
    }
  }
}

// 列出目录中所有指向中心存储的链接
function centralLinksIn(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const target = readLinkTarget(p);
    if (target !== null && pointsIntoCentral(target)) out.push({ name: e.name, path: p, target });
  }
  return out;
}

// 计算某 agent 期望的链接映射：{ name -> centralPath }；跨合集同名冲突则抛错
function desiredLinksFor(cfg, agent, lock) {
  const desired = new Map();
  for (const entry of enabledCollections(cfg, agent)) {
    const coll = entry.collection;
    if (!lock.collections[coll]) continue; // 启用了但未安装（如配置先于安装）
    for (const name of collectionSkillNames(coll)) {
      if (entry.exclude.includes(name)) continue;
      if (desired.has(name)) {
        throw new Error(`同名冲突：技能 "${name}" 同时来自已启用合集 "${desired.get(name).collection}" 和 "${coll}"，请只启用其一`);
      }
      desired.set(name, { collection: coll, centralPath: path.join(centralCollectionDir(coll), name) });
    }
  }
  return desired;
}

// 同步单个 agent 的链接（幂等）。返回统计。
function syncAgentLinks(cfg, agent, lock) {
  const dir = agentDir(cfg, agent);
  fs.mkdirSync(dir, { recursive: true });
  const desired = desiredLinksFor(cfg, agent, lock);
  const stats = { created: 0, removed: 0, skippedNative: 0 };
  // 清理指向中心存储但不在期望内的陈旧链接
  for (const link of centralLinksIn(dir)) {
    if (!desired.has(link.name)) {
      fs.rmSync(link.path);
      stats.removed++;
    }
  }
  for (const [name, info] of desired) {
    const p = path.join(dir, name);
    const st = lstatSafe(p);
    if (st && !st.isSymbolicLink()) {
      console.log(`  [跳过] ${agent}/${name}：同名原生技能已存在，不覆盖`);
      stats.skippedNative++;
      continue;
    }
    const cur = st ? readLinkTarget(p) : null;
    if (cur === null || pathKey(cur) !== pathKey(info.centralPath)) {
      if (st) fs.rmSync(p);
      createLink(info.centralPath, p);
      stats.created++;
    }
  }
  return stats;
}

function syncAllLinks(cfg, lock) {
  let failed = false;
  for (const agent of Object.keys(cfg.agents)) {
    try {
      const s = syncAgentLinks(cfg, agent, lock);
      console.log(`${agent}: 新建 ${s.created}，移除 ${s.removed}，跳过原生 ${s.skippedNative}`);
    } catch (e) {
      console.error(`  [错误] ${agent}: ${e.message}`);
      failed = true;
    }
  }
  return !failed;
}

// ---------- git ----------

function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

async function fetchGit(url) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-clone-'));
  try {
    await execFileP('git', ['-c', 'core.autocrlf=false', 'clone', '--depth', '1', '--quiet', url, tmp]);
    return tmp;
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`git clone 失败（${url}）：${(e.stderr || e.message || '').trim()}`);
  }
}

// ---------- migration ----------

function maybeMigrate(cfg, lock) {
  if (!fs.existsSync(OLD_LOCK_PATH) || fs.existsSync(LOCK_PATH)) return false;
  const old = JSON.parse(fs.readFileSync(OLD_LOCK_PATH, 'utf8'));
  const bak = OLD_LOCK_PATH + '.bak-' + Date.now();
  fs.copyFileSync(OLD_LOCK_PATH, bak);

  // 按来源分组：pluginName → 合集名
  const groups = new Map();
  for (const [name, meta] of Object.entries(old.skills ?? {})) {
    const coll = meta.pluginName || 'default';
    if (!groups.has(coll)) groups.set(coll, { source: meta.source ?? coll, sourceUrl: meta.sourceUrl ?? '', skills: [] });
    groups.get(coll).skills.push({ name, skillPath: (meta.skillPath ?? '').replace(/\/SKILL\.md$/, '') });
  }

  // 移动技能文件夹进合集目录
  for (const [coll, g] of groups) {
    const cdir = centralCollectionDir(coll);
    fs.mkdirSync(cdir, { recursive: true });
    for (const s of g.skills) {
      const from = path.join(CENTRAL, s.name);
      const to = path.join(cdir, s.name);
      if (fs.existsSync(from)) {
        try {
          fs.renameSync(from, to);
        } catch {
          copyDir(from, to);
          fs.rmSync(from, { recursive: true, force: true });
        }
      }
    }
  }

  // 写新锁文件（hash 用当前文件夹实际内容重算）
  const collections = {};
  for (const [coll, g] of groups) {
    const skills = {};
    for (const s of g.skills) {
      const dir = path.join(centralCollectionDir(coll), s.name);
      if (fs.existsSync(dir)) skills[s.name] = { skillPath: s.skillPath, hash: hashDir(dir) };
    }
    collections[coll] = { source: g.source, sourceType: 'github', sourceUrl: g.sourceUrl, skills };
  }
  lock.collections = collections;
  saveLock(lock);

  // 从现存链接重建启用清单
  for (const agent of Object.keys(cfg.agents)) {
    for (const link of centralLinksIn(agentDir(cfg, agent))) {
      const name = path.basename(pathKey(link.target));
      for (const [coll, c] of Object.entries(collections)) {
        if (c.skills[name] && !enabledCollections(cfg, agent).some((x) => x.collection === coll)) {
          (cfg.enablement[agent] ??= []).push(coll);
        }
      }
    }
  }
  saveConfig(cfg);
  syncAllLinks(cfg, lock); // 修复链接目标
  console.log(`已迁移 ${Object.values(collections).reduce((n, c) => n + Object.keys(c.skills).length, 0)} 个技能为 ${groups.size} 个合集（旧锁文件备份于 ${bak}）`);
  return true;
}

// ---------- interactive selection ----------
// 交互式多选 agent（add / enable / disable 共用）。
// prompt 一律走 stderr，stdout 保持干净可管道；机制为 readline 数字清单（零依赖，与 remove 确认同套路）。

// 解析多选输入：'1,3 4' → [0, 2, 3]；'a'/'all' → 全部索引；空 → []（空确认）；非法 → null
function parseSelection(input, count) {
  const t = String(input ?? '').trim().toLowerCase();
  if (!t) return [];
  if (t === 'a' || t === 'all') return Array.from({ length: count }, (_, i) => i);
  const out = new Set();
  for (const p of t.split(/[\s,]+/).filter(Boolean)) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 1 || n > count) return null;
    out.add(n - 1);
  }
  return [...out].sort((a, b) => a - b);
}

// 列出候选供多选并等待输入。candidates: [{ label, note? }]。
// 返回选中的 label 数组（可能为空 = 空确认）；null 表示中止（Ctrl+C）。非法输入会就地重问。
async function promptAgents(title, candidates, emptyHint) {
  const err = process.stderr;
  err.write(`${title}\n`);
  candidates.forEach((c, i) => err.write(`  ${i + 1}) ${c.label}${c.note ? `  （${c.note}）` : ''}\n`));
  err.write(`输入编号（逗号/空格分隔），a=全部，直接回车=${emptyHint}\n`);
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    while (true) {
      const raw = await new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
        rl.once('SIGINT', () => { rl.close(); finish(null); });
        rl.once('close', () => finish(null));
        rl.question('选择: ').then(finish, () => finish(null));
      });
      if (raw === null) return null;
      const picked = parseSelection(raw, candidates.length);
      if (picked === null) {
        err.write('输入无效，请重新输入\n');
        continue;
      }
      return picked.map((i) => candidates[i].label);
    }
  } finally {
    rl.close();
  }
}

// 对若干 agent 启用合集并同步链接（add --enable 与 enable 命令共用）。
// 先在副本上验证（未知 agent、跨合集同名冲突），全部通过才落盘（原子性）。
function applyEnablement(cfg, lock, coll, agents, exclude) {
  const draft = JSON.parse(JSON.stringify(cfg));
  for (const agent of agents) {
    agentDir(draft, agent);
    const entries = (draft.enablement[agent] ??= []).map(normalizeEntry);
    const existing = entries.find((e) => e.collection === coll);
    if (existing) existing.exclude = [...new Set([...existing.exclude, ...exclude])];
    else entries.push(exclude.length ? { collection: coll, exclude } : coll);
    draft.enablement[agent] = entries;
    desiredLinksFor(draft, agent, lock);
  }
  cfg.enablement = draft.enablement;
  saveConfig(cfg);
  for (const agent of agents) {
    const s = syncAgentLinks(cfg, agent, lock);
    console.log(`${agent}: 新建 ${s.created}，跳过原生 ${s.skippedNative}`);
  }
}

// ---------- commands ----------

// 解析来源：本地路径（含 .git → git 类型）或 GitHub 仓库
function resolveSource(src) {
  if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
    const abs = path.resolve(src);
    return isGitRepo(abs)
      ? { type: 'git', url: abs, name: path.basename(abs) }
      : { type: 'local', url: abs, name: path.basename(abs) };
  }
  const m = src.match(/^(?:https?:\/\/github\.com\/|gh:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (m) {
    // 合集名默认取 owner-repo（ADR-0005）：只取仓库名时，mattpocock/skills、vercel-labs/skills、
    // humanlayer/skills 这类同名仓库会互相撞名，第二个起就装不进来。
    return { type: 'git', url: `https://github.com/${m[1]}/${m[2]}.git`, name: `${m[1]}-${m[2]}` };
  }
  throw new Error(`无法识别的来源 "${src}"：请提供本地路径或 GitHub 仓库（owner/repo 或完整 URL）`);
}

async function cmdAdd(cfg, lock, positional, flags) {
  const src = positional[0];
  if (!src) throw new Error('用法: skm add <本地路径|github仓库> [--skill 名称] [--enable agents] [--dry-run]');
  const resolved = resolveSource(src);
  if (lock.collections[resolved.name]) {
    throw new Error(`合集 "${resolved.name}" 已存在，如需刷新请用 update`);
  }

  // 启用决策：--enable 显式指定；--no-enable 只装不启用；--dry-run 不涉及；
  // 两者都不传时：TTY 交互询问（安装完成后），非交互模式报错（快速失败，不产生半成品）
  const interactiveEnable = !flags.enable && !flags['no-enable'] && !flags['dry-run'];
  if (interactiveEnable && !process.stdin.isTTY) {
    throw new Error('非交互模式下 skm add 需要 --enable <agent[,agent...]> 或 --no-enable（只装不启用）');
  }

  let workRoot = resolved.url;
  let tmp = null;
  if (resolved.type === 'git') {
    tmp = await fetchGit(resolved.url);
    workRoot = tmp;
  }

  try {
    const discovered = discoverSkills(workRoot, resolved.name);
    if (discovered.length === 0) throw new Error('来源中未发现任何技能（需要包含 SKILL.md 的文件夹）');

    // 同合集内同名冲突
    const seen = new Map();
    for (const s of discovered) {
      if (seen.has(s.name)) throw new Error(`合集内同名冲突：${path.relative(workRoot, seen.get(s.name))} 与 ${path.relative(workRoot, s.path)} 都叫 "${s.name}"`);
      seen.set(s.name, s.path);
    }

    let selected = discovered;
    if (flags.skill) {
      const wanted = String(flags.skill).split(',').map((s) => s.trim()).filter(Boolean);
      const missing = wanted.filter((w) => !seen.has(w));
      if (missing.length) throw new Error(`来源中未找到技能: ${missing.join(', ')}`);
      selected = discovered.filter((s) => wanted.includes(s.name));
    }

    if (flags['dry-run']) {
      console.log(`[dry-run] 将安装合集 ${resolved.name} (${resolved.type}: ${resolved.url}):`);
      for (const s of selected) console.log(`  - ${s.name}`);
      return;
    }

    // 安装
    const cdir = centralCollectionDir(resolved.name);
    fs.mkdirSync(cdir, { recursive: true });
    const skills = {};
    for (const s of selected) {
      copyDir(s.path, path.join(cdir, s.name));
      skills[s.name] = {
        // skillPath 记录技能在上游仓库内的原始路径（追溯用）
        skillPath: path.relative(workRoot, s.path).split(path.sep).join('/'),
        hash: hashDir(path.join(cdir, s.name)),
      };
    }
    lock.collections[resolved.name] = {
      source: resolved.url,
      sourceType: resolved.type,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      skills,
    };
    saveLock(lock);
    console.log(`合集 ${resolved.name} 已安装: ${Object.keys(skills).join(', ')}`);

    if (flags.enable) {
      applyEnablement(cfg, lock, resolved.name, splitList(flags.enable), []);
    } else if (interactiveEnable) {
      // 安装完成后交互询问启用给哪些 agent；空选择 / Ctrl+C 都等价于"装了但不启用"
      const candidates = Object.keys(cfg.agents).map((a) => ({ label: a }));
      const picked = await promptAgents(`启用合集 "${resolved.name}" 给哪些 agent？`, candidates, '不启用');
      if (picked === null) {
        console.error('已取消：合集保持未启用（之后可 skm enable）');
      } else if (picked.length === 0) {
        console.log('未选择任何 agent，合集保持未启用（之后可 skm enable）');
      } else {
        applyEnablement(cfg, lock, resolved.name, picked, []);
        console.log(`已启用给: ${picked.join(', ')}`);
      }
    }
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function cmdUpdate(cfg, lock, positional, flags) {
  const force = Boolean(flags.force);
  const names = positional.length ? positional : Object.keys(lock.collections);
  for (const coll of names) {
    const c = lock.collections[coll];
    if (!c) throw new Error(`合集 "${coll}" 未安装`);
    let workRoot;
    let tmp = null;
    if (c.sourceType === 'git') {
      tmp = await fetchGit(c.source);
      workRoot = tmp;
    } else if (c.sourceType === 'local' && fs.existsSync(c.source)) {
      workRoot = c.source;
    } else {
      console.error(`  [错误] ${coll}: 本地来源不存在（${c.source}）`);
      continue;
    }
    try {
      const discovered = new Map(discoverSkills(workRoot, coll).map((s) => [s.name, s.path]));
      let updated = 0;
      let added = 0;
      let skipped = 0;
      const cdir = centralCollectionDir(coll);
      for (const [name, meta] of Object.entries(c.skills)) {
        const localDir = path.join(cdir, name);
        if (!fs.existsSync(localDir)) continue;
        const modified = hashDir(localDir) !== meta.hash;
        if (modified && !force) {
          console.log(`  [警告] ${coll}/${name} 在本地被修改过，已跳过（--force 覆盖）`);
          skipped++;
          continue;
        }
        const incoming = discovered.get(name);
        // 上游有新版本，或（--force 下）本地已改动需恢复上游 → 重拷
        if (incoming && (hashDir(incoming) !== meta.hash || modified)) {
          fs.rmSync(localDir, { recursive: true, force: true });
          copyDir(incoming, localDir);
          meta.hash = hashDir(localDir);
          updated++;
        }
      }
      // 上游新增技能：装入并跟随合集的启用清单
      let addedAny = false;
      for (const [name, incoming] of discovered) {
        if (c.skills[name]) continue;
        copyDir(incoming, path.join(cdir, name));
        // skillPath 记录技能在上游仓库内的原始路径（追溯用）
        c.skills[name] = { skillPath: path.relative(workRoot, incoming).split(path.sep).join('/'), hash: hashDir(path.join(cdir, name)) };
        added++;
        addedAny = true;
      }
      if (addedAny) {
        for (const agent of Object.keys(cfg.agents)) {
          if (enabledCollections(cfg, agent).some((e) => e.collection === coll)) {
            try {
              syncAgentLinks(cfg, agent, lock);
            } catch (e) {
              console.error(`  [错误] ${agent}: ${e.message}`);
            }
          }
        }
      }
      c.updatedAt = new Date().toISOString();
      console.log(`${coll}: 更新 ${updated}，新增 ${added}，跳过本地修改 ${skipped}`);
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  saveLock(lock);
}

async function cmdRemove(cfg, lock, positional, flags) {
  const [coll] = positional;
  if (!coll) throw new Error('用法: skm remove <合集> [--force]');
  if (!lock.collections[coll]) throw new Error(`合集 "${coll}" 未安装`);
  if (!flags.force) {
    if (process.stdin.isTTY) {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`确认删除合集 "${coll}"（含全部链接与数据）? [y/N] `);
      rl.close();
      if (!/^(y|yes)$/i.test(answer.trim())) {
        console.log('已取消');
        return;
      }
    } else {
      throw new Error('删除不可逆，非交互模式下请用 --force 确认');
    }
  }
  const cdir = centralCollectionDir(coll);
  const skillNames = new Set(collectionSkillNames(coll));
  // 删除所有 agent 中的对应链接
  for (const agent of Object.keys(cfg.agents)) {
    for (const link of centralLinksIn(agentDir(cfg, agent))) {
      if (!skillNames.has(link.name)) continue;
      if (pathKey(link.target).startsWith(pathKey(path.join(CENTRAL, coll)) + path.sep)) {
        fs.rmSync(link.path);
        console.log(`  已移除链接 ${agent}/${link.name}`);
      }
    }
  }
  fs.rmSync(cdir, { recursive: true, force: true });
  delete lock.collections[coll];
  saveLock(lock);
  for (const agent of Object.keys(cfg.agents)) {
    cfg.enablement[agent] = (cfg.enablement[agent] ?? []).map(normalizeEntry).filter((e) => e.collection !== coll);
  }
  saveConfig(cfg);
  console.log(`合集 ${coll} 已删除`);
}

// 重命名合集：合集身份在锁文件的键上，目录名只是它的派生——改名必须四处同步，
// 否则锁与磁盘错位（正是「手工改目录名后 list 仍显示旧名」的成因）。
function cmdRename(cfg, lock, positional, flags) {
  const [oldName, newNameRaw] = positional;
  if (!oldName || !newNameRaw) throw new Error('用法: skm rename <旧合集名> <新合集名> [--dry-run]');
  if (!lock.collections[oldName]) throw new Error(`合集 "${oldName}" 未安装`);
  const newName = validateCollectionName(newNameRaw, '新合集名');
  if (newName === oldName) throw new Error(`新旧名字相同（${oldName}），无需重命名`);
  if (lock.collections[newName]) throw new Error(`合集 "${newName}" 已存在，请换一个名字`);

  const from = centralCollectionDir(oldName);
  const to = centralCollectionDir(newName);
  const fromExists = fs.existsSync(from);
  const toExists = fs.existsSync(to);
  if (!fromExists && !toExists) {
    throw new Error(`合集 "${oldName}" 的中心目录不存在（${from}）。状态已损坏，请用 skm remove ${oldName} --force 清理后重装`);
  }
  if (toExists && fromExists) throw new Error(`目标目录已存在（${to}），请先处理它或换一个名字`);

  // 目录已被手工改名到目标位置（锁键没跟着改）→ 采纳它，只迁移元数据；这是修复状态的正路
  const adopted = !fromExists;
  if (flags['dry-run']) {
    console.log(`[dry-run] 将合集 ${oldName} 重命名为 ${newName}${adopted ? '（目标目录已存在，仅迁移元数据）' : `（移动目录 ${from} → ${to}）`}`);
    return;
  }

  if (!adopted) moveDir(from, to);

  lock.collections[newName] = lock.collections[oldName];
  delete lock.collections[oldName];
  saveLock(lock);

  // 启用清单改指新名；受影响 agent 的链接目标随中心路径变化，需重建
  const affected = [];
  for (const agent of Object.keys(cfg.agents)) {
    const entries = enabledCollections(cfg, agent);
    if (!entries.some((e) => e.collection === oldName)) continue;
    cfg.enablement[agent] = entries
      .map((e) => (e.collection === oldName ? { collection: newName, exclude: e.exclude } : e))
      .map(serializeEntry);
    affected.push(agent);
  }
  saveConfig(cfg);

  for (const agent of affected) {
    const s = syncAgentLinks(cfg, agent, lock);
    console.log(`${agent}: 重建 ${s.created}，移除 ${s.removed}`);
  }

  const count = Object.keys(lock.collections[newName].skills).length;
  console.log(
    `合集 ${oldName} → ${newName}${adopted ? '（已采纳手工改名的目录）' : ''}，技能 ${count} 个` +
      (affected.length ? `，链接已重同步: ${affected.join(', ')}` : '，无 agent 启用，未建链接')
  );
}

async function cmdEnable(cfg, lock, positional, flags) {
  const [coll, agentsStr] = positional;
  if (!coll) throw new Error('用法: skm enable <合集> [agent[,agent...]] [--exclude 技能名]');
  if (!lock.collections[coll]) throw new Error(`合集 "${coll}" 未安装`);
  const exclude = flags.exclude ? splitList(flags.exclude) : [];
  let agents;
  let interactive = false;
  if (agentsStr) {
    agents = splitList(agentsStr);
  } else if (process.stdin.isTTY) {
    // 交互：列出全部 agent，已启用该合集的标注出来（重复选 = 幂等合并 exclude）
    interactive = true;
    const candidates = Object.keys(cfg.agents).map((a) => ({
      label: a,
      note: enabledCollections(cfg, a).some((e) => e.collection === coll) ? '已启用' : null,
    }));
    const picked = await promptAgents(`启用合集 "${coll}" 给哪些 agent？`, candidates, '不启用');
    if (picked === null) {
      console.log('已取消');
      return;
    }
    agents = picked;
  } else {
    throw new Error('非交互模式下必须指定 agent：skm enable <合集> <agent[,agent...]>');
  }
  if (agents.length === 0) {
    console.log('未选择任何 agent，无事可做');
    return;
  }
  applyEnablement(cfg, lock, coll, agents, exclude);
  if (interactive) console.log(`已启用给: ${agents.join(', ')}`);
}

async function cmdDisable(cfg, lock, positional) {
  const [coll, agentsStr] = positional;
  if (!coll) throw new Error('用法: skm disable <合集> [agent[,agent...]]');
  let agents;
  let interactive = false;
  if (agentsStr) {
    agents = splitList(agentsStr);
    for (const agent of agents) agentDir(cfg, agent);
  } else if (process.stdin.isTTY) {
    // 交互：只列出当前已启用该合集的 agent（停用未启用的 agent 是空操作）
    interactive = true;
    const enabledOnes = Object.keys(cfg.agents).filter((a) =>
      enabledCollections(cfg, a).some((e) => e.collection === coll)
    );
    if (enabledOnes.length === 0) {
      console.log(`没有 agent 启用了合集 "${coll}"，无事可做`);
      return;
    }
    const picked = await promptAgents(`对哪些 agent 停用合集 "${coll}"？`, enabledOnes.map((a) => ({ label: a })), '不停用');
    if (picked === null) {
      console.log('已取消');
      return;
    }
    agents = picked;
  } else {
    throw new Error('非交互模式下必须指定 agent：skm disable <合集> <agent[,agent...]>');
  }
  if (agents.length === 0) {
    console.log('未选择任何 agent，无事可做');
    return;
  }
  for (const agent of agents) {
    cfg.enablement[agent] = (cfg.enablement[agent] ?? []).map(normalizeEntry).filter((e) => e.collection !== coll);
    saveConfig(cfg);
    const s = syncAgentLinks(cfg, agent, lock);
    console.log(`${agent}: 移除 ${s.removed}`);
  }
  if (interactive) console.log(`已停用: ${agents.join(', ')}`);
}

// ---------- agent registry ----------
// agent 注册表此前只能手改配置文件；skm agent 让它可命令行维护，
// 并在注销时顺带清掉该 agent 目录下指向中心存储的链接（否则会留下孤儿链接）。

// agent 名称：仅字母数字与 . _ -（配置里的 key，保持可手改可读）
const AGENT_NAME_RE = /^[A-Za-z0-9._-]+$/;

// 路径归一化：~ 展开；能表示为相对 HOME 的相对路径就存相对（便于换机器/换用户名），
// 否则（如 Windows 其他盘符）存绝对路径。统一正斜杠，跨平台可读。
function normalizeAgentPath(input) {
  let raw = String(input ?? '').trim();
  if (!raw) throw new Error('缺少路径参数');
  if (raw === '~') raw = HOME;
  else if (raw.startsWith('~/') || raw.startsWith('~\\')) raw = path.join(HOME, raw.slice(2));
  const abs = path.resolve(HOME, raw);
  const rel = path.relative(HOME, abs);
  const outside = !rel || rel.startsWith('..') || path.isAbsolute(rel);
  const stored = (outside ? abs : rel).split(path.sep).join('/');
  return { abs, stored };
}

// 目录安全性：这些位置会让 skm link 的清理逻辑波及中心存储或整个 HOME
function validateAgentDir(abs) {
  const k = pathKey(abs);
  if (k === pathKey(HOME)) throw new Error(`路径不能是 HOME 本身（${abs}）`);
  if (pointsIntoCentral(abs)) throw new Error(`路径不能位于中心存储内（${abs}）：skm link 会清理其中的链接`);
  if (pathKey(CENTRAL).startsWith(k + path.sep)) throw new Error(`路径不能是中心存储的父目录（${abs}）`);
}

function cmdAgentAdd(cfg, positional) {
  const [name, rawPath] = positional;
  if (!name || !rawPath) throw new Error('用法: skm agent add <名字> <路径>，例如 skm agent add cursor .cursor/skills');
  if (!AGENT_NAME_RE.test(name)) throw new Error(`agent 名称 "${name}" 不合法：仅允许字母、数字、. _ -`);
  if (cfg.agents[name]) throw new Error(`agent "${name}" 已注册（${cfg.agents[name]}）；如需更改路径请先 skm agent remove ${name}`);
  const { abs, stored } = normalizeAgentPath(rawPath);
  validateAgentDir(abs);
  for (const [other, rel] of Object.entries(cfg.agents)) {
    if (pathKey(path.resolve(HOME, rel)) === pathKey(abs)) {
      throw new Error(`路径 ${stored} 已被 agent "${other}" 使用；两个 agent 共用同一目录会导致链接互相覆盖`);
    }
  }
  cfg.agents[name] = stored;
  saveConfig(cfg);
  fs.mkdirSync(abs, { recursive: true });
  console.log(`已注册 agent "${name}" → ${stored}`);
  console.log(`  启用合集: skm enable <合集> ${name}`);
}

async function cmdAgentRemove(cfg, positional, flags) {
  const [name] = positional;
  if (!name) throw new Error('用法: skm agent remove <名字> [--force]');
  const dir = agentDir(cfg, name); // 未知 agent 在此报错
  if (!flags.force) {
    if (process.stdin.isTTY) {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`确认注销 agent "${name}"？将移除 ${dir} 中指向中心存储的链接与该 agent 的启用记录 [y/N] `);
      rl.close();
      if (!/^(y|yes)$/i.test(answer.trim())) {
        console.log('已取消');
        return;
      }
    } else {
      throw new Error('注销会移除链接与启用记录，非交互模式下请用 --force 确认');
    }
  }
  // 只删指向中心存储的链接；agent 自己的原生技能目录一律不动
  let removed = 0;
  for (const link of centralLinksIn(dir)) {
    fs.rmSync(link.path);
    removed++;
  }
  delete cfg.agents[name];
  delete cfg.enablement[name];
  saveConfig(cfg);
  console.log(`已注销 agent "${name}"（移除链接 ${removed}，原生技能保留）`);
}

function agentRowsOf(cfg) {
  return Object.entries(cfg.agents).map(([agent, rel]) => ({
    agent,
    rel,
    en: enabledCollections(cfg, agent)
      .map((e) => (e.exclude.length ? `${e.collection}（排除: ${e.exclude.join(', ')}）` : e.collection))
      .join(', '),
  }));
}

function cmdAgentList(cfg) {
  const rows = agentRowsOf(cfg);
  const wAgent = Math.max(0, ...rows.map((r) => displayWidth(r.agent)));
  const wRel = Math.max(0, ...rows.map((r) => displayWidth(r.rel)));
  console.log(`已注册 ${rows.length} 个 agent：`);
  for (const r of rows) {
    console.log(`  ${padWidth(r.agent, wAgent)}  ${padWidth(r.rel, wRel)}  启用: ${r.en || '（无）'}`);
  }
  console.log('新增: skm agent add <名字> <路径>    注销: skm agent remove <名字>');
}

async function cmdAgent(cfg, positional, flags) {
  const [sub, ...rest] = positional;
  if (!sub || sub === 'list') return cmdAgentList(cfg);
  if (sub === 'add') return cmdAgentAdd(cfg, rest);
  if (sub === 'remove') return cmdAgentRemove(cfg, rest, flags);
  throw new Error(`未知子命令 "${sub}"。可用: add, remove, list`);
}

// ---------- list rendering ----------

// 终端显示宽度：CJK 与全角字符记 2（padEnd 按码元计数会算错宽度）
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

function padWidth(s, width) {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

// list 行的构建模型：每行是一组 { text, style } 片段；
// 纯文本直接拼接，TTY 渲染时再按 style 上色/加框（内容层与渲染层分离）
const seg = (text, style = null) => ({ text, style });

const STYLE_CODES = {
  title: '1;36', // 节标题/合集名：粗体青色
  agent: '94', // agent 名：亮蓝色（普通蓝在深色终端背景上对比度不足）
  warn: '33', // 空状态（（无）/（空））：黄色
  dim: '2', // 来源地址、提示：暗灰
};

function cmdList(cfg, lock) {
  const lines = [];

  // --- Agent 目标 ---
  const agentRows = agentRowsOf(cfg);
  const wAgent = Math.max(0, ...agentRows.map((r) => displayWidth(r.agent)));
  const wRel = Math.max(0, ...agentRows.map((r) => displayWidth(r.rel)));
  lines.push([seg('Agent 目标', 'title')]);
  for (const r of agentRows) {
    lines.push([
      seg('  '),
      seg(padWidth(r.agent, wAgent), 'agent'),
      seg('  '),
      seg(padWidth(r.rel, wRel)),
      seg('  启用: '),
      seg(r.en || '（无）', r.en ? null : 'warn'),
    ]);
  }

  // --- 合集 ---
  lines.push([]);
  lines.push([seg('合集', 'title')]);
  const colls = Object.keys(lock.collections).sort();
  if (colls.length === 0) {
    lines.push([seg('  （空）', 'warn')]);
    lines.push([seg('  运行 skm add <来源> 安装第一个合集', 'dim')]);
  }
  const wSkill = Math.max(0, ...colls.flatMap((coll) => Object.keys(lock.collections[coll].skills).map((n) => displayWidth(n))));
  for (const coll of colls) {
    const c = lock.collections[coll];
    const count = Object.keys(c.skills).length;
    lines.push([
      seg('  '),
      seg(coll, 'title'),
      seg('  '),
      seg(`(${c.sourceType}: ${c.source})`, 'dim'),
      seg(`  [${count}]`),
    ]);
    const enabledBy = Object.keys(cfg.agents).filter((a) => enabledCollections(cfg, a).some((e) => e.collection === coll));
    for (const name of Object.keys(c.skills).sort()) {
      lines.push([
        seg('    '),
        seg(padWidth(name, wSkill)),
        seg('  '),
        seg(enabledBy.length ? `[${enabledBy.join(', ')}]` : ''),
      ]);
    }
  }

  // --- 渲染：非 TTY（管道/agent 调用）输出无边框纯文本；TTY 加边框 ---
  const useColor = process.env.FORCE_COLOR
    ? process.env.FORCE_COLOR !== '0'
    : Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const paint = (s) => (useColor && s.style && STYLE_CODES[s.style] ? `\x1b[${STYLE_CODES[s.style]}m${s.text}\x1b[0m` : s.text);
  const plainOf = (line) => line.map((s) => s.text).join('');

  if (!process.stdout.isTTY) {
    console.log(lines.map((l) => l.map(paint).join('')).join('\n'));
    return;
  }
  const inner = Math.max(0, ...lines.map((l) => displayWidth(plainOf(l))));
  const edge = '─'.repeat(inner + 2);
  const body = lines.map((l) => '│ ' + l.map(paint).join('') + ' '.repeat(inner - displayWidth(plainOf(l))) + ' │');
  console.log([`┌${edge}┐`, ...body, `└${edge}┘`].join('\n'));
}

// ---------- help ----------

// 帮助文档单一来源：新增命令时同步在此登记
const COMMANDS = {
  add: {
    usage: 'skm add <本地路径|owner/repo|github-url>',
    summary: '安装一个技能合集到中心存储 ~/.agents/skills/，并登记到锁文件',
    details: [
      '来源可以是本地目录（含 .git 则记录为 git 类型）或 GitHub 仓库。',
      '自动发现来源中所有含 SKILL.md 的文件夹作为技能。',
      '不传 --enable/--no-enable 时：交互终端会列出全部 agent 供多选启用；非交互模式（脚本/管道）报错，必须显式传其中之一。',
      '参数:',
      '  --skill <名称[,名称...]>  只安装指定技能（其余跳过）',
      '  --enable <agent[,agent...]>  安装后立即对指定 agent 启用并建立链接',
      '  --no-enable  只安装不启用，跳过交互询问（适合脚本）',
      '  --dry-run  预览将安装的合集与技能，不做任何改动',
    ],
    examples: ['skm add ~/repos/my-skills', 'skm add anthropics/skills --enable claude', 'skm add gh:user/repo --skill foo,bar --dry-run', 'skm add D:\\my-skills --no-enable'],
  },
  update: {
    usage: 'skm update [合集...]',
    summary: '从上游重新拉取并刷新已安装的合集（缺省刷新全部）',
    details: [
      '对比上游与本地技能内容哈希，上游有变化时重新拷贝。',
      '上游新增的技能也会装入，并自动同步到已启用该合集的 agent。',
      '参数:',
      '  --force  本地被修改过的技能也强制恢复为上游版本',
    ],
    examples: ['skm update', 'skm update my-skills --force'],
  },
  enable: {
    usage: 'skm enable <合集> [agent[,agent...]]',
    summary: '对指定 agent 启用某个合集，为其建立技能链接',
    details: [
      '省略 agent 时（交互终端）列出全部 agent 供多选，已启用该合集的会标注；非交互模式必须显式指定 agent。',
      '链接建立到该 agent 的技能目录（见 list 中的 Agent 目标）。',
      '跨合集同名技能冲突时会直接报错，不会产生半成品配置。',
      '参数:',
      '  --exclude <技能名[,技能名...]>  启用合集但排除其中部分技能',
    ],
    examples: ['skm enable my-skills', 'skm enable my-skills claude,cursor', 'skm enable my-skills claude --exclude experimental'],
  },
  disable: {
    usage: 'skm disable <合集> [agent[,agent...]]',
    summary: '对指定 agent 停用某个合集，移除其技能链接',
    details: [
      '省略 agent 时（交互终端）只列出当前已启用该合集的 agent 供多选；非交互模式必须显式指定 agent。',
      '仅移除链接与启用记录，合集本身仍保留在中心存储中。',
    ],
    examples: ['skm disable my-skills', 'skm disable my-skills claude'],
  },
  list: {
    usage: 'skm list',
    summary: '查看已注册的 agent 目标、启用情况与已安装的合集',
    details: [
      '每个技能后会标注启用了它的 agent；合集标注来源、地址与技能数量。',
      '终端（TTY）下以边框与颜色渲染；管道或被程序调用时自动输出无边框纯文本。',
      '颜色：NO_COLOR=1 关闭，FORCE_COLOR=1 强制开启。',
    ],
    examples: ['skm list'],
  },
  link: {
    usage: 'skm link',
    summary: '按当前配置重新同步所有 agent 的技能链接（幂等）',
    details: [
      '清理指向中心存储但已不在期望内的陈旧链接，补建缺失的链接。',
      'agent 目录下的同名原生技能不会被覆盖。',
    ],
    examples: ['skm link'],
  },
  agent: {
    usage: 'skm agent <add|remove|list>',
    summary: '维护 agent 注册表：新增、注销、列出接收链接的 coding agent',
    details: [
      '注册表存在 ~/.agents/skm.config.json 的 agents 段（名称 → 技能目录）；本命令等价于安全地改它。',
      '默认注册表只内置 claude；其他 agent（workbuddy、codebuddy、codex、cursor…）需先 add 才能 enable。',
      '子命令:',
      '  skm agent add <名字> <路径>   注册一个 agent。路径相对 HOME 存储（也接受绝对路径与 ~ 开头）',
      '  skm agent remove <名字>       注销 agent：移除注册项、启用记录，以及其目录下指向中心存储的链接',
      '  skm agent list                列出已注册 agent 及其启用情况（skm agent 不带子命令时同此）',
      '安全约束：名称只允许字母数字与 . _ -；路径不得是 HOME 本身、中心存储内或其父目录，也不得与其他 agent 重复。',
      '注销只删链接，agent 目录中的原生真实目录一律保留；交互终端下需确认，非交互模式必须 --force。',
    ],
    examples: ['skm agent add cursor .cursor/skills', 'skm agent add windsurf D:/tools/windsurf/skills', 'skm agent list', 'skm agent remove cursor --force'],
  },
  remove: {
    usage: 'skm remove <合集>',
    summary: '删除合集：中心存储数据、所有 agent 链接与启用记录',
    details: [
      '操作不可逆。交互终端下需确认，非交互模式下必须传 --force。',
      '参数:',
      '  --force  跳过确认，直接删除',
    ],
    examples: ['skm remove my-skills'],
  },
  rename: {
    usage: 'skm rename <旧合集名> <新合集名>',
    summary: '重命名合集：锁文件、中心目录、启用清单与全部链接一并迁移',
    details: [
      '合集名同时是中心存储下的一级目录名（~/.agents/skills/<合集名>），改名会移动目录并重建相关链接。',
      '直接改目录名是无效的——合集身份记在锁文件里，skm list 读的就是它；请改用本命令。',
      '若目录已被手工改名（锁文件与磁盘错位），本命令会采纳既有目录、只迁移元数据，用于修复状态。',
      '参数:',
      '  --dry-run  只显示将做什么，不做任何改动',
    ],
    examples: ['skm rename skills humanlayer-skills', 'skm rename my-coll my-new-name --dry-run'],
  },
  help: {
    usage: 'skm help [命令]',
    summary: '显示本帮助；指定命令名可查看该命令的详细参数',
    details: [],
    examples: ['skm help', 'skm help add'],
  },
};

function printCommandHelp(name) {
  const c = COMMANDS[name];
  if (!c) {
    console.error(`未知命令 "${name}"。可用命令: ${Object.keys(COMMANDS).join(', ')}`);
    return false;
  }
  console.log(`用法: ${c.usage}`);
  console.log(`\n${c.summary}`);
  for (const line of c.details) console.log(line);
  if (c.examples.length) {
    console.log('示例:');
    for (const ex of c.examples) console.log(`  ${ex}`);
  }
  return true;
}

function cmdHelp(cmdName) {
  if (cmdName) return printCommandHelp(cmdName);
  console.log('skm — 轻量跨 coding agent 技能管理器（中心存储 ~/.agents/skills/，各 agent 通过链接接入）');
  console.log('\n用法: skm <命令> [参数]');
  console.log('\n命令:');
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, c] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(width)}  ${c.summary}`);
  }
  console.log('\n查看单个命令详情: skm help <命令>，例如 skm help add');
  return true;
}

function parseArgs(argv) {
  const VALUE_FLAGS = new Set(['skill', 'enable', 'exclude']);
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else flags[key] = true;
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

function splitList(v) {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- main ----------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  // 无参数 → 概览并退出 1；help/-h/--help → 概览退出 0；help <cmd> → 单命令详情
  if (!cmd) {
    cmdHelp();
    process.exit(1);
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const ok = cmdHelp(rest.find((a) => !a.startsWith('--')));
    process.exit(ok ? 0 : 1);
  }
  // skm <cmd> --help：先展示该命令帮助，再执行原逻辑（帮助类调用无需配置环境）
  if (rest.some((a) => a === '--help' || a === '-h')) {
    if (cmdHelp(cmd)) process.exit(0);
    process.exit(1);
  }
  const cfg = loadConfig();
  const lock = loadLock();
  maybeMigrate(cfg, lock);
  const { flags, positional } = parseArgs(rest);
  switch (cmd) {
    case 'list':
      cmdList(cfg, lock);
      break;
    case 'add':
      await cmdAdd(cfg, lock, positional, flags);
      break;
    case 'enable':
      await cmdEnable(cfg, lock, positional, flags);
      break;
    case 'disable':
      await cmdDisable(cfg, lock, positional);
      break;
    case 'update':
      await cmdUpdate(cfg, lock, positional, flags);
      break;
    case 'remove':
      await cmdRemove(cfg, lock, positional, flags);
      break;
    case 'rename':
      cmdRename(cfg, lock, positional, flags);
      break;
    case 'link':
      process.exit(syncAllLinks(cfg, lock) ? 0 : 1);
      break;
    case 'agent':
      await cmdAgent(cfg, positional, flags);
      break;
    default:
      console.error(`未知命令 "${cmd}"。运行 skm help 查看可用命令`);
      process.exit(1);
  }
}

// 仅在直接运行本文件时执行；被 import（如测试）时不触发任何命令
function runningAsMain() {
  if (!process.argv[1]) return false;
  try {
    return pathKey(fs.realpathSync(process.argv[1])) === pathKey(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// 顶层兜底：命令内抛出的用法/校验错误只打印一行原因，不要把堆栈丢给用户
if (runningAsMain()) {
  main().catch((e) => {
    console.error(`skm: ${e.message}`);
    process.exit(1);
  });
}

export { parseSelection, resolveSource, validateCollectionName };
