// --- Java "modified UTF-8" fix --------------------------------------------------------------
// Minecraft 1.20.3+ sends chat/scoreboard text as NBT. Java encodes characters outside the BMP
// (custom badge glyphs, emoji) as two 3-byte surrogates (CESU-8). Node's utf8 decoder turns every
// one of those bytes into U+FFFD (six "?" per character). This shim re-decodes such buffers correctly.
// It only runs when a normal decode produced U+FFFD AND the bytes contain 0xED, so it costs nothing otherwise.
function decodeModifiedUtf8(buf) {
  const units = [];
  for (let i = 0; i < buf.length;) {
    const b = buf[i];
    if (b < 0x80) { units.push(b); i += 1; }
    else if ((b & 0xE0) === 0xC0 && i + 1 < buf.length) { units.push(((b & 0x1F) << 6) | (buf[i + 1] & 0x3F)); i += 2; }
    else if ((b & 0xF0) === 0xE0 && i + 2 < buf.length) { units.push(((b & 0x0F) << 12) | ((buf[i + 1] & 0x3F) << 6) | (buf[i + 2] & 0x3F)); i += 3; }
    else if ((b & 0xF8) === 0xF0 && i + 3 < buf.length) {
      const cp = ((b & 0x07) << 18) | ((buf[i + 1] & 0x3F) << 12) | ((buf[i + 2] & 0x3F) << 6) | (buf[i + 3] & 0x3F);
      const v = cp - 0x10000;
      units.push(0xD800 + (v >> 10), 0xDC00 + (v & 0x3FF));
      i += 4;
    } else { units.push(0xFFFD); i += 1; }
  }
  let out = '';
  for (let i = 0; i < units.length; i += 8192) out += String.fromCharCode.apply(null, units.slice(i, i + 8192));
  return out;
}
const originalBufferToString = Buffer.prototype.toString;
Buffer.prototype.toString = function (encoding, start, end) {
  const text = originalBufferToString.call(this, encoding, start, end);
  if ((encoding === undefined || encoding === 'utf8' || encoding === 'utf-8') && text.includes('\uFFFD')) {
    const slice = this.subarray(start || 0, end === undefined ? this.length : end);
    if (slice.includes(0xED)) return decodeModifiedUtf8(slice);
  }
  return text;
};
// ---------------------------------------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const path = require('path');
const fs = require('fs');

let mineflayerViewer = null;
try {
  mineflayerViewer = require('prismarine-viewer').mineflayer;
} catch (e) { }

let bedrockProtocol = null;
try {
  bedrockProtocol = require('bedrock-protocol');
} catch (e) { }

const app = express();
app.get('/healthz', (req, res) => res.type('text/plain').send('ok')); // tiny response for UptimeRobot
const server = http.createServer(app);
// permessageDeflate compresses the repetitive JSON updates (saves a lot of outbound bandwidth)
const io = new Server(server, { perMessageDeflate: { threshold: 512 } });

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'bot_accounts.json');
const QUICK_FILE = path.join(__dirname, 'quick_commands.json');

// Custom quick buttons (shared by all accounts): [{ label, command }]
function sanitizeQuickCommands(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 12).map((item) => {
    const command = String((item && item.command) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 256);
    const label = String((item && item.label) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 30) || command.slice(0, 30);
    return { label, command };
  }).filter(item => item.command);
}
function loadQuickCommands() {
  try {
    if (fs.existsSync(QUICK_FILE)) return sanitizeQuickCommands(JSON.parse(fs.readFileSync(QUICK_FILE, 'utf8')));
  } catch (err) {
    console.error('Gagal membaca quick_commands.json:', err.message);
  }
  return [];
}
let quickCommands = loadQuickCommands();

function getBot(botId) {
  return typeof botId === 'string' && Object.prototype.hasOwnProperty.call(botInstances, botId)
    ? botInstances[botId]
    : null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// Commands whose result can be checked. A command counts as done when the server confirms it in chat
// (pattern), the bot was moved (minMove blocks) or one of the listed events fired. Otherwise it is retried.
const VERIFY_TIME_SCALE = Number(process.env.VERIFY_TIME_SCALE) || 1; // only lowered by tests
const VERIFY_RULES = [
  {
    name: 'teleport ke island',
    match: /^\/(is|island)(\s+(go|home|tp))?$/i,
    pattern: /teleported to your island|teleport(ed)? to (your )?island/i,
    minMove: 8,
    timeoutMs: 10000,
    attempts: 3,
    retryDelayMs: 4000
  },
  {
    name: 'pindah server',
    match: /^\/server\s+\S+/i,
    pattern: /already connected|sudah terhubung/i,
    events: ['login', 'respawn', 'spawn'],
    timeoutMs: 15000,
    attempts: 2,
    retryDelayMs: 3000
  }
];
const SPATIAL_INTERVAL_MS = 2000; // how often position/inventory/scoreboard are checked for changes
const ITEM_GUI_MAX_WAIT_MS = 90000; // how long an item stays in hand while its menu is open

const defaultAccounts = [];

let accounts = defaultAccounts;

if (fs.existsSync(CONFIG_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (Array.isArray(saved) && saved.length > 0) {
      accounts = saved.map(acc => {
        if (acc.scriptText) {
          acc.scriptText = acc.scriptText.split('\n').filter(l => !l.toLowerCase().includes('reco')).join('\n');
        }

        return acc;
      });
    }
  } catch (err) {
    console.error('Gagal membaca bot_accounts.json:', err.message);
  }
}

function saveAccounts() {
  try {
    const dataToSave = Object.values(botInstances).map(b => b.config);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dataToSave, null, 2), 'utf8');
  } catch (err) {
    console.error('Gagal menyimpan bot_accounts.json:', err.message);
  }
}

