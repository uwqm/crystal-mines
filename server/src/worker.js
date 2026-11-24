// Crystal Mines — Cloudflare Worker: игровой сервер, таблица лидеров, админка и Telegram-бот (webhook).
// Секреты: BOT_TOKEN, WEBHOOK_SECRET. Переменные: WEBAPP_URL, ADMINS ("id1,id2"). База: D1 (binding DB).

const SIZE = 25, EDGE = 0.97, MIN_BET = 10, MAX_BET = 1_000_000, MAX_WIN = 100_000_000;
const DAY_REWARDS = [100, 150, 200, 300, 400, 600, 1000];
const SPIN_CD = 4 * 3600 * 1000;
const SEG = [50, 300, 100, 1000, 75, 500, 150, 2500];
const WEIGHTS = [30, 12, 24, 4, 26, 7, 18, 1];

const DAILY = [
  { id: "play", goal: 5, r: 150 }, { id: "gems", goal: 25, r: 200 }, { id: "cash2", goal: 1, r: 250 },
  { id: "hard", goal: 1, r: 300 }, { id: "row5", goal: 3, r: 200 }, { id: "wins", goal: 3, r: 200 },
];
const ACH = [
  { id: "first", goal: 1, r: 100, v: s => s.stats.wins },
  { id: "g100", goal: 100, r: 500, v: s => s.stats.gems },
  { id: "g1000", goal: 1000, r: 3000, v: s => s.stats.gems },
  { id: "r50", goal: 50, r: 800, v: s => s.stats.games },
  { id: "x5", goal: 5, r: 700, v: s => s.stats.bestMult },
  { id: "x25", goal: 25, r: 4000, v: s => s.stats.bestMult },
  { id: "lv5", goal: 5, r: 1000, v: s => s.level },
  { id: "lv10", goal: 10, r: 5000, v: s => s.level },
  { id: "streak7", goal: 7, r: 2000, v: s => s.bonus.streak },
];

// ---------- helpers ----------
const comb = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };
const multFor = (t, o) => o === 0 ? 1 : Math.floor(EDGE * comb(SIZE, o) / comb(SIZE - t, o) * 100) / 100;
const xpNeed = lv => 100 + (lv - 1) * 60;
const rnd = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
// "день" считаем по Москве (UTC+3)
const dayKey = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
const isAdmin = (env, id) => String(env.ADMINS || "").split(",").map(s => s.trim()).includes(String(id));

const DEFAULT = () => ({
  balance: 1000, xp: 0, level: 1, sound: true, traps: 3, bet: 10,
  stats: { games: 0, wins: 0, losses: 0, gems: 0, bestMult: 0, bestWin: 0, totalWon: 0, totalBet: 0 },
  daily: { date: "", p: {}, c: {} }, ach: {}, bonus: { last: "", streak: 0 },
  spinAt: 0, hist: [], game: null,
});

function cors(env, req) {
  const origin = req.headers.get("Origin") || "";
  const allowed = origin.endsWith(".github.io") || origin.startsWith("http://localhost") || origin === "null";
  return {
    "Access-Control-Allow-Origin": allowed ? origin || "*" : (env.WEBAPP_ORIGIN || "*"),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Init-Data",
    "Access-Control-Max-Age": "86400",
  };
}
const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

// ---------- Telegram initData validation ----------
async function hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
async function verifyInitData(initData, botToken) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash"); if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), botToken);
  if (hex(await hmac(secret, check)) !== hash) return null;
  const authDate = +p.get("auth_date") || 0;
  if (Date.now() / 1000 - authDate > 7 * 86400) return null; // старше недели — не принимаем
  try { return JSON.parse(p.get("user")); } catch { return null; }
}

// ---------- DB ----------
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT, name TEXT, state TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 1000, level INTEGER NOT NULL DEFAULT 1, xp INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS users_bal ON users(hidden, balance DESC)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS users_lvl ON users(hidden, level DESC, xp DESC)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS users_un ON users(username)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pending (chat_id INTEGER PRIMARY KEY, cmd TEXT, target TEXT, ts INTEGER)`),
  ]);
  schemaReady = true;
}
function mergeState(o) {
  const d = DEFAULT();
  return { ...d, ...o, stats: { ...d.stats, ...(o.stats || {}) }, daily: { ...d.daily, ...(o.daily || {}) }, bonus: { ...d.bonus, ...(o.bonus || {}) }, ach: o.ach || {}, hist: o.hist || [] };
}
async function getUser(env, id) {
  const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
  if (!row) return null;
  return { row, s: mergeState(JSON.parse(row.state)) };
}
async function loadOrCreate(env, tgUser) {
  const id = tgUser.id;
  const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ").slice(0, 64) || "Игрок";
  const username = tgUser.username ? tgUser.username.toLowerCase() : null;
  let u = await getUser(env, id);
  if (!u) {
    const s = DEFAULT();
    await env.DB.prepare("INSERT INTO users (id, username, name, state, balance, level, xp, hidden, updated) VALUES (?,?,?,?,?,?,?,0,?)")
      .bind(id, username, name, JSON.stringify(s), s.balance, s.level, s.xp, Date.now()).run();
    u = await getUser(env, id);
  } else if (u.row.name !== name || u.row.username !== username) {
    await env.DB.prepare("UPDATE users SET name=?, username=? WHERE id=?").bind(name, username, id).run();
    u.row.name = name; u.row.username = username;
  }
  return u;
}
async function saveUser(env, id, s) {
  await env.DB.prepare("UPDATE users SET state=?, balance=?, level=?, xp=?, updated=? WHERE id=?")
    .bind(JSON.stringify(s), Math.floor(s.balance), s.level, s.xp, Date.now(), id).run();
}
async function findTarget(env, target) {
  target = String(target || "").trim().replace(/^@/, "");
  if (!target) return null;
  if (/^\d+$/.test(target)) return env.DB.prepare("SELECT * FROM users WHERE id=?").bind(+target).first();
  return env.DB.prepare("SELECT * FROM users WHERE username=?").bind(target.toLowerCase()).first();
}

// ---------- game logic ----------
function checkDaily(s) { const t = dayKey(); if (s.daily.date !== t) s.daily = { date: t, p: {}, c: {} }; }
function addProg(s, id, n = 1, ev) {
  checkDaily(s);
  const m = DAILY.find(x => x.id === id); if (!m) return;
  const before = s.daily.p[id] || 0;
  s.daily.p[id] = Math.min(m.goal, before + n);
  if (before < m.goal && s.daily.p[id] >= m.goal) ev.push({ t: "mission", id });
}
function addXp(s, n, ev) {
  s.xp += n;
  while (s.xp >= xpNeed(s.level)) {
    s.xp -= xpNeed(s.level); s.level++;
    const r = 150 * s.level; s.balance += r;
    ev.push({ t: "level", level: s.level, reward: r });
  }
}
function bonusState(s) {
  const t = dayKey(), y = dayKey(Date.now() - 86400e3);
  const claimedToday = s.bonus.last === t;
  let streak = s.bonus.streak;
  if (!claimedToday && s.bonus.last !== y) streak = 0;
  return { claimedToday, streak };
}
function finishRound(s, won, win, m, ev) {
  const g = s.game, opened = g.open.length;
  s.stats.games++; addProg(s, "play", 1, ev);
  if (won) {
    s.stats.wins++; s.stats.totalWon += win; addProg(s, "wins", 1, ev);
    s.stats.bestMult = Math.max(s.stats.bestMult, m); s.stats.bestWin = Math.max(s.stats.bestWin, win);
    if (m >= 2) addProg(s, "cash2", 1, ev);
    if (g.traps >= 7) addProg(s, "hard", 1, ev);
  } else s.stats.losses++;
  addXp(s, 5 + opened * 2 + (won ? g.traps : 0), ev);
  s.hist.unshift({ w: won, b: g.bet, m, win, t: g.traps });
  s.hist = s.hist.slice(0, 15);
  const reveal = { mines: g.mines, open: g.open };
  s.game = null;
  return reveal;
}

const ACTIONS = {
  state() { return {}; },
  settings(s, b) {
    if (typeof b.sound === "boolean") s.sound = b.sound;
    if (Number.isFinite(b.traps)) s.traps = Math.max(1, Math.min(24, Math.floor(b.traps)));
    if (Number.isFinite(b.bet)) s.bet = Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(b.bet)));
    return {};
  },
  start(s, b) {
    if (s.game) throw new Error("Раунд уже идёт");
    const traps = Math.max(1, Math.min(24, Math.floor(+b.traps || s.traps)));
    const bet = Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(+b.bet || s.bet)));
    if (bet > s.balance) throw new Error("Недостаточно кристаллов");
    const mines = new Set(); while (mines.size < traps) mines.add(rnd(SIZE));
    s.balance -= bet; s.stats.totalBet += bet; s.traps = traps; s.bet = bet;
    s.game = { mines: [...mines], open: [], bet, traps };
    return {};
  },
  reveal(s, b, ev) {
    const g = s.game; if (!g) throw new Error("Нет активного раунда");
    const i = Math.floor(+b.i);
    if (!(i >= 0 && i < SIZE) || g.open.includes(i)) throw new Error("Неверная клетка");
    if (g.mines.includes(i)) { const rv = finishRound(s, false, 0, 0, ev); return { result: "boom", hit: i, reveal: rv }; }
    g.open.push(i); s.stats.gems++; addProg(s, "gems", 1, ev);
    if (g.open.length === 5) addProg(s, "row5", 1, ev);
    if (g.open.length === SIZE - g.traps) return { result: "gem", i, ...ACTIONS.cashout(s, b, ev) };
    return { result: "gem", i };
  },
  cashout(s, b, ev) {
    const g = s.game; if (!g || !g.open.length) throw new Error("Нечего забирать");
    const m = multFor(g.traps, g.open.length), win = Math.min(MAX_WIN, Math.floor(g.bet * m));
    s.balance += win;
    const traps = g.traps;
    const rv = finishRound(s, true, win, m, ev);
    return { cashed: { win, m, traps }, reveal: rv };
  },
  claimDaily(s, b, ev) {
    checkDaily(s);
    const m = DAILY.find(x => x.id === b.id); if (!m) throw new Error("Нет такой миссии");
    if ((s.daily.p[m.id] || 0) < m.goal || s.daily.c[m.id]) throw new Error("Пока нельзя забрать");
    s.daily.c[m.id] = true; s.balance += m.r; addXp(s, 20, ev);
    return { reward: m.r };
  },
  claimAch(s, b) {
    const a = ACH.find(x => x.id === b.id); if (!a) throw new Error("Нет такого достижения");
    if (a.v(s) < a.goal || s.ach[a.id]) throw new Error("Пока нельзя забрать");
    s.ach[a.id] = true; s.balance += a.r;
    return { reward: a.r };
  },
  bonus(s, b, ev) {
    const st = bonusState(s); if (st.claimedToday) throw new Error("Уже забрано сегодня");
    const streak = st.streak + 1, r = DAY_REWARDS[(streak - 1) % 7];
    s.bonus = { last: dayKey(), streak }; s.balance += r; addXp(s, 10, ev);
    return { reward: r, streak };
  },
  spin(s) {
    if (Date.now() < s.spinAt) throw new Error("Колесо ещё не готово");
    const total = WEIGHTS.reduce((a, c) => a + c, 0);
    let r = Math.random() * total, idx = 0;
    for (; idx < WEIGHTS.length; idx++) { r -= WEIGHTS[idx]; if (r < 0) break; }
    idx = Math.min(idx, SEG.length - 1);
    s.spinAt = Date.now() + SPIN_CD; s.balance += SEG[idx];
    return { idx, reward: SEG[idx] };
  },
  refill(s) {
    if (s.balance >= MIN_BET || s.game) throw new Error("Доступно при балансе меньше 10");
    s.balance += 500; return { reward: 500 };
  },
};

// what the client is allowed to see
function publicState(s, row, env) {
  const out = { ...s };
  if (s.game) out.game = { open: s.game.open, bet: s.game.bet, traps: s.game.traps };
  out.bonusState = bonusState(s);
  out.dayKey = dayKey();
  out.serverNow = Date.now();
  out.me = { id: row.id, name: row.name, username: row.username, admin: isAdmin(env, row.id), hidden: !!row.hidden };
  return out;
}

async function leaderboard(env, by, meId) {
  const order = by === "level" ? "level DESC, xp DESC" : "balance DESC";
  const { results } = await env.DB.prepare(`SELECT id, name, username, balance, level, xp FROM users WHERE hidden=0 ORDER BY ${order}, id LIMIT 50`).all();
  const list = results.map((r, i) => ({ place: i + 1, id: r.id, name: r.name, username: r.username, balance: r.balance, level: r.level, admin: isAdmin(env, r.id), me: r.id === meId }));
  let mine = null;
  if (meId && !list.some(x => x.me)) {
    const me = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(meId).first();
    if (me && !me.hidden) {
      const q = by === "level"
        ? env.DB.prepare("SELECT COUNT(*) c FROM users WHERE hidden=0 AND (level>? OR (level=? AND xp>?))").bind(me.level, me.level, me.xp)
        : env.DB.prepare("SELECT COUNT(*) c FROM users WHERE hidden=0 AND balance>?").bind(me.balance);
      const c = (await q.first()).c;
      mine = { place: c + 1, id: me.id, name: me.name, username: me.username, balance: me.balance, level: me.level, admin: isAdmin(env, me.id), me: true };
    }
  }
  return { by, list, mine };
}

// ---------- admin ----------
async function adminApply(env, adminId, act) {
  if (!isAdmin(env, adminId)) throw new Error("Нет прав администратора");
  const row = await findTarget(env, act.target);
  if (!row) throw new Error("Игрок не найден. Он должен хотя бы раз открыть игру.");
  const s = mergeState(JSON.parse(row.state));
  const msg = [];
  if (act.crystals) {
    const n = Math.trunc(+act.crystals); if (!Number.isFinite(n)) throw new Error("Неверное число");
    s.balance = Math.max(0, s.balance + n); msg.push(`${n >= 0 ? "+" : ""}${n} 💎`);
  }
  if (act.levels) {
    const n = Math.trunc(+act.levels); if (!Number.isFinite(n)) throw new Error("Неверное число");
    s.level = Math.max(1, Math.min(1000, s.level + n)); s.xp = 0; msg.push(`${n >= 0 ? "+" : ""}${n} ур. (теперь ${s.level})`);
  }
  if (act.crystals || act.levels) await saveUser(env, row.id, s);
  if (typeof act.hidden === "boolean") {
    await env.DB.prepare("UPDATE users SET hidden=? WHERE id=?").bind(act.hidden ? 1 : 0, row.id).run();
    msg.push(act.hidden ? "скрыт из таблиц лидеров" : "снова в таблицах лидеров");
  }
  const who = row.username ? `@${row.username}` : `${row.name} (${row.id})`;
  return { ok: true, text: `${who}: ${msg.join(", ") || "без изменений"}`, user: { id: row.id, name: row.name, username: row.username, balance: s.balance, level: s.level, hidden: typeof act.hidden === "boolean" ? act.hidden : !!row.hidden } };
}
async function adminFind(env, adminId, target) {
  if (!isAdmin(env, adminId)) throw new Error("Нет прав администратора");
  const row = await findTarget(env, target);
  if (!row) throw new Error("Игрок не найден");
  return { user: { id: row.id, name: row.name, username: row.username, balance: row.balance, level: row.level, hidden: !!row.hidden, admin: isAdmin(env, row.id) } };
}

// ---------- Telegram bot ----------
async function tg(env, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
  return r.json();
}
const playKb = env => ({ inline_keyboard: [[{ text: "💎 Играть", web_app: { url: env.WEBAPP_URL } }]] });
const esc = t => String(t).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function onUpdate(env, upd) {
  const msg = upd.message; if (!msg || !msg.text) return;
  const chat = msg.chat.id, from = msg.from || {}, text = msg.text.trim();
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.split("@")[0].toLowerCase();
  const send = (t, extra = {}) => tg(env, "sendMessage", { chat_id: chat, text: t, parse_mode: "HTML", ...extra });

  if (cmd === "/start" || cmd === "/play") {
    return send(`Привет, <b>${esc(from.first_name || "шахтёр")}</b>! 💎\n\n<b>Crystal Mines</b> — открывай плитки, собирай кристаллы и не попадись в ловушку.\n\n🎯 Миссии и достижения\n🎁 Награда за вход и колесо удачи\n🏆 Таблица лидеров\n⭐ Уровни и статистика\n\nЖми кнопку ниже, чтобы начать!`, { reply_markup: playKb(env) });
  }
  if (cmd === "/help") {
    let t = "Выбери ставку и количество ловушек, нажми «Играть» и открывай плитки. Каждый кристалл увеличивает множитель — забери выигрыш до того, как попадёшь в ловушку.\n\n/top — лидеры по кристаллам\n/toplevel — лидеры по уровню";
    if (isAdmin(env, from.id)) t += "\n\n<b>Админ-команды</b> (вместо @ника можно ID):\n/give @ник 500 — выдать кристаллы (минус — забрать)\n/level @ник 2 — добавить уровни\n/hide @ник — скрыть из таблиц лидеров\n/unhide @ник — вернуть в таблицы\n/info @ник — данные игрока";
    return send(t, { reply_markup: playKb(env) });
  }
  if (cmd === "/top" || cmd === "/toplevel") {
    const lb = await leaderboard(env, cmd === "/toplevel" ? "level" : "balance", from.id);
    const medal = p => ["🥇", "🥈", "🥉"][p - 1] || `${p}.`;
    const line = r => `${medal(r.place)} ${esc(r.name)}${r.admin ? " <i>admin</i>" : ""} — ${cmd === "/toplevel" ? `ур. ${r.level}` : `${r.balance.toLocaleString("ru-RU")} 💎`}`;
    let t = `🏆 <b>${cmd === "/toplevel" ? "Лидеры по уровню" : "Лидеры по кристаллам"}</b>\n\n` + (lb.list.slice(0, 10).map(line).join("\n") || "Пока пусто");
    if (lb.mine) t += `\n…\n${line(lb.mine)}`;
    return send(t, { reply_markup: playKb(env) });
  }
  const adminCmds = { "/give": "crystals", "/level": "levels", "/hide": "hide", "/unhide": "unhide", "/info": "info" };
  const needsAmount = c => c === "/give" || c === "/level";
  const admin = isAdmin(env, from.id);

  // пошаговый режим: /give → @ник → число (ответы запоминаются между сообщениями)
  let pending = admin ? await env.DB.prepare("SELECT cmd, target FROM pending WHERE chat_id=? AND ts>?").bind(chat, Date.now() - 10 * 60e3).first() : null;
  let useCmd = cmd, target, amount;
  const restNum = w => w.length ? w.join("") : undefined; // "500 000" -> "500000"
  if (adminCmds[cmd]) {
    target = args[0]; amount = restNum(args.slice(1));
  } else if (pending && !text.startsWith("/")) {
    useCmd = pending.cmd;
    const words = text.split(/\s+/);
    if (pending.target) { target = pending.target; amount = restNum(words); }
    else { target = words[0]; amount = restNum(words.slice(1)); }
  } else {
    if (pending && cmd === "/cancel") { await env.DB.prepare("DELETE FROM pending WHERE chat_id=?").bind(chat).run(); return send("Отменено."); }
    return;
  }
  if (adminCmds[useCmd]) {
    if (!admin) return send("Эта команда только для администраторов.");
    const ask = async (tgt, question) => {
      await env.DB.prepare("INSERT OR REPLACE INTO pending (chat_id, cmd, target, ts) VALUES (?,?,?,?)").bind(chat, useCmd, tgt || null, Date.now()).run();
      return send(question + "\n\n<i>/cancel — отменить</i>");
    };
    if (!target) return ask(null, "Укажи игрока: @ник или ID");
    if (needsAmount(useCmd) && (amount === undefined || amount === "")) {
      return ask(target, useCmd === "/give" ? `Сколько кристаллов выдать ${esc(target)}? (минус — забрать)` : `Сколько уровней добавить ${esc(target)}?`);
    }
    if (needsAmount(useCmd) && !Number.isFinite(+amount.replace(/[\s_]/g, ""))) return ask(target, "Нужно число, например 500000. Попробуй ещё раз:");
    if (amount !== undefined) amount = amount.replace(/[\s_]/g, "");
    await env.DB.prepare("DELETE FROM pending WHERE chat_id=?").bind(chat).run();
    const cmd2 = useCmd;
    try {
      const cmd = cmd2;
      if (cmd === "/info") {
        const { user: u } = await adminFind(env, from.id, target);
        return send(`👤 <b>${esc(u.name)}</b>${u.username ? ` @${esc(u.username)}` : ""}\nID: <code>${u.id}</code>\n💎 ${u.balance.toLocaleString("ru-RU")} · ур. ${u.level}${u.hidden ? "\n🙈 скрыт из таблиц" : ""}${u.admin ? "\n🛡 admin" : ""}`);
      }
      const act = { target };
      if (cmd === "/give") act.crystals = +amount;
      if (cmd === "/level") act.levels = +amount;
      if (cmd === "/hide") act.hidden = true;
      if (cmd === "/unhide") act.hidden = false;
      if ((cmd === "/give" || cmd === "/level") && !Number.isFinite(+amount)) return send(`Формат: ${cmd} @ник число`);
      const r = await adminApply(env, from.id, act);
      return send("✅ " + esc(r.text));
    } catch (e) { return send("⚠️ " + esc(e.message)); }
  }
}

// ---------- router ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const h = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });

    try {
      if (url.pathname === "/tg" && req.method === "POST") {
        if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
        await ensureSchema(env);
        const upd = await req.json();
        try { await onUpdate(env, upd); } catch (e) { console.log("update error", e && e.stack); }
        return new Response("ok");
      }

      if (url.pathname === "/setup") {
        // одноразовая настройка вебхука/кнопки: /setup?key=WEBHOOK_SECRET
        if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
        await ensureSchema(env);
        const base = `${url.protocol}//${url.host}`;
        const out = {};
        out.webhook = await tg(env, "setWebhook", { url: `${base}/tg`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message"], drop_pending_updates: true });
        out.menu = await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "Играть", web_app: { url: env.WEBAPP_URL } } });
        out.cmds = await tg(env, "setMyCommands", { commands: [
          { command: "start", description: "Начать" }, { command: "play", description: "Открыть игру" },
          { command: "top", description: "Лидеры по кристаллам" }, { command: "toplevel", description: "Лидеры по уровню" },
          { command: "help", description: "Помощь" }] });
        return json(out, 200, h);
      }

      if (url.pathname.startsWith("/api/")) {
        const tgUser = await verifyInitData(req.headers.get("X-Init-Data"), env.BOT_TOKEN);
        if (!tgUser) return json({ error: "Открой игру через Telegram-бота" }, 401, h);
        await ensureSchema(env);
        const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
        const route = url.pathname.slice(5);

        if (route === "leaderboard") return json(await leaderboard(env, url.searchParams.get("by") || body.by, tgUser.id), 200, h);
        if (route === "admin/find") return json(await adminFind(env, tgUser.id, body.target), 200, h);
        if (route === "admin/apply") {
          const r = await adminApply(env, tgUser.id, body);
          return json(r, 200, h);
        }

        const action = ACTIONS[route];
        if (!action) return json({ error: "not found" }, 404, h);
        const u = await loadOrCreate(env, tgUser);
        const s = u.s, ev = [];
        checkDaily(s);
        const res = action(s, body, ev);
        if (route !== "state") await saveUser(env, u.row.id, s);
        return json({ ...res, events: ev, state: publicState(s, u.row, env) }, 200, h);
      }

      if (url.pathname === "/") return new Response("Crystal Mines server OK");
      return new Response("not found", { status: 404 });
    } catch (e) {
      return json({ error: e.message || "Ошибка сервера" }, 400, h);
    }
  },
};