// Clean Minecraft text (ChatMessage objects, color § codes, JSON formatted strings)
function cleanMcText(raw) {
  if (!raw) return '';

  if (typeof raw === 'string') {
    let str = raw.trim();
    if (str.startsWith('{') || str.startsWith('[')) {
      try {
        const parsed = JSON.parse(str);
        return cleanMcText(parsed);
      } catch (e) { }
    }
    return str.replace(/§[0-9a-fk-or]/gi, '').trim();
  }

  if (typeof raw === 'object') {
    if (raw.text !== undefined && raw.text !== null) {
      let res = cleanMcText(raw.text);
      if (Array.isArray(raw.extra)) {
        res += ' ' + raw.extra.map(e => cleanMcText(e)).join(' ');
      }
      return res.replace(/§[0-9a-fk-or]/gi, '').trim();
    }
    if (raw.value !== undefined && raw.value !== null) {
      return cleanMcText(raw.value);
    }
    if (Array.isArray(raw.extra)) {
      return raw.extra.map(e => cleanMcText(e)).join(' ').replace(/§[0-9a-fk-or]/gi, '').trim();
    }
    if (Array.isArray(raw)) {
      return raw.map(e => cleanMcText(e)).join(' ').replace(/§[0-9a-fk-or]/gi, '').trim();
    }
    if (typeof raw.toString === 'function') {
      const s = raw.toString();
      if (s && s !== '[object Object]') {
        return s.replace(/§[0-9a-fk-or]/gi, '').trim();
      }
    }
    try {
      const jsonStr = JSON.stringify(raw);
      if (jsonStr) {
        return jsonStr.replace(/["{}]/g, '').replace(/§[0-9a-fk-or]/gi, '').trim();
      }
    } catch (e) { }
  }

  return String(raw).replace(/§[0-9a-fk-or]/gi, '').trim();
}

// Convert typed NBT (prismarine-nbt format) into plain JS values.
// Used for item custom names / lore on newer Minecraft versions (component format).
function simplifyNbt(n) {
  if (n === null || n === undefined) return n;
  if (Array.isArray(n)) return n.map(simplifyNbt);
  if (typeof n !== 'object') return n;
  if ('type' in n && 'value' in n) {
    if (n.type === 'compound') {
      const out = {};
      for (const k in n.value) out[k] = simplifyNbt(n.value[k]);
      return out;
    }
    if (n.type === 'list') {
      const inner = n.value || {};
      const arr = Array.isArray(inner.value) ? inner.value : [];
      return arr.map(el => (inner.type === 'compound' ? simplifyNbt({ type: 'compound', value: el }) : el));
    }
    return simplifyNbt(n.value);
  }
  return n;
}

// ---- Styled Minecraft text (colors / bold / italic ...) -> compact "runs" for the dashboard ----
const MC_COLORS = {
  black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00', dark_aqua: '#00AAAA',
  dark_red: '#AA0000', dark_purple: '#AA00AA', gold: '#FFAA00', gray: '#AAAAAA',
  dark_gray: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF',
  red: '#FF5555', light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF'
};
const MC_LEGACY_CODES = {
  '0': 'black', '1': 'dark_blue', '2': 'dark_green', '3': 'dark_aqua', '4': 'dark_red',
  '5': 'dark_purple', '6': 'gold', '7': 'gray', '8': 'dark_gray', '9': 'blue',
  'a': 'green', 'b': 'aqua', 'c': 'red', 'd': 'light_purple', 'e': 'yellow', 'f': 'white'
};

function mcResolveColor(c) {
  if (!c) return undefined;
  const str = String(c);
  if (/^#[0-9a-f]{6}$/i.test(str)) return str.toUpperCase();
  return MC_COLORS[str.toLowerCase()];
}

function mcToBool(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return undefined;
}

function mcPushRun(runs, text, st) {
  if (!text) return;
  const run = { t: text };
  if (st.c) run.c = st.c;
  if (st.b) run.b = 1;
  if (st.i) run.i = 1;
  if (st.u) run.u = 1;
  if (st.s) run.s = 1;
  if (st.o) run.o = 1;
  runs.push(run);
}

// Legacy "§" formatting codes inside a plain string (also §x§R§R§G§G§B§B hex colors)
function mcLegacyRuns(str, base, runs) {
  let st = { ...base };
  let buf = '';
  const flush = () => { mcPushRun(runs, buf, st); buf = ''; };
  for (let k = 0; k < str.length; k++) {
    const ch = str[k];
    if (ch === '§' && k + 1 < str.length) {
      const code = str[k + 1].toLowerCase();
      if (code === 'x') {
        const chunk = str.substr(k, 14);
        if (/^§x(§[0-9a-f]){6}$/i.test(chunk)) {
          flush();
          st = { c: '#' + chunk.replace(/§/g, '').substring(1).toUpperCase() };
          k += 13;
          continue;
        }
      }
      flush();
      if (MC_LEGACY_CODES[code]) st = { c: MC_COLORS[MC_LEGACY_CODES[code]] };
      else if (code === 'l') st = { ...st, b: true };
      else if (code === 'o') st = { ...st, i: true };
      else if (code === 'n') st = { ...st, u: true };
      else if (code === 'm') st = { ...st, s: true };
      else if (code === 'k') st = { ...st, o: true };
      else if (code === 'r') st = {};
      k++;
      continue;
    }
    buf += ch;
  }
  flush();
}

function mcComponentRuns(node, parent, runs) {
  if (node === null || node === undefined) return;

  if (typeof node === 'string') {
    const t = node.trim();
    if (t.startsWith('{') || t.startsWith('[') || (t.startsWith('"') && t.endsWith('"'))) {
      try { mcComponentRuns(JSON.parse(t), parent, runs); return; } catch (e) { }
    }
    mcLegacyRuns(node, parent, runs);
    return;
  }
  if (typeof node === 'number' || typeof node === 'boolean') {
    mcLegacyRuns(String(node), parent, runs);
    return;
  }
  if (Array.isArray(node)) {
    // JSON array: later elements inherit the style of the first one
    let inherited = parent;
    node.forEach((el, idx) => {
      mcComponentRuns(el, idx === 0 ? parent : inherited, runs);
      if (idx === 0 && el && typeof el === 'object' && !Array.isArray(el)) inherited = mcMergeStyle(parent, el);
    });
    return;
  }
  if (typeof node === 'object') {
    const st = mcMergeStyle(parent, node);
    let text = node.text;
    if (text === undefined || text === null) text = node.fallback || node.translate || '';
    if (text !== '') mcLegacyRuns(String(text), st, runs);
    if (Array.isArray(node.extra)) node.extra.forEach(child => mcComponentRuns(child, st, runs));
  }
}

function mcMergeStyle(parent, node) {
  const st = { ...parent };
  const color = mcResolveColor(node.color);
  if (color) st.c = color;
  const flags = { b: node.bold, i: node.italic, u: node.underlined, s: node.strikethrough, o: node.obfuscated };
  for (const key in flags) {
    const v = mcToBool(flags[key]);
    if (v !== undefined) st[key] = v;
  }
  return st;
}

// raw (string JSON / legacy § string / typed NBT) -> [{t, c?, b?, i?, u?, s?, o?}]
function toStyledRuns(raw) {
  const runs = [];
  try { mcComponentRuns(simplifyNbt(raw), {}, runs); } catch (e) { return []; }
  const merged = [];
  runs.forEach(r => {
    const last = merged[merged.length - 1];
    if (last && last.c === r.c && last.b === r.b && last.i === r.i && last.u === r.u && last.s === r.s && last.o === r.o) {
      last.t += r.t;
    } else {
      merged.push({ ...r });
    }
  });
  return merged;
}

const runsToPlainText = (runs) => runs.map(r => r.t).join('').replace(/\s+/g, ' ').trim();

// Read the real (server-defined) item name and lore. item.displayName is only the vanilla name.
// Lore keeps blank lines (they are used as spacing in menus); trailing blank lines are dropped.
function getItemCustomText(item) {
  let customName = '';
  let nameRuns = [];
  let loreRuns = [];
  try {
    const rawName = item.customName;
    if (rawName !== null && rawName !== undefined) {
      nameRuns = toStyledRuns(rawName);
      customName = runsToPlainText(nameRuns);
    }
  } catch (e) { }
  try {
    const rawLore = item.customLore;
    if (rawLore !== null && rawLore !== undefined) {
      const simple = simplifyNbt(rawLore);
      const list = Array.isArray(simple) ? simple : [simple];
      loreRuns = list.map(l => toStyledRuns(l));
      while (loreRuns.length && runsToPlainText(loreRuns[loreRuns.length - 1]) === '') loreRuns.pop();
    }
  } catch (e) { }
  if (!customName) nameRuns = [];
  return { customName, nameRuns, loreRuns };
}

// Clickable parts of a chat message (e.g. "[Player's Inventory]" -> /command). Reads both the old
// "clickEvent" and the 1.21.5+ "click_event" naming, also inside "extra" and translate "with" lists.
function extractChatActions(msg) {
  const out = [];
  const root = msg && msg.json !== undefined ? msg.json : msg;
  const plain = (j) => {
    if (typeof j === 'string') return j;
    if (!j || typeof j !== 'object') return '';
    return String(j.text || '') + (Array.isArray(j.extra) ? j.extra.map(plain).join('') : '');
  };
  const walk = (j, depth) => {
    if (!j || typeof j !== 'object' || depth > 12 || out.length >= 5) return;
    const ce = j.clickEvent || j.click_event;
    if (ce && ce.action === 'run_command') {
      let cmd = String(ce.value !== undefined ? ce.value : (ce.command || '')).trim();
      if (cmd && cmd.length <= 200 && !/[\r\n]/.test(cmd)) {
        if (!cmd.startsWith('/')) cmd = '/' + cmd;
        out.push({ text: plain(j).trim(), command: cmd });
      }
    }
    if (Array.isArray(j.extra)) j.extra.forEach(e => walk(e, depth + 1));
    if (Array.isArray(j.with)) j.with.forEach(e => walk(e, depth + 1));
  };
  walk(root, 0);
  return out;
}

// Extract Scoreboard data from Mineflayer bot instance
const SCOREBOARD_DEFAULT_TITLE = 'Scoreboard';

// Objective that the server actually displays in the sidebar (display slot 1)
function findSidebarObjective(bot) {
  if (bot.scoreboard && bot.scoreboard.sidebar) return bot.scoreboard.sidebar;
  if (bot.scoreboards) {
    for (const key in bot.scoreboards) {
      if (/sidebar/i.test(key) && bot.scoreboards[key]) return bot.scoreboards[key];
    }
  }
  return null;
}

// Text of one sidebar line: custom line text (1.20.3+) > team prefix + name + suffix > plain name
function scoreboardLineText(bot, item) {
  if (item.lineNbt) {
    const custom = cleanMcText(item.lineNbt);
    if (custom && custom !== '[object Object]') return custom;
  }
  const team = (bot.teamMap && bot.teamMap[item.name]) || (bot.teams && bot.teams[item.name]);
  if (team) {
    const text = (cleanMcText(team.prefix || '') + item.name + cleanMcText(team.suffix || '')).replace(/TAB-[A-Za-z]+-\d+/gi, '').trim();
    if (text && !text.includes('[object Object]')) return text;
  }
  const plain = item.displayName ? cleanMcText(item.displayName) : cleanMcText(item.name);
  return plain === '[object Object]' ? '' : plain;
}

function extractScoreboard(bot) {
  if (!bot) return { title: SCOREBOARD_DEFAULT_TITLE, items: [], source: 'none' };

  const sidebar = findSidebarObjective(bot);

  // Title: real title from the server, otherwise the last real one we saw
  let titleStr = sidebar ? cleanMcText(sidebar.title) : '';
  if (titleStr && titleStr !== '[object Object]') {
    bot._lastScoreboardTitle = titleStr;
  } else {
    titleStr = bot._lastScoreboardTitle || SCOREBOARD_DEFAULT_TITLE;
  }

  // 1) Normal path: items of the objective shown in the sidebar
  if (sidebar && sidebar.itemsMap) {
    const rawItems = Object.values(sidebar.itemsMap)
      .map((item, idx) => ({ item, idx }))
      .filter(e => e.item)
      .sort((x, y) => ((y.item.value || 0) - (x.item.value || 0)) || (x.idx - y.idx)); // stable on ties

    const items = [];
    rawItems.forEach(({ item }) => {
      const lineText = scoreboardLineText(bot, item);
      if (lineText) {
        items.push({
          name: lineText,
          value: item.hideValue ? '' : (item.value !== undefined ? item.value : '')
        });
      }
    });
    if (items.length > 0) return { title: titleStr, items, source: `objective:${sidebar.name}` };
  }

  // 2) Backup: TAB plugin sidebar lines are teams named TAB-Sidebar-<n>. Only these teams are used,
  //    never the per-player sorting teams, otherwise players show up between the sidebar lines.
  if (bot.teams) {
    const tabLines = Object.values(bot.teams)
      .filter(t => t && /^TAB-Sidebar-\d+$/i.test(String(t.team || '')))
      .sort((x, y) => parseInt(String(x.team).split('-').pop(), 10) - parseInt(String(y.team).split('-').pop(), 10));

    const items = [];
    tabLines.forEach(t => {
      const text = (cleanMcText(t.prefix || '') + cleanMcText(t.suffix || '')).trim();
      if (text && !text.includes('[object Object]')) items.push({ name: text, value: '' });
    });
    if (items.length > 0) return { title: titleStr, items, source: 'tab-teams' };
  }

  return { title: titleStr, items: [], source: 'none' };
}

// Bot Instance Manager class
class BotManager {
  constructor(config) {
    this.config = config;
    this.bot = null;
    this.status = 'offline';
    this.health = { health: 20, food: 20 };
    this.position = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, dimension: 'overworld' };
    this.scoreboard = { title: SCOREBOARD_DEFAULT_TITLE, items: [], source: 'none' };
    this.inventory = [];
    this.nearbyEntities = [];
    this.activeGuiWindow = null;
    this.reconnectTimer = null;
    this.scriptTimeouts = [];
    this.spatialInterval = null;
    this.logHistory = [];
    this.MAX_LOGS = 150;
  }

  addLog(message, type = 'info', actions = null) {
    const timestamp = new Date().toLocaleTimeString('id-ID', { hour12: false });
    const entry = { timestamp, message, type, botId: this.config.id };
    if (actions && actions.length > 0) entry.actions = actions;
    this.logHistory.push(entry);
    if (this.logHistory.length > this.MAX_LOGS) {
      this.logHistory.shift();
    }
    io.emit('bot-log', { botId: this.config.id, log: entry });
    console.log(`[${timestamp}] [${this.config.id}] [${type.toUpperCase()}] ${message}`);
  }

  updateStatus(newStatus, detail = '') {
    this.status = newStatus;
    io.emit('bot-status-update', {
      botId: this.config.id,
      status: this.status,
      detail,
      health: this.health,
      position: this.position,
      scoreboard: this.scoreboard,
      config: this.config,
      activeGui: this.activeGuiWindow
    });
  }

  stopScript() {
    this.scriptTimeouts.forEach(clearTimeout);
    this.scriptTimeouts = [];
    this._scriptRun = (this._scriptRun || 0) + 1; // invalidates a running script
  }

  // Waits (max ~30s) until the bot has spawned in the world, so commands are not sent too early
  async waitBotSpawned(runId) {
    for (let i = 0; i < 60; i++) {
      if (this._scriptRun !== runId || !this.bot || this.status !== 'online') return false;
      if (this.bot.entity) return true;
      await sleep(500);
    }
    return false;
  }

  // Sends `cmd` and resolves true once the server confirmed it (see VERIFY_RULES), false on timeout
  sendAndVerify(cmd, rule) {
    const bot = this.bot;
    const startPos = bot.entity ? bot.entity.position.clone() : null;
    return new Promise((resolve) => {
      let settled = false;
      const events = rule.events || [];
      const onMsg = (msg) => { if (rule.pattern && rule.pattern.test(String(msg))) done(true); };
      const onMove = () => {
        if (rule.minMove && startPos && bot.entity && bot.entity.position.distanceTo(startPos) >= rule.minMove) done(true);
      };
      const onEvent = () => done(true);
      const poll = setInterval(onMove, Math.max(10, 500 * VERIFY_TIME_SCALE));
      const timer = setTimeout(() => done(false), rule.timeoutMs * VERIFY_TIME_SCALE);
      function cleanup() {
        clearInterval(poll);
        clearTimeout(timer);
        bot.removeListener('messagestr', onMsg);
        bot.removeListener('forcedMove', onMove);
        events.forEach(e => bot.removeListener(e, onEvent));
      }
      function done(ok) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(ok);
      }
      // Listen first, then send, so a very fast reply is not missed
      bot.on('messagestr', onMsg);
      bot.on('forcedMove', onMove);
      events.forEach(e => bot.on(e, onEvent));
      try {
        bot.chat(cmd);
      } catch (e) {
        done(false);
      }
    });
  }

  async runScript() {
    this.stopScript();
    if (!this.config.scriptEnabled) return;
    const runId = this._scriptRun;

    let items = [];
    if (Array.isArray(this.config.autoCmds) && this.config.autoCmds.length > 0) {
      items = this.config.autoCmds.map(item => {
        if (typeof item === 'string') {
          return { cmd: item.trim(), delaySec: 2 };
        } else if (typeof item === 'object' && item !== null) {
          return {
            cmd: (item.cmd || '').trim(),
            delaySec: typeof item.delaySec === 'number' ? item.delaySec : (parseInt(item.delaySec) || 2)
          };
        }
        return null;
      }).filter(i => i && i.cmd);
    } else if (this.config.scriptText) {
      const lines = this.config.scriptText
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && !l.toLowerCase().includes('reco'));

      let pendingDelaySec = 2;
      lines.forEach((line) => {
        const lower = line.toLowerCase();
        if (lower.startsWith('wait ')) {
          const valStr = line.split(' ')[1];
          const val = parseInt(valStr || '40');
          pendingDelaySec = Math.max(0, Math.round(val / 20));
        } else if (lower.startsWith('send ')) {
          let rawCmd = line.substring(5).trim();
          items.push({ cmd: rawCmd, delaySec: pendingDelaySec });
          pendingDelaySec = 2;
        }
      });
    }

    if (items.length === 0) return;

    this.addLog('Menjalankan Perintah Otomatis (Dengan Jeda Kustom)...', 'system');

    const alive = () => this._scriptRun === runId && this.bot && this.status === 'online';
    const verify = this.config.verifyCommands !== false;
    const mask = (text) => (this.config.password ? text.split(this.config.password).join('***') : text);

    // Commands run one after another: each delay starts when the previous command is finished/confirmed
    for (const item of items) {
      await sleep(Math.max(0, item.delaySec) * 1000 * VERIFY_TIME_SCALE);
      if (!alive()) return;
      if (!(await this.waitBotSpawned(runId))) {
        if (alive()) this.addLog('Bot belum selesai masuk ke dunia, perintah otomatis dihentikan.', 'warning');
        return;
      }

      let cmd = item.cmd;
      if (!cmd.startsWith('/') && !cmd.toLowerCase().startsWith('send ')) cmd = '/' + cmd;
      if (cmd.toLowerCase().startsWith('send ')) cmd = cmd.substring(5).trim();
      if (this.config.password) cmd = cmd.split('{password}').join(this.config.password);

      const rule = verify ? VERIFY_RULES.find(r => r.match.test(cmd)) : null;
      const attempts = rule ? rule.attempts : 1;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (!alive()) return;
        this.addLog(`[PERINTAH DILAKSANAKAN] ${mask(cmd)}${attempts > 1 ? ` (percobaan ${attempt}/${attempts})` : ''}`, 'mychat');

        let ok = true;
        try {
          if (rule) ok = await this.sendAndVerify(cmd, rule);
          else this.bot.chat(cmd);
        } catch (e) {
          this.addLog(`Gagal menjalankan perintah (${mask(cmd)}): ${e.message}`, 'error');
          break;
        }
        if (!rule) break;
        if (!alive()) return;

        if (ok) {
          this.addLog(`✓ ${rule.name} terkonfirmasi (${mask(cmd)})`, 'success');
          break;
        }
        if (attempt < attempts) {
          this.addLog(`${rule.name} belum terkonfirmasi, mengulang dalam ${rule.retryDelayMs / 1000} detik...`, 'warning');
          await sleep(rule.retryDelayMs * VERIFY_TIME_SCALE);
        } else {
          this.addLog(`✗ ${rule.name} gagal terkonfirmasi setelah ${attempts} percobaan. Lanjut ke perintah berikutnya.`, 'error');
        }
      }
    }
  }

  startSpatialBroadcast() {
    if (this.spatialInterval) clearInterval(this.spatialInterval);

    this.spatialInterval = setInterval(() => {
      if (!this.bot || this.status !== 'online') return;

      try {
        if (this.bot.entity) {
          this.position = {
            x: Math.round(this.bot.entity.position.x * 10) / 10,
            y: Math.round(this.bot.entity.position.y * 10) / 10,
            z: Math.round(this.bot.entity.position.z * 10) / 10,
            yaw: Math.round((this.bot.entity.yaw * 180 / Math.PI) % 360),
            pitch: Math.round(this.bot.entity.pitch * 180 / Math.PI),
            dimension: (this.bot.game && this.bot.game.dimension) ? this.bot.game.dimension : 'overworld'
          };
        }

        this.refreshScoreboard();

        if (this.bot.inventory) {
          this.inventory = this.bot.inventory.items().map(item => {
            // Same custom name / lore handling as the chest GUI, so tooltips show the server's item names
            const custom = getItemCustomText(item);
            const entry = {
              slot: item.slot,
              name: item.name,
              displayName: cleanMcText(item.displayName || item.name || ''),
              customName: custom.customName,
              count: item.count
            };
            if (custom.nameRuns.length) entry.nameRuns = custom.nameRuns;
            if (custom.loreRuns.length) entry.loreRuns = custom.loreRuns;
            return entry;
          });
        }

        // Strict Local Barrier Entity & Player Detection + Cross-Bot Distance Calculator
        const botPos = this.bot.entity ? this.bot.entity.position : null;
        const detected = [];

        if (this.bot.entities && botPos) {
          for (const id in this.bot.entities) {
            const e = this.bot.entities[id];
            if (!e || e === this.bot.entity || !e.position) continue;

            const dist = Math.round(botPos.distanceTo(e.position) * 10) / 10;

            if (dist <= 100) {
              // Players only: mobs, items, armor stands and other entities are ignored
              if (!(e.username || e.type === 'player')) continue;
              const entType = 'player';

              let entName = e.username || cleanMcText(e.displayName) || e.name || e.mobType || '';

              if (entName && entName !== 'air' && entName !== 'unknown' && !entName.startsWith('Armor Stand')) {
                detected.push({
                  id: e.id || id,
                  name: entName,
                  type: entType,
                  distance: dist
                });
              }
            }
          }
        }

        // Calculate exact 3D distance for other connected bots
        for (const accId in botInstances) {
          if (accId === this.config.id) continue;
          const otherBot = botInstances[accId];
          if (otherBot && otherBot.status === 'online' && otherBot.position) {
            const p1 = this.position;
            const p2 = otherBot.position;
            if (p1 && p2 && (p1.x !== 0 || p1.y !== 0 || p1.z !== 0) && (p2.x !== 0 || p2.y !== 0 || p2.z !== 0)) {
              const dx = p2.x - p1.x;
              const dy = p2.y - p1.y;
              const dz = p2.z - p1.z;
              const distCalc = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 10) / 10;

              if (distCalc <= 100) {
                const idx = detected.findIndex(d => d.name.toLowerCase() === otherBot.config.username.toLowerCase());
                if (idx !== -1) {
                  detected[idx].distance = distCalc;
                } else {
                  detected.push({
                    id: otherBot.config.username,
                    name: otherBot.config.username,
                    type: 'player',
                    distance: distCalc
                  });
                }
              }
            }
          }
        }

        detected.sort((a, b) => a.distance - b.distance);
        this.nearbyEntities = detected.slice(0, 15);

        // Nobody is watching: send nothing (a browser that connects later gets the full state from init-multi)
        const liveRoom = io.sockets.adapter.rooms.get('live');
        if (!liveRoom || liveRoom.size === 0) {
          this._lastSent = {};
          return;
        }

        // Send only the sections that changed since the last update
        const sections = {
          position: this.position,
          scoreboard: this.scoreboard,
          inventory: this.inventory,
          entities: (this.nearbyEntities || []).map(e => ({ ...e, distance: Math.round(e.distance) }))
        };
        this._lastSent = this._lastSent || {};
        const payload = { botId: this.config.id };
        let changed = false;
        for (const key in sections) {
          const json = JSON.stringify(sections[key]);
          if (json !== this._lastSent[key]) {
            this._lastSent[key] = json;
            payload[key] = sections[key];
            changed = true;
          }
        }
        if (changed) io.to('live').emit('bot-spatial-update', payload);
      } catch (err) { }
    }, SPATIAL_INTERVAL_MS);
  }

  stopSpatialBroadcast() {
    if (this.spatialInterval) {
      clearInterval(this.spatialInterval);
      this.spatialInterval = null;
    }
  }

  start() {
    if (this.status === 'connecting' || this.status === 'online') {
      this.addLog('Bot sudah berjalan atau sedang terhubung.', 'warning');
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.updateStatus('connecting', 'Menghubungkan ke server...');
    this.addLog(`Menghubungkan bot (${this.config.username}) ke ${this.config.host}:${this.config.port}...`, 'system');

    if (this.config.platform === 'bedrock') {
      this.startBedrockBot();
      return;
    }

    const AUTH_CACHE_DIR = path.join(__dirname, 'auth_cache');
    if (!fs.existsSync(AUTH_CACHE_DIR)) {
      try { fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true }); } catch (e) { }
    }

    const options = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      auth: this.config.auth === 'microsoft' ? 'microsoft' : 'offline',
    };

    if (this.config.auth === 'microsoft') {
      options.profilesFolder = path.join(AUTH_CACHE_DIR, this.config.id);
      options.onMsaCode = (data) => {
        const msg = `🔐 KODE LOGIN MICROSOFT: Buka ${data.verification_uri} dan masukkan kode: ${data.user_code}`;
        this.addLog(msg, 'warning');
        io.emit('bot-msa-code', {
          botId: this.config.id,
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          message: data.message
        });
      };
    }

    if (this.config.version && this.config.version !== 'auto') {
      options.version = this.config.version;
    }

    try {
      this.bot = mineflayer.createBot(options);
    } catch (err) {
      this.addLog(`Gagal membangkitkan bot: ${err.message}`, 'error');
      this.updateStatus('error', err.message);
      this.scheduleReconnect();
      return;
    }

    // Minecraft 1.20.3+ changed the score packets (no "action" field, separate reset_score packet).
    // Mineflayer ignores them, which leaves every scoreboard empty, so they are handled here.
    const botRef = this.bot;
    if (botRef._client) {
      botRef._client.on('scoreboard_score', (packet) => {
        if (this.bot !== botRef || packet.action !== undefined) return; // old protocol: mineflayer handles it
        const board = botRef.scoreboards && botRef.scoreboards[packet.scoreName];
        if (!board) return;
        const item = board.add(packet.itemName, packet.value);
        if (item) {
          item.lineNbt = packet.display_name || null;
          item.hideValue = packet.number_format === 0; // 0 = score number hidden
        }
        this.refreshScoreboard();
      });
      botRef._client.on('reset_score', (packet) => {
        if (this.bot !== botRef) return;
        const boards = packet.objective_name
          ? [botRef.scoreboards && botRef.scoreboards[packet.objective_name]]
          : Object.values(botRef.scoreboards || {});
        boards.forEach(board => { if (board) board.remove(packet.entity_name); });
        this.refreshScoreboard();
      });
    }

    this.bot.once('login', () => {
      this.addLog(`Berhasil Login ke server ${this.config.host}!`, 'success');
    });

    this.bot.once('spawn', () => {
      this.updateStatus('online', 'Bot Online & Spawning');
      this.addLog(`Bot (${this.config.username}) berhasil masuk ke game world!`, 'success');
      this.startSpatialBroadcast();
      this.runScript();

      if (mineflayerViewer && this.config.viewerPort) {
        try {
          mineflayerViewer(this.bot, { port: this.config.viewerPort, firstPerson: true });
          this.addLog(`Kamera 3D WebGL POV aktif di port ${this.config.viewerPort}`, 'success');
        } catch (e) { }
      }
    });

    // Handle Chest GUI Windows (Fix Your Generators, Menus, Warps)
    this.bot.on('windowOpen', (window) => {
      if (!window) return;
      const titleClean = cleanMcText(window.title);
      this.addLog(`GUI Terbuka: "${titleClean}"`, 'system');

      let hasAutoClicked = false;
      let debugLogged = false;
      let lastGuiSignature = '';

      const processWindow = () => {
        if (!this.bot || !this.bot.currentWindow) return;
        const currentWin = this.bot.currentWindow;
        const rawSlots = currentWin.slots || [];
        const rawCount = rawSlots.length;

        let containerSize = 54;
        if (typeof currentWin.inventoryStart === 'number' && currentWin.inventoryStart > 0) {
          containerSize = currentWin.inventoryStart;
        } else if (rawCount === 63) {
          containerSize = 27;
        } else if (rawCount >= 90 || /market|night|fix|generator|reward|shop|menu/i.test(titleClean)) {
          containerSize = 54;
        } else if (rawCount > 36) {
          containerSize = rawCount - 36;
        }

        const totalExpected = containerSize + 36;
        const loopMax = Math.max(rawCount, totalExpected);

        const slotsData = [];
        for (let i = 0; i < loopMax; i++) {
          const item = rawSlots[i];
          if (item) {
            const custom = getItemCustomText(item);
            const slotEntry = {
              slot: i,
              name: item.name || 'air',
              displayName: cleanMcText(item.displayName || item.name || ''),
              customName: custom.customName,
              count: item.count || 1
            };
            if (custom.nameRuns.length) slotEntry.nameRuns = custom.nameRuns;
            if (custom.loreRuns.length) slotEntry.loreRuns = custom.loreRuns;
            slotsData.push(slotEntry);
            if (process.env.DEBUG_GUI && !debugLogged && (custom.customName || custom.loreRuns.length)) {
              debugLogged = true;
              try {
                this.addLog(`[DEBUG_GUI] slot ${i} customName(raw)=${JSON.stringify(item.customName).slice(0, 300)} lore(raw)=${JSON.stringify(item.customLore).slice(0, 300)}`, 'system');
              } catch (e) { }
            }
          } else {
            slotsData.push({ slot: i, name: 'air', displayName: '', customName: '', count: 0 });
          }
        }

        this.activeGuiWindow = {
          id: currentWin.id,
          title: titleClean,
          inventoryStart: containerSize,
          slots: slotsData
        };

        // Only emit when the content actually changed (the window fires many update events while loading)
        const signature = JSON.stringify(this.activeGuiWindow);
        if (signature === lastGuiSignature) return;
        lastGuiSignature = signature;
        io.emit('bot-gui-open', { botId: this.config.id, gui: this.activeGuiWindow });
      };

      processWindow();
      [50, 150, 350, 700, 1200].forEach(delay => setTimeout(processWindow, delay));

      // Slot update events arrive in bursts: coalesce them into one trailing refresh
      let pendingRefresh = null;
      const debouncedProcess = () => {
        if (pendingRefresh) return;
        pendingRefresh = setTimeout(() => { pendingRefresh = null; processWindow(); }, 80);
      };

      try {
        window.on('updateSlot', debouncedProcess);
        window.on('windowItems', debouncedProcess);
      } catch (e) { }
    });

    this.bot.on('windowClose', () => {
      this.activeGuiWindow = null;
      io.emit('bot-gui-close', { botId: this.config.id });
    });

    this.bot.on('scoreboardPosition', () => {
      this.refreshScoreboard();
    });
    this.bot.on('scoreboardScoreUpdated', () => {
      this.refreshScoreboard();
    });
    this.bot.on('scoreboardTitleChanged', () => {
      this.refreshScoreboard();
    });

    this.bot.on('health', () => {
      if (!this.bot) return;
      this.health = {
        health: Math.round(this.bot.health || 0),
        food: Math.round(this.bot.food || 0)
      };
      io.emit('bot-health-update', { botId: this.config.id, health: this.health });
    });

    let lastLoggedMsgText = '';

    this.bot.on('messagestr', (message, messagePosition, jsonMsg) => {
      if (!message || message.trim() === '') return;
      if (messagePosition === 'game_info' || messagePosition === 'actionbar') return;
      if (/❤|\bmana\b|\bstamina\b|\bhealth\b/i.test(message) && /\d+\/\d+/.test(message)) return;

      const trimmed = message.trim();
      if (trimmed === lastLoggedMsgText) return;
      lastLoggedMsgText = trimmed;

      let actions = null;
      try { actions = extractChatActions(jsonMsg); } catch (e) { }
      this.addLog(trimmed, 'server', actions);
    });

    this.bot.on('kicked', (reason) => {
      let clean = reason;
      try { if (typeof reason === 'object') clean = JSON.stringify(reason); } catch (e) { }
      this.addLog(`Bot dikeluarkan (Kicked): ${clean}`, 'error');
      this.cleanup();
      this.updateStatus('offline', 'Kicked');
      this.scheduleReconnect();
    });

    this.bot.on('error', (err) => {
      this.addLog(`Error Koneksi: ${err.message || err}`, 'error');
      this.cleanup();
      this.updateStatus('error', err.message || 'Error Koneksi');
      this.scheduleReconnect();
    });

    this.bot.on('end', (reason) => {
      this.addLog(`Koneksi terputus: ${reason || 'Disconnected'}`, 'warning');
      this.cleanup();
      this.updateStatus('offline', 'Disconnected');
      this.scheduleReconnect();
    });
  }

  cleanup() {
    this.stopScript();
    this.stopSpatialBroadcast();
    this.activeGuiWindow = null;
    if (this.bedrockClient) {
      try {
        this.bedrockClient.removeAllListeners();
        this.bedrockClient.disconnect();
      } catch (e) { }
      this.bedrockClient = null;
    }
    if (this.bot) {
      const targetBot = this.bot;
      this.bot = null;
      try {
        if (targetBot.viewer) {
          targetBot.viewer.close();
        }
      } catch (e) { }
      try {
        if (typeof targetBot.removeAllListeners === 'function') {
          targetBot.removeAllListeners();
          targetBot.on('error', () => { });
        }
        if (targetBot._client && typeof targetBot._client.removeAllListeners === 'function') {
          targetBot._client.removeAllListeners();
          targetBot._client.on('error', () => { });
        }
        if (typeof targetBot.end === 'function') targetBot.end();
      } catch (e) { }
    }
  }

  startBedrockBot() {
    if (!bedrockProtocol) {
      this.addLog('Modul bedrock-protocol tidak tersedia.', 'error');
      this.updateStatus('error', 'bedrock-protocol missing');
      return;
    }

    this.updateStatus('connecting', 'Menghubungkan ke server Bedrock...');
    const bedrockPort = parseInt(this.config.port) || 19132;
    this.addLog(`Menghubungkan bot Bedrock (${this.config.username}) ke ${this.config.host}:${bedrockPort}...`, 'system');

    const AUTH_CACHE_DIR = path.join(__dirname, 'auth_cache');
    if (!fs.existsSync(AUTH_CACHE_DIR)) {
      try { fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true }); } catch (e) { }
    }

    const options = {
      host: this.config.host,
      port: bedrockPort,
      username: this.config.username,
      offline: this.config.auth !== 'microsoft',
      raknetBackend: 'jsp-raknet',
      profilesFolder: path.join(AUTH_CACHE_DIR, this.config.id),
      onMsaCode: (data) => {
        const msg = `🔐 KODE LOGIN MICROSOFT BEDROCK: Buka ${data.verification_uri} dan masukkan kode: ${data.user_code}`;
        this.addLog(msg, 'warning');
        io.emit('bot-msa-code', {
          botId: this.config.id,
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          message: data.message
        });
      }
    };

    try {
      this.bedrockClient = bedrockProtocol.createClient(options);
      this.bot = {
        username: this.config.username,
        entity: { position: new Vec3(0, 0, 0) },
        game: { dimension: 'overworld' },
        chat: (msg) => this.sendChat(msg)
      };
    } catch (err) {
      this.addLog(`Gagal membangkitkan bot Bedrock: ${err.message}`, 'error');
      this.updateStatus('error', err.message);
      this.scheduleReconnect();
      return;
    }

    const client = this.bedrockClient;

    client.once('join', () => {
      this.addLog(`Berhasil Login ke server Bedrock ${this.config.host}!`, 'success');
      this.updateStatus('online', 'Online di Bedrock World');
      this.startSpatialBroadcast();
      this.runScript();
    });

    client.once('spawn', () => {
      this.updateStatus('online', 'Bot Online & Spawning');
      this.addLog(`Bot Bedrock (${this.config.username}) berhasil masuk ke game world!`, 'success');
    });

    client.on('set_health', (packet) => {
      if (packet && packet.health !== undefined) {
        this.health = {
          health: Math.round(packet.health),
          food: 20
        };
        io.emit('bot-health-update', { botId: this.config.id, health: this.health });
      }
    });

    client.on('move_player', (packet) => {
      if (packet && packet.position) {
        this.position = {
          x: Math.round(packet.position.x * 10) / 10,
          y: Math.round(packet.position.y * 10) / 10,
          z: Math.round(packet.position.z * 10) / 10,
          yaw: packet.rotation ? Math.round(packet.rotation.z || 0) : 0,
          pitch: packet.rotation ? Math.round(packet.rotation.x || 0) : 0,
          dimension: 'overworld'
        };
        if (this.bot && this.bot.entity) {
          this.bot.entity.position = new Vec3(packet.position.x, packet.position.y, packet.position.z);
        }
      }
    });

    client.on('text', (packet) => {
      if (!packet) return;
      let textContent = packet.message || packet.source_name || '';
      if (packet.type === 'translation' && Array.isArray(packet.parameters)) {
        textContent = packet.parameters.join(' ');
      }
      const cleaned = cleanMcText(textContent);
      if (cleaned) {
        const isChat = packet.type === 'chat' || packet.type === 'whisper';
        this.addLog(cleaned, isChat ? 'chat' : 'info');
      }
    });

    client.on('kick', (reason) => {
      const cleanReason = cleanMcText(typeof reason === 'object' ? JSON.stringify(reason) : String(reason));
      this.addLog(`Dikeluarkan dari server Bedrock: ${cleanReason}`, 'warning');
      this.updateStatus('offline', 'Dikeluarkan');
    });

    client.on('error', (err) => {
      this.addLog(`Eror koneksi Bedrock: ${err.message}`, 'error');
      this.updateStatus('error', err.message);
    });

    client.on('close', () => {
      this.addLog(`Koneksi terputus dari server Bedrock.`, 'warning');
      this.cleanup();
      this.updateStatus('offline', 'Terputus');
      this.scheduleReconnect();
    });
  }

  stop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.addLog('Menghentikan bot secara manual...', 'system');
    this.cleanup();
    this.updateStatus('offline', 'Dihentikan oleh pengguna');
  }

  scheduleReconnect() {
    if (!this.config.autoReconnect) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const delayMs = (this.config.reconnectDelay || 10) * 1000;
    this.addLog(`Auto-reconnect aktif. Mencoba menghubungkan kembali dalam ${this.config.reconnectDelay} detik...`, 'system');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.status === 'offline' || this.status === 'error') {
        this.start();
      }
    }, delayMs);
  }

  sendChat(message) {
    if (this.status !== 'online') {
      this.addLog(`Gagal mengirim: Bot (${this.config.username}) sedang offline!`, 'error');
      return;
    }
    try {
      if (this.config.platform === 'bedrock' && this.bedrockClient) {
        if (typeof this.bedrockClient.chat === 'function') {
          this.bedrockClient.chat(message);
        } else {
          this.bedrockClient.queue('text', {
            type: 'chat',
            needs_translation: false,
            source_name: this.config.username,
            xuid: '',
            platform_chat_id: '',
            message: message
          });
        }
      } else if (this.bot) {
        this.bot.chat(message);
      }
      this.addLog(`[DIKIRIM] ${message}`, 'mychat');
    } catch (err) {
      this.addLog(`Gagal mengirim chat: ${err.message}`, 'error');
    }
  }

  clickGuiSlot(slotIndex) {
    if (!this.bot || !this.bot.currentWindow) return;
    try {
      this.bot.clickWindow(slotIndex, 0, 0);
      this.addLog(`Klik slot GUI #${slotIndex}`, 'system');
    } catch (e) {
      this.addLog(`Gagal klik GUI slot: ${e.message}`, 'error');
    }
  }

  // Full spatial data (used for the snapshot a browser gets when it switches live data on)
  getSpatialPayload() {
    return {
      botId: this.config.id,
      position: this.position,
      scoreboard: this.scoreboard,
      inventory: this.inventory,
      entities: this.nearbyEntities
    };
  }

  // Runs a command taken from a clickable chat message (same as clicking it in the game)
  runChatCommand(command) {
    if (this.config.platform === 'bedrock') {
      this.addLog('Klik pesan chat belum didukung untuk akun Bedrock.', 'warning');
      return;
    }
    if (this.status !== 'online' || !this.bot) {
      this.addLog(`Gagal menjalankan perintah: Bot (${this.config.username}) sedang offline!`, 'error');
      return;
    }
    const cmd = typeof command === 'string' ? command.trim() : '';
    if (!cmd.startsWith('/') || cmd.length > 200 || /[\r\n]/.test(cmd)) return;
    try {
      this.bot.chat(cmd);
      this.addLog(`[KLIK CHAT] ${cmd}`, 'mychat');
    } catch (err) {
      this.addLog(`Gagal menjalankan ${cmd}: ${err.message}`, 'error');
    }
  }

  // Re-read the scoreboard and log (once per change) where the data comes from, to help debugging
  refreshScoreboard() {
    if (!this.bot) return;
    const sb = extractScoreboard(this.bot);
    this.scoreboard = sb;
    const sig = `${sb.source}|${sb.title}|${sb.items.length > 0}`;
    if (sig !== this._scoreboardSig) {
      this._scoreboardSig = sig;
      const objectives = Object.keys(this.bot.scoreboards || {}).join(', ') || '-';
      const sidebar = findSidebarObjective(this.bot);
      this.addLog(`[SCOREBOARD] sumber=${sb.source} | judul="${sb.title}" | ${sb.items.length} baris | sidebar=${sidebar ? sidebar.name : '-'} | objective: ${objectives}`, 'system');
    }
  }

  // Resolves true when the bot emits `eventName`, or false after `ms` milliseconds.
  waitBotEvent(bot, eventName, ms) {
    return new Promise((resolve) => {
      let timer = null;
      const onEvent = () => { clearTimeout(timer); resolve(true); };
      timer = setTimeout(() => { bot.removeListener(eventName, onEvent); resolve(false); }, Math.max(0, ms));
      bot.once(eventName, onEvent);
    });
  }

  // Right-click an item from the inventory panel (e.g. a speed booster).
  // The item is moved/selected into the held slot, used with a right click, then everything
  // is put back so tools the bot relies on (pickaxe, rod, ...) stay where they were.
  async useInventoryItem(slot) {
    if (this.config.platform === 'bedrock') {
      this.addLog('Klik kanan item belum didukung untuk akun Bedrock.', 'warning');
      return;
    }
    if (this.status !== 'online' || !this.bot) {
      this.addLog(`Gagal klik kanan: Bot (${this.config.username}) sedang offline!`, 'error');
      return;
    }
    if (this.itemUseBusy) return;
    if (this.bot.currentWindow) {
      this.addLog('Gagal klik kanan: tutup GUI/container yang sedang terbuka dulu.', 'warning');
      return;
    }
    // 9-35 = inventory utama, 36-44 = hotbar
    if (!Number.isInteger(slot) || slot < 9 || slot > 44) return;

    const bot = this.bot;
    const item = bot.inventory.slots[slot];
    if (!item) {
      this.addLog(`Slot #${slot} kosong.`, 'warning');
      return;
    }

    this.itemUseBusy = true;
    const label = cleanMcText(item.displayName || item.name) || item.name;
    const prevQuick = bot.quickBarSlot;
    const heldSlot = 36 + prevQuick;
    let swapped = false;

    try {
      if (slot >= 36) {
        bot.setQuickBarSlot(slot - 36);
      } else {
        await bot.moveSlotItem(slot, heldSlot);
        swapped = true;
      }
      await sleep(250);

      // Register the listener first so a fast server response is not missed
      const guiOpening = this.waitBotEvent(bot, 'windowOpen', 1500);
      bot.activateItem();
      this.addLog(`[KLIK KANAN] ${label} (slot #${slot})`, 'mychat');

      // Some items (e.g. pet food) open a menu. The item must stay in hand while that menu is
      // open, because the server reads the held item when a slot in the menu is clicked.
      // Everything is put back only after the menu has been closed.
      let guiOpened = await guiOpening;
      if (guiOpened) {
        this.addLog(`GUI terbuka. ${label} tetap dipegang sampai GUI ditutup (pilih slot di GUI dengan klik kiri).`, 'system');
        const deadline = Date.now() + ITEM_GUI_MAX_WAIT_MS;
        while (guiOpened && Date.now() < deadline) {
          if (bot.currentWindow) await this.waitBotEvent(bot, 'windowClose', deadline - Date.now());
          // some menus close and immediately open a follow-up menu
          guiOpened = await this.waitBotEvent(bot, 'windowOpen', 800);
        }
        if (bot.currentWindow) {
          try { bot.closeWindow(bot.currentWindow); } catch (e) { }
          this.addLog('GUI ditutup otomatis karena terlalu lama tidak dipakai.', 'warning');
        }
        await sleep(400);
      } else {
        await sleep(400);
      }
    } catch (err) {
      this.addLog(`Gagal klik kanan ${label}: ${err.message}`, 'error');
    } finally {
      try {
        if (swapped) await bot.moveSlotItem(slot, heldSlot);
        if (bot.quickBarSlot !== prevQuick) bot.setQuickBarSlot(prevQuick);
      } catch (err) {
        this.addLog(`Gagal mengembalikan item ke slot semula: ${err.message}`, 'error');
      }
      this.itemUseBusy = false;
    }
  }

  closeGui() {
    if (!this.bot || !this.bot.currentWindow) return;
    try {
      this.bot.closeWindow(this.bot.currentWindow);
      this.activeGuiWindow = null;
      this.addLog(`GUI Window ditutup oleh pengguna.`, 'system');
      io.emit('bot-gui-close', { botId: this.config.id });
    } catch (e) {
      this.addLog(`Gagal menutup GUI Window: ${e.message}`, 'error');
    }
  }

  getState() {
    return {
      config: this.config,
      status: this.status,
      health: this.health,
      position: this.position,
      scoreboard: this.scoreboard,
      inventory: this.inventory,
      entities: this.nearbyEntities,
      activeGui: this.activeGuiWindow,
      logs: this.logHistory
    };
  }
}

// Map of Bot Instances
const botInstances = {};
accounts.forEach(acc => {
  botInstances[acc.id] = new BotManager(acc);
});

// Security Configuration Management
const SECURITY_FILE = path.join(__dirname, 'security_config.json');
let securityConfig = {
  enabled: true,
  password: process.env.DASHBOARD_PASSWORD || 'admin123'
};

function loadSecurityConfig() {
  try {
    if (fs.existsSync(SECURITY_FILE)) {
      const data = JSON.parse(fs.readFileSync(SECURITY_FILE, 'utf8'));
      securityConfig = { ...securityConfig, ...data };
    }
  } catch (err) {
    console.error('Gagal membaca security_config.json:', err.message);
  }
}

function saveSecurityConfig() {
  try {
    fs.writeFileSync(SECURITY_FILE, JSON.stringify(securityConfig, null, 2), 'utf8');
  } catch (err) {
    console.error('Gagal menyimpan security_config.json:', err.message);
  }
}
loadSecurityConfig();

const activeTokens = new Set();

// Middleware & Static Files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/accounts', (req, res) => {
  const summary = Object.values(botInstances).map(b => b.getState());
  res.json(summary);
});

// WebSocket Handlers
io.on('connection', (socket) => {
  socket.emit('quick-commands', quickCommands);
  socket.on('update-quick-commands', (list) => {
    quickCommands = sanitizeQuickCommands(list);
    try {
      fs.writeFileSync(QUICK_FILE, JSON.stringify(quickCommands, null, 2));
    } catch (err) {
      console.error('Gagal menyimpan quick_commands.json:', err.message);
    }
    io.emit('quick-commands', quickCommands);
  });
  // If security is disabled, send init-multi directly once
  if (!securityConfig.enabled) {
    socket.emit('auth-status', { authenticated: true, securityEnabled: false });
    socket.emit('init-multi', Object.values(botInstances).map(b => b.getState()));
  } else {
    socket.emit('auth-status', { authenticated: false, securityEnabled: true });
  }

  socket.on('check-auth', (token) => {
    if (!securityConfig.enabled || (token && activeTokens.has(token))) {
      socket.emit('auth-status', { authenticated: true, securityEnabled: securityConfig.enabled });
      socket.emit('init-multi', Object.values(botInstances).map(b => b.getState()));
    } else {
      socket.emit('auth-status', { authenticated: false, securityEnabled: true });
    }
  });

  socket.on('verify-password', (payload) => {
    const pwd = payload ? payload.password : '';
    if (!securityConfig.enabled || pwd === securityConfig.password) {
      const token = 'tok_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
      activeTokens.add(token);
      socket.emit('auth-success', { token, securityEnabled: securityConfig.enabled });
      socket.emit('init-multi', Object.values(botInstances).map(b => b.getState()));
    } else {
      socket.emit('auth-failed', { message: 'Kata sandi dashboard salah!' });
    }
  });

  socket.on('lock-session', (token) => {
    if (token) activeTokens.delete(token);
    socket.emit('auth-status', { authenticated: false, securityEnabled: securityConfig.enabled });
  });

  socket.on('update-security-config', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (typeof payload.enabled === 'boolean') {
      securityConfig.enabled = payload.enabled;
    }
    if (typeof payload.password === 'string' && payload.password.trim().length > 0) {
      securityConfig.password = payload.password.trim();
    }
    saveSecurityConfig();
    io.emit('security-config-updated', { enabled: securityConfig.enabled });
  });

  // Bot control handlers
  socket.on('start-bot', (botId) => {
    const bot = getBot(botId);
    if (bot) bot.start();
  });

  socket.on('stop-bot', (botId) => {
    const bot = getBot(botId);
    if (bot) bot.stop();
  });

  socket.on('start-all-bots', () => {
    Object.values(botInstances).forEach(b => b.start());
  });

  socket.on('stop-all-bots', () => {
    Object.values(botInstances).forEach(b => b.stop());
  });

  socket.on('send-chat', (payload) => {
    const { botId, message } = payload || {};
    const bot = getBot(botId);
    if (bot && typeof message === 'string' && message.trim()) bot.sendChat(message);
  });

  socket.on('click-gui-slot', (payload) => {
    const { botId, slot } = payload || {};
    const bot = getBot(botId);
    if (bot && Number.isInteger(slot) && slot >= 0) bot.clickGuiSlot(slot);
  });

  // Live data switch: only browsers in the "live" room receive position/inventory/scoreboard updates
  const sendSnapshot = () => {
    Object.values(botInstances).forEach(b => socket.emit('bot-spatial-update', b.getSpatialPayload()));
  };
  socket.on('set-live', (enabled) => {
    if (enabled) {
      socket.join('live');
      sendSnapshot();
    } else {
      socket.leave('live');
    }
  });
  socket.on('request-snapshot', sendSnapshot);

  socket.on('run-chat-command', (payload) => {
    const { botId, command } = payload || {};
    const bot = getBot(botId);
    if (bot) bot.runChatCommand(command);
  });

  socket.on('use-item', (payload) => {
    const { botId, slot } = payload || {};
    const bot = getBot(botId);
    if (bot && Number.isInteger(slot)) bot.useInventoryItem(slot);
  });

  socket.on('close-gui-modal', (botId) => {
    const bot = getBot(botId);
    if (bot) bot.closeGui();
  });

  socket.on('update-bot-config', (payload) => {
    const { botId, newConfig } = payload || {};
    const bot = getBot(botId);
    if (bot && newConfig && typeof newConfig === 'object' && !Array.isArray(newConfig)) {
      bot.config = { ...bot.config, ...newConfig };
      saveAccounts();
      io.emit('bot-config-updated', { botId, config: bot.config });
    }
  });

  socket.on('add-account', (newAccData) => {
    try {
      if (!newAccData || typeof newAccData !== 'object') return;

      const platform = String(newAccData.platform || 'java').toLowerCase();
      const type = String(newAccData.type || 'cracked').toLowerCase();
      const rawUsername = String(newAccData.username || '').trim();
      const password = String(newAccData.password || '').trim();
      const host = String(newAccData.host || 'alwination.id').trim();
      const defaultPort = platform === 'bedrock' ? 19132 : 25565;
      const port = parseInt(newAccData.port || defaultPort);
      const version = String(newAccData.version || 'auto');

      if (!rawUsername) {
        socket.emit('account-error', { message: 'Username / Email tidak boleh kosong!' });
        return;
      }

      if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host)) {
        socket.emit('account-error', { message: 'Host server tidak valid!' });
        return;
      }

      if (isNaN(port) || port < 1 || port > 65535) {
        socket.emit('account-error', { message: 'Port harus berupa angka 1-65535!' });
        return;
      }

      // Generate clean unique ID
      const safeId = rawUsername.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      let botId = safeId;
      if (botInstances[botId]) {
        botId = `${safeId}_${Date.now().toString(36)}`;
      }

      // Calculate next available viewer port
      const existingPorts = Object.values(botInstances).map(b => b.config.viewerPort || 3000);
      let nextViewerPort = 3001;
      while (existingPorts.includes(nextViewerPort)) {
        nextViewerPort++;
      }

      const targetServer = String(newAccData.targetServer || '').trim();
      const nextCmdRaw = String(newAccData.nextCmd || '').trim();

      const autoCmdsList = [];
      if (type === 'cracked') {
        autoCmdsList.push({ cmd: `/login ${password || '{password}'}`, delaySec: 2 });
      }
      if (targetServer) {
        const cleanServer = targetServer.replace(/^\/server\s+/, '').replace(/^\//, '');
        autoCmdsList.push({ cmd: `/server ${cleanServer}`, delaySec: 2 });
      }
      if (nextCmdRaw) {
        const cleanNext = nextCmdRaw.startsWith('/') ? nextCmdRaw : '/' + nextCmdRaw;
        autoCmdsList.push({ cmd: cleanNext, delaySec: 2 });
      }

      if (autoCmdsList.length === 0) {
        if (type === 'cracked') autoCmdsList.push({ cmd: `/login ${password || '{password}'}`, delaySec: 2 });
        autoCmdsList.push({ cmd: '/server tycoon', delaySec: 2 });
        autoCmdsList.push({ cmd: '/is', delaySec: 2 });
      }

      const scriptLines = [];
      autoCmdsList.forEach((row, idx) => {
        if (idx > 0) scriptLines.push(`wait ${(row.delaySec || 2) * 20}`);
        let c = row.cmd;
        if (!c.toLowerCase().startsWith('send ')) {
          if (!c.startsWith('/')) c = '/' + c;
          c = 'send ' + c;
        }
        scriptLines.push(c);
      });

      const newConfig = {
        id: botId,
        username: rawUsername,
        password: password,
        platform: platform,
        type: type,
        auth: type === 'premium' ? 'microsoft' : 'offline',
        host: host || 'alwination.id',
        port: isNaN(port) ? defaultPort : port,
        viewerPort: nextViewerPort,
        version: version,
        autoReconnect: true,
        reconnectDelay: 10,
        scriptEnabled: true,
        autoCmds: autoCmdsList,
        scriptText: scriptLines.join('\n')
      };

      const newBot = new BotManager(newConfig);
      botInstances[botId] = newBot;
      saveAccounts();

      io.emit('account-added', newBot.getState());
    } catch (err) {
      console.error('Error adding account:', err);
      socket.emit('account-error', { message: `Gagal menambah akun: ${err.message}` });
    }
  });

  socket.on('remove-account', (botId) => {
    const bot = getBot(botId);
    if (bot) {
      bot.stop();
      delete botInstances[botId];
      saveAccounts();
      io.emit('account-removed', { botId });
    }
  });
});

// Auto Proxy Reset Schedule (Pagi 05:55 WIB Stop -> 06:15 WIB Start)
let lastProxyResetAction = null;

setInterval(() => {
  // Compute current WIB time (UTC+7)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const wibTime = new Date(utc + (3600000 * 7));

  const hours = wibTime.getHours();
  const minutes = wibTime.getMinutes();
  const dateStr = wibTime.toISOString().split('T')[0];

  // At 05:58 WIB -> Disconnect all bots for proxy reset (7 min pause)
  if (hours === 5 && minutes === 58) {
    const actionKey = `STOP_${dateStr}`;
    if (lastProxyResetAction !== actionKey) {
      lastProxyResetAction = actionKey;
      console.log(`[SCHEDULE PROXY RESET] Jam 05:58 WIB: Mematikan seluruh bot (Jeda 7 Menit Reset Proxy Server Alwi)...`);
      Object.values(botInstances).forEach(bot => {
        bot.addLog('===========================================================', 'warning');
        bot.addLog('[SCHEDULE RESET PROXY] Mematikan bot jam 05:58 WIB (Reset Proxy Server Alwi)...', 'warning');
        bot.addLog('[SCHEDULE RESET PROXY] Bot akan otomatis login kembali jam 06:05 WIB (Jeda 7 menit).', 'info');
        bot.addLog('===========================================================', 'warning');
        bot.stop();
      });
      io.emit('schedule-notify', { message: '⚡ [05:58 WIB] Seluruh bot dimatikan otomatis untuk jeda Reset Proxy Server Alwi (7 menit).' });
    }
  }

  // At 06:05 WIB -> Reconnect all bots automatically
  if (hours === 6 && minutes === 5) {
    const actionKey = `START_${dateStr}`;
    if (lastProxyResetAction !== actionKey) {
      lastProxyResetAction = actionKey;
      console.log(`[SCHEDULE PROXY RESET] Jam 06:05 WIB: Reset proxy selesai, menyalakan kembali seluruh bot...`);
      Object.values(botInstances).forEach(bot => {
        bot.addLog('===========================================================', 'success');
        bot.addLog('[SCHEDULE RESET PROXY] Jam 06:05 WIB: Reset proxy selesai! Menyalakan kembali bot...', 'success');
        bot.addLog('===========================================================', 'success');
        bot.start();
      });
      io.emit('schedule-notify', { message: '🚀 [06:05 WIB] Reset proxy selesai. Seluruh bot otomatis dinyalakan kembali!' });
    }
  }
}, 20000);

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Minecraft Multi-AFK Server + Scoreboard & 3D Viewer`);
  console.log(` Port: ${PORT} | Total Akun: ${Object.keys(botInstances).length}`);
  console.log(` Akses Dashboard Web: http://localhost:${PORT}`);
  console.log(`====================================================`);
});

// Global Anti-Crash Protection for Uncaught Socket Errors
process.on('uncaughtException', (err) => {
  console.error('[ANTI-CRASH] Uncaught Exception ditangkap aman:', err.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[ANTI-CRASH] Unhandled Rejection ditangkap aman:', reason);
});
