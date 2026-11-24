(() => {
"use strict";
// Адрес игрового сервера (Cloudflare Worker)
const API = "https://crystal-mines.crystal-mines-game.workers.dev";

const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { try { tg.ready(); tg.expand(); tg.setHeaderColor && tg.setHeaderColor("#0b1020"); tg.setBackgroundColor && tg.setBackgroundColor("#0b1020");
  if (tg.isVersionAtLeast && tg.isVersionAtLeast("7.7") && tg.disableVerticalSwipes) tg.disableVerticalSwipes();
  if (tg.isVersionAtLeast && tg.isVersionAtLeast("7.10") && tg.setBottomBarColor) tg.setBottomBarColor("#0d1326");
} catch(e){} }
const INIT = (tg && tg.initData) || "";

function fitVh(){
  const h = (tg && tg.viewportStableHeight) || window.innerHeight;
  document.documentElement.style.setProperty("--vh", h + "px");
  const top = tg && tg.contentSafeAreaInset ? (tg.contentSafeAreaInset.top||0) + ((tg.safeAreaInset&&tg.safeAreaInset.top)||0) : 0;
  document.documentElement.style.setProperty("--tg-top", (tg && tg.isFullscreen ? top : 0) + "px");
}
fitVh(); window.addEventListener("resize", fitVh);
if (tg && tg.onEvent) ["viewportChanged","safeAreaChanged","contentSafeAreaChanged","fullscreenChanged"].forEach(ev => { try { tg.onEvent(ev, fitVh); } catch(e){} });
document.addEventListener("gesturestart", e => e.preventDefault());
document.addEventListener("dblclick", e => e.preventDefault(), {passive:false});

const $ = id => document.getElementById(id);
const SIZE = 25, EDGE = 0.97, MIN_BET = 10, MAX_BET = 1000000, MAX_WIN = 100000000;
const payout = (bet, m) => Math.min(MAX_WIN, Math.floor(bet * m));

const GEM = `<svg viewBox="0 0 64 64"><defs><linearGradient id="gg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b8f7ff"/><stop offset="1" stop-color="#1fb6d6"/></linearGradient></defs><polygon points="12,24 22,10 42,10 52,24 32,56" fill="url(#gg)"/><polygon points="12,24 52,24 32,56" fill="#22a9cc"/><polygon points="22,10 32,24 42,10" fill="#dffbff"/><polygon points="12,24 22,10 32,24" fill="#8eeeff"/><polygon points="32,24 42,10 52,24" fill="#5fd8f0"/><polygon points="22,24 32,56 12,24" fill="#3ec4e4" opacity=".7"/></svg>`;
const MINE = `<svg viewBox="0 0 64 64"><g stroke="#2a0f1e" stroke-width="5" stroke-linecap="round"><line x1="32" y1="6" x2="32" y2="58"/><line x1="6" y1="32" x2="58" y2="32"/><line x1="14" y1="14" x2="50" y2="50"/><line x1="50" y1="14" x2="14" y2="50"/></g><circle cx="32" cy="32" r="17" fill="#ff4d6d"/><circle cx="32" cy="32" r="17" fill="none" stroke="#2a0f1e" stroke-width="3"/><circle cx="26" cy="26" r="5" fill="#ffd0da"/></svg>`;
$("gemIco").innerHTML = GEM;

const fmt = n => Math.floor(n).toLocaleString("ru-RU");
const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const comb = (n,k) => { let r = 1; for (let i=0;i<k;i++) r = r*(n-i)/(i+1); return r; };
const multFor = (t, o) => o === 0 ? 1 : Math.floor(EDGE * comb(SIZE,o)/comb(SIZE-t,o) * 100) / 100;
const xpNeed = lv => 100 + (lv-1)*60;
const haptic = (t) => { try { if (!tg || !tg.HapticFeedback) return;
  if (t==="ok"||t==="err"||t==="warn") tg.HapticFeedback.notificationOccurred({ok:"success",err:"error",warn:"warning"}[t]);
  else tg.HapticFeedback.impactOccurred(t||"light"); } catch(e){} };

// ---------- sound ----------
let actx = null;
function beep(freq, dur=0.08, type="sine", vol=0.08, slide=0){
  if (!S || !S.sound) return;
  try {
    actx = actx || new (window.AudioContext||window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40,freq+slide), actx.currentTime+dur);
    g.gain.value = vol; g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime+dur);
    o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime+dur);
  } catch(e){}
}
const sfx = {
  gem: n => beep(520 + n*40, .12, "triangle", .07),
  boom: () => beep(160,.45,"sawtooth",.12,-120),
  cash: () => { beep(660,.1,"triangle"); setTimeout(()=>beep(880,.12,"triangle"),90); setTimeout(()=>beep(1180,.18,"triangle"),190); },
  click: () => beep(300,.04,"square",.03),
};

// ---------- missions (display only, rules live on the server) ----------
const DAILY = [
  {id:"play",  ic:"🎮", t:"Сыграй 5 раундов",              goal:5,  r:150},
  {id:"gems",  ic:"💎", t:"Открой 25 кристаллов",          goal:25, r:200},
  {id:"cash2", ic:"📈", t:"Забери выигрыш с множителем ×2+", goal:1, r:250},
  {id:"hard",  ic:"💀", t:"Выиграй раунд с 7+ ловушками",   goal:1,  r:300},
  {id:"row5",  ic:"🔥", t:"Открой 5 кристаллов за раунд 3 раза", goal:3, r:200},
  {id:"wins",  ic:"🏆", t:"Выиграй 3 раунда",               goal:3,  r:200},
];
const ACH = [
  {id:"first", ic:"🥇", t:"Первая победа",  d:"Выиграй любой раунд",          goal:1,    r:100,  v:s=>s.stats.wins},
  {id:"g100",  ic:"💎", t:"Шахтёр",         d:"Открой 100 кристаллов",        goal:100,  r:500,  v:s=>s.stats.gems},
  {id:"g1000", ic:"⛏️", t:"Мастер шахты",   d:"Открой 1000 кристаллов",       goal:1000, r:3000, v:s=>s.stats.gems},
  {id:"r50",   ic:"🎲", t:"Завсегдатай",    d:"Сыграй 50 раундов",            goal:50,   r:800,  v:s=>s.stats.games},
  {id:"x5",    ic:"🚀", t:"Рисковый",       d:"Забери выигрыш с ×5",          goal:5,    r:700,  v:s=>s.stats.bestMult},
  {id:"x25",   ic:"🌋", t:"Безумец",        d:"Забери выигрыш с ×25",         goal:25,   r:4000, v:s=>s.stats.bestMult},
  {id:"lv5",   ic:"⭐", t:"Опытный",        d:"Достигни 5 уровня",            goal:5,    r:1000, v:s=>s.level},
  {id:"lv10",  ic:"👑", t:"Легенда",        d:"Достигни 10 уровня",           goal:10,   r:5000, v:s=>s.level},
  {id:"streak7",ic:"📅",t:"Верность",       d:"Забери награду 7 дней подряд", goal:7,    r:2000, v:s=>s.bonus.streak},
];
const DAY_REWARDS = [100,150,200,300,400,600,1000];
const SEG = [{v:50,c:"#1f8fa3"},{v:300,c:"#2563eb"},{v:100,c:"#147a8e"},{v:1000,c:"#d97706"},{v:75,c:"#1f8fa3"},{v:500,c:"#7c3aed"},{v:150,c:"#147a8e"},{v:2500,c:"#dc2626"}];

// ---------- server ----------
let S = null;            // state from server
let clockSkew = 0;       // serverNow - Date.now()
let busy = false;
const now = () => Date.now() + clockSkew;

async function api(route, body, method = "POST") {
  const r = await fetch(API + "/api/" + route, {
    method, headers: { "Content-Type": "application/json", "X-Init-Data": INIT },
    body: method === "POST" ? JSON.stringify(body || {}) : undefined,
  });
  let data = {}; try { data = await r.json(); } catch(e){}
  if (r.status === 401) { $("gateMsg").textContent = data.error || "Сессия устарела — открой игру заново через бота."; $("gateBtn").style.display = ""; $("gate").classList.remove("off"); }
  if (!r.ok) throw new Error(data.error || ("Ошибка " + r.status));
  if (data.state) {
    // ставка/ловушки/звук — это выбор игрока на экране; ответ сервера не должен его перетирать
    const keep = S && route !== "start" ? { traps: S.traps, bet: S.bet, sound: S.sound } : null;
    S = data.state; clockSkew = S.serverNow - Date.now();
    if (keep && !S.game) Object.assign(S, keep);
  }
  if (data.events) data.events.forEach(onEvent);
  return data;
}
async function act(route, body) {
  if (busy) return null;
  busy = true; document.body.classList.add("busy");
  try { return await api(route, body); }
  catch (e) { toast("⚠️ " + e.message); haptic("err"); return null; }
  finally { busy = false; document.body.classList.remove("busy"); }
}
function onEvent(ev){
  if (ev.t === "mission") { const m = DAILY.find(x=>x.id===ev.id); if (m) toast(`🎯 Миссия выполнена: ${m.t}`); }
  if (ev.t === "level") setTimeout(()=>modal(`<div class="big">⭐</div><h3>Уровень ${ev.level}!</h3><p>Награда: ${fmt(ev.reward)} 💎</p><button class="bigbtn" onclick="closeModal()">Круто</button>`), 600);
}
let settingsTimer = null;
function pushSettings(){ clearTimeout(settingsTimer); settingsTimer = setTimeout(()=>api("settings", {sound:S.sound, traps:S.traps, bet:S.bet}).catch(()=>{}), 500); }

// ---------- board ----------
const board = $("board");
function buildBoard(){
  board.innerHTML = "";
  for (let i=0;i<SIZE;i++){
    const b = document.createElement("button"); b.className = "tile";
    b.addEventListener("click", () => onTile(i, b));
    board.appendChild(b);
  }
}
function resetTiles(){ [...board.children].forEach(t => { t.className = "tile"; t.innerHTML = ""; }); }
function paintOpen(open){ open.forEach(i => { const t = board.children[i]; t.className = "tile open gem"; t.innerHTML = GEM; }); }
function revealAll(rv, hit){
  [...board.children].forEach((t, i) => {
    if (rv.open.includes(i) || i === hit) return;
    const mine = rv.mines.includes(i);
    t.className = "tile open ghost " + (mine ? "boom" : "gem");
    t.innerHTML = mine ? MINE : GEM;
  });
}
let lastRound = null; // to keep the revealed board visible after a round ends

async function startGame(){
  const bet = clampBet(+$("bet").value || 0);
  if (bet > S.balance) { toast("Недостаточно кристаллов. Загляни в «Бонусы» 🎁"); haptic("err"); return; }
  const r = await act("start", { bet, traps: S.traps });
  if (!r) return;
  lastRound = null; resetTiles(); board.classList.remove("idle");
  haptic("medium"); sfx.click(); renderAll();
}
const tapQueue = [];
function onTile(i, el){
  if (!S || !S.game || S.game.open.includes(i) || tapQueue.includes(i)) return;
  el.classList.add("pending"); haptic("light");
  tapQueue.push(i); renderGame();
  if (tapQueue.length === 1) runQueue();
}
async function runQueue(){
  while (tapQueue.length) {
    const i = tapQueue[0], el = board.children[i];
    if (!S.game) { tapQueue.forEach(j => board.children[j].classList.remove("pending")); tapQueue.length = 0; break; }
    await revealTile(i, el);
    el.classList.remove("pending");
    tapQueue.shift();
  }
}
async function revealTile(i, el){
  while (busy) await new Promise(r => setTimeout(r, 30));
  const r = await act("reveal", { i });
  if (!r) return;
  if (r.result === "boom") {
    el.className = "tile open boom"; el.innerHTML = MINE;
    haptic("err"); sfx.boom();
    board.parentElement.classList.add("shake"); setTimeout(()=>board.parentElement.classList.remove("shake"), 450);
    revealAll(r.reveal, i); lastRound = true; board.classList.add("idle");
  } else {
    el.className = "tile open gem"; el.innerHTML = GEM;
    haptic("light"); sfx.gem((S.game ? S.game.open.length : 25));
    if (r.cashed) onCashed(r);
  }
  renderAll();
}
async function cashOut(){
  // сначала дождаться уже нажатых плиток, иначе «Забрать» потеряется
  while (tapQueue.length || busy) await new Promise(r => setTimeout(r, 30));
  if (!S.game || !S.game.open.length) return;
  const r = await act("cashout");
  if (r) { onCashed(r); renderAll(); }
}
function onCashed(r){
  revealAll(r.reveal, -1); lastRound = true; board.classList.add("idle");
  haptic("ok"); sfx.cash(); bumpBal();
  const c = r.cashed;
  setTimeout(()=>modal(`<div class="big">💎</div><h3>+${fmt(c.win)}</h3><p>Множитель ×${c.m.toFixed(2)} · ловушек: ${c.traps}</p><button class="bigbtn blue" onclick="closeModal()">Продолжить</button>`), 350);
}

// ---------- bet controls ----------
function clampBet(v){ return Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(v))); }
function setBet(v){ S.bet = clampBet(v); $("bet").value = S.bet; renderGame(); pushSettings(); }
$("betMinus").onclick = () => { sfx.click(); setBet(S.bet/2); };
$("betPlus").onclick  = () => { sfx.click(); setBet(S.bet*2); };
$("bet").addEventListener("change", e => setBet(+e.target.value||MIN_BET));
$("bet").addEventListener("input", e => { e.target.value = e.target.value.replace(/\D/g,""); });
$("quick").addEventListener("click", e => {
  const q = e.target.dataset.q; if (!q) return; sfx.click();
  if (q==="min") setBet(MIN_BET); if (q==="half") setBet(S.bet/2); if (q==="x2") setBet(S.bet*2); if (q==="max") setBet(Math.max(MIN_BET, S.balance));
});
const setTraps = v => { S.traps = Math.max(1, Math.min(24, v)); sfx.click(); haptic("light"); renderGame(); pushSettings(); };
$("trapMinus").onclick = () => setTraps(S.traps-1);
$("trapPlus").onclick  = () => setTraps(S.traps+1);
$("playBtn").onclick = () => { if (S.game) cashOut(); else startGame(); };

// ---------- missions ----------
document.addEventListener("click", async e => {
  const d = e.target.closest("[data-dm]");
  if (d) { const r = await act("claimDaily", {id:d.dataset.dm}); if (r) { haptic("ok"); sfx.cash(); toast(`+${fmt(r.reward)} 💎`); bumpBal(); renderAll(); } }
  const a = e.target.closest("[data-am]");
  if (a) { const r = await act("claimAch", {id:a.dataset.am}); if (r) { haptic("ok"); sfx.cash(); toast(`🏅 +${fmt(r.reward)} 💎`); bumpBal(); renderAll(); } }
});

// ---------- bonus ----------
$("dailyBtn").onclick = async () => {
  const r = await act("bonus"); if (!r) return;
  haptic("ok"); sfx.cash(); toast(`🎁 День ${r.streak}: +${fmt(r.reward)} 💎`); bumpBal(); renderAll();
};
let wheelRot = 0;
function buildWheel(){
  const w = $("wheel"), n = SEG.length, step = 360/n;
  w.style.background = `conic-gradient(${SEG.map((s,i)=>`${s.c} ${i*step}deg ${(i+1)*step}deg`).join(",")})`;
  w.innerHTML = SEG.map((s,i)=>`<span style="transform:rotate(${i*step+step/2-90}deg) translate(62px,-8px)">${s.v}</span>`).join("");
}
let spinning = false;
$("spinBtn").onclick = async () => {
  if (spinning || now() < S.spinAt) return;
  spinning = true;
  const balBefore = S.balance;
  const r = await act("spin");
  if (!r) { spinning = false; return; }
  const shownBal = $("bal"); shownBal.textContent = fmt(balBefore); // reveal after the wheel stops
  const step = 360/SEG.length, target = 360 - (r.idx*step + step/2);
  wheelRot += 360*5 + ((target - wheelRot % 360) + 360) % 360;
  $("wheel").style.transform = `rotate(${wheelRot}deg)`;
  $("spinBtn").disabled = true; haptic("medium");
  let ticks = 0; const tick = setInterval(()=>{ sfx.click(); if (++ticks>25) clearInterval(tick); }, 140);
  setTimeout(()=>{ spinning = false; haptic("ok"); sfx.cash(); renderAll(); bumpBal();
    modal(`<div class="big">🎡</div><h3>+${fmt(r.reward)} 💎</h3><p>Возвращайся через 4 часа</p><button class="bigbtn blue" onclick="closeModal()">Ура</button>`); }, 4100);
};
$("refillBtn").onclick = async () => { const r = await act("refill"); if (r) { haptic("ok"); sfx.cash(); toast("+500 💎"); bumpBal(); renderAll(); } };

// ---------- leaderboard ----------
let lbBy = "balance";
document.querySelectorAll("[data-lb]").forEach(b => b.onclick = () => {
  document.querySelectorAll("[data-lb]").forEach(x => x.classList.toggle("on", x===b));
  lbBy = b.dataset.lb; loadLb();
});
async function loadLb(){
  const box = $("lbList");
  try {
    const r = await fetch(API + "/api/leaderboard?by=" + lbBy, { headers: { "X-Init-Data": INIT } }).then(r=>r.json());
    if (r.error) throw new Error(r.error);
    const medal = p => ["🥇","🥈","🥉"][p-1] || p;
    const row = x => `<div class="lbr ${x.me?"me":""}"><div class="pl">${medal(x.place)}</div><div class="nm">${esc(x.name)}${x.admin?'<span class="badge">admin</span>':""}</div><div class="vl">${lbBy==="level"?`ур. ${x.level}`:`${fmt(x.balance)} 💎`}</div></div>`;
    box.innerHTML = (r.list.map(row).join("") || `<div class="muted">Пока никого нет</div>`) + (r.mine ? `<div class="lbsep">⋯</div>${row(r.mine)}` : "");
  } catch(e) { box.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(e.message)}</div>`; }
}

// ---------- admin ----------
async function adm(route, body, okMsg){
  const target = $("admTarget").value.trim();
  if (!target) { toast("Укажи @ник или ID"); return; }
  if (busy) return; busy = true;
  try {
    const r = await fetch(API + "/api/admin/" + route, { method:"POST", headers:{ "Content-Type":"application/json", "X-Init-Data": INIT }, body: JSON.stringify({ target, ...body }) }).then(r=>r.json());
    if (r.error) throw new Error(r.error);
    const u = r.user;
    $("admUser").innerHTML = `<b>${esc(u.name)}</b>${u.username?` @${esc(u.username)}`:""} · ID ${u.id} · ${fmt(u.balance)} 💎 · ур. ${u.level}${u.hidden?" · 🙈 скрыт":""}`;
    if (r.text) { toast("✅ " + r.text); haptic("ok"); }
    if (u.id === S.me.id) await api("state", {}).then(renderAll).catch(()=>{});
  } catch(e) { toast("⚠️ " + e.message); haptic("err"); }
  finally { busy = false; }
}
$("admFind").onclick = () => adm("find", {});
$("admGive").onclick = () => { const n = +$("admCrystals").value; if (!n) return toast("Введи количество"); adm("apply", { crystals: n }); };
$("admLevel").onclick = () => { const n = +$("admLevels").value; if (!n) return toast("Введи число уровней"); adm("apply", { levels: n }); };
$("admHide").onclick = () => adm("apply", { hidden: true });
$("admUnhide").onclick = () => adm("apply", { hidden: false });

// ---------- UI ----------
function toast(msg){ const t = document.createElement("div"); t.className="toast"; t.textContent = msg; $("toasts").appendChild(t); setTimeout(()=>{ t.style.transition="opacity .3s"; t.style.opacity=0; setTimeout(()=>t.remove(),300); }, 2600); }
function modal(html){ $("modalBox").innerHTML = html; $("modal").classList.add("on"); }
window.closeModal = () => $("modal").classList.remove("on");
$("modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
function bumpBal(){ $("bal").parentElement.animate([{transform:"scale(1.12)"},{transform:"scale(1)"}],{duration:250}); }

document.querySelectorAll(".nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".nav button").forEach(x=>x.classList.toggle("on", x===b));
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("on", v.id === "v-"+b.dataset.v));
  sfx.click(); haptic("light"); renderAll(); window.scrollTo(0,0);
  if (b.dataset.v === "top") loadLb();
});
document.querySelectorAll("[data-mt]").forEach(b => b.onclick = () => {
  document.querySelectorAll("[data-mt]").forEach(x=>x.classList.toggle("on", x===b));
  $("mDaily").style.display = b.dataset.mt==="daily" ? "" : "none";
  $("mAch").style.display = b.dataset.mt==="ach" ? "" : "none";
});
$("soundBtn").onclick = () => { S.sound = !S.sound; renderTop(); pushSettings(); };
$("rulesBtn").onclick = () => modal(`<div class="big">💎</div><h3>Как играть</h3><div class="rules">
  <p>1. Выбери ставку и количество ловушек (1–24).</p>
  <p>2. Нажми «Играть» и открывай плитки — за каждым кристаллом растёт множитель.</p>
  <p>3. Попал на ловушку — ставка сгорает. Забери выигрыш в любой момент!</p>
  <p>4. Больше ловушек — выше множитель и риск.</p>
  <p>5. Выполняй миссии, крути колесо и соревнуйся в таблице лидеров.</p>
  <p style="color:var(--muted)">Кристаллы — внутриигровая валюта без реальной стоимости.</p></div>
  <button class="bigbtn blue" onclick="closeModal()">Понятно</button>`);

function renderTop(){
  $("bal").textContent = fmt(S.balance);
  $("lvl").textContent = S.level;
  $("xpTxt").textContent = `${S.xp}/${xpNeed(S.level)}`;
  $("xpBar").style.width = Math.min(100, S.xp/xpNeed(S.level)*100) + "%";
  $("soundBtn").textContent = S.sound ? "🔊" : "🔇";
  $("uname").innerHTML = esc(S.me.name) + (S.me.admin ? '<span class="badge">admin</span>' : "");
  $("ava").textContent = (S.me.name || "?")[0].toUpperCase();
}
function renderGame(){
  const g = S.game, active = !!g;
  $("traps").textContent = S.traps;
  if (document.activeElement !== $("bet")) $("bet").value = S.bet;
  $("maxwin").textContent = fmt(payout(S.bet, multFor(S.traps, SIZE - S.traps))) + " 💎";
  ["setupRow","betBox","quick"].forEach(id => $(id).classList.toggle("disabled", active));
  const traps = active ? g.traps : S.traps, opened = active ? g.open.length : 0;
  const cur = multFor(traps, opened);
  $("mult").textContent = "×" + cur.toFixed(2);
  $("next").textContent = opened < SIZE - traps ? `Следующий: ×${multFor(traps, opened+1).toFixed(2)}` : "";
  board.classList.toggle("idle", !active);
  const pb = $("playBtn");
  if (active) {
    const waiting = opened === 0 && tapQueue.length > 0;
    pb.classList.add("cash"); pb.disabled = opened === 0 && !waiting;
    pb.innerHTML = waiting ? "Забрать" : opened === 0 ? "Открой плитку" : `Забрать<small>${fmt(payout(g.bet, cur))} 💎</small>`;
  } else { pb.classList.remove("cash"); pb.disabled = false; pb.textContent = "Играть"; }
}
function renderMissions(){
  const today = S.daily.date === S.dayKey ? S.daily : {p:{}, c:{}};
  $("dailyList").innerHTML = DAILY.map(m => {
    const p = today.p[m.id]||0, done = p >= m.goal, got = today.c[m.id];
    return `<div class="card"><div class="ic">${m.ic}</div><div class="body"><div class="t">${m.t}</div>
      <div class="d">${p}/${m.goal} · награда ${fmt(m.r)} 💎</div><div class="prog"><b style="width:${p/m.goal*100}%"></b></div></div>
      <button class="claim ${got?"done":""}" data-dm="${m.id}" ${done&&!got?"":"disabled"}>${got?"✓":"Забрать"}</button></div>`;
  }).join("");
  $("achList").innerHTML = ACH.map(a => {
    const v = Math.min(a.goal, a.v(S)), done = v >= a.goal, got = S.ach[a.id];
    const shown = a.id.startsWith("x") ? `×${(+v).toFixed(2)}/×${a.goal}` : `${fmt(v)}/${fmt(a.goal)}`;
    return `<div class="card"><div class="ic">${a.ic}</div><div class="body"><div class="t">${a.t}</div>
      <div class="d">${a.d} · ${shown} · ${fmt(a.r)} 💎</div><div class="prog"><b style="width:${v/a.goal*100}%"></b></div></div>
      <button class="claim ${got?"done":""}" data-am="${a.id}" ${done&&!got?"":"disabled"}>${got?"✓":"Забрать"}</button></div>`;
  }).join("");
}
const dur = ms => { const s = Math.max(0, Math.ceil(ms/1000)), h = Math.floor(s/3600), m = Math.floor(s%3600/60), x = s%60; return h ? `${h}ч ${m}м` : `${m}м ${x}с`; };
function bonusState(){
  // server sends bonusState at the time of the response; good enough until midnight
  return S.bonusState || {claimedToday:false, streak:0};
}
function renderBonus(){
  const b = bonusState();
  const cur = b.claimedToday ? b.streak : b.streak + 1;
  const base = Math.floor((cur-1)/7)*7;
  $("days").innerHTML = DAY_REWARDS.map((r,i) => {
    const dayN = base + i + 1;
    const got = dayN < cur || (dayN === cur && b.claimedToday);
    return `<div class="day ${got?"got":""} ${dayN===cur?"today":""}">День ${dayN}<b>${got?"✓":r}</b></div>`;
  }).join("");
  $("dailyBtn").disabled = b.claimedToday;
  $("dailyBtn").textContent = b.claimedToday ? "Приходи завтра" : `Забрать ${fmt(DAY_REWARDS[(cur-1)%7])} 💎`;
  if (!spinning) {
    const left = S.spinAt - now();
    $("spinBtn").disabled = left > 0;
    $("spinBtn").textContent = left > 0 ? `Через ${dur(left)}` : "Крутить бесплатно";
  }
  const refLeft = (S.refillAt || 0) - now();
  const canRefill = S.balance < MIN_BET && !S.game && refLeft <= 0;
  $("refillBtn").disabled = !canRefill;
  $("refillBtn").textContent = canRefill ? "Получить 500 💎" : (S.balance < MIN_BET && refLeft > 0 ? `Снова через ${dur(refLeft)}` : "Доступно при балансе < 10");
}
function renderProfile(){
  const s = S.stats, wr = s.games ? Math.round(s.wins/s.games*100) : 0;
  const items = [["Раундов",fmt(s.games)],["Побед",`${fmt(s.wins)} (${wr}%)`],["Кристаллов открыто",fmt(s.gems)],["Лучший множитель","×"+s.bestMult.toFixed(2)],["Лучший выигрыш",fmt(s.bestWin)+" 💎"],["Уровень",S.level]];
  $("stats").innerHTML = items.map(([k,v])=>`<div class="stat"><small>${k}</small><b>${v}</b></div>`).join("");
  $("hist").innerHTML = S.hist.length ? S.hist.map(h=>`<div><span>${h.t} 💀 · ставка ${fmt(h.b)}</span><span class="${h.w?"win":"lose"}">${h.w?`×${h.m.toFixed(2)} +${fmt(h.win)}`:`−${fmt(h.b)}`}</span></div>`).join("") : `<div style="color:var(--muted)">Пока нет игр</div>`;
  $("adminPanel").style.display = S.me.admin ? "" : "none";
}
function renderDots(){
  const today = S.daily.date === S.dayKey ? S.daily : {p:{}, c:{}};
  const m = DAILY.some(x => (today.p[x.id]||0) >= x.goal && !today.c[x.id]) || ACH.some(a => a.v(S) >= a.goal && !S.ach[a.id]);
  const b = !bonusState().claimedToday || now() >= S.spinAt;
  $("dotM").classList.toggle("show", m); $("dotB").classList.toggle("show", b);
}
function renderTimer(){
  // missions reset at midnight Moscow time (UTC+3)
  const msk = now() + 3*3600e3, next = (Math.floor(msk / 86400e3) + 1) * 86400e3;
  $("resetIn").textContent = dur(next - msk);
}
function renderAll(){ if (!S) return; renderTop(); renderGame(); renderMissions(); renderBonus(); renderProfile(); renderDots(); renderTimer(); }

// ---------- init ----------
(function stars(){ const f = $("bgfx"); for (let i=0;i<18;i++){ const s = document.createElement("i"); s.style.left = Math.random()*100+"%"; s.style.top = Math.random()*100+"%"; s.style.animationDelay = (Math.random()*4)+"s"; f.appendChild(s);} })();
buildBoard(); buildWheel();

async function boot(){
  if (!INIT) {
    $("gateMsg").textContent = "Игра работает внутри Telegram. Открой её через бота.";
    $("gateBtn").style.display = "";
    return;
  }
  try {
    await api("state", {});
    if (S.game) { board.classList.remove("idle"); paintOpen(S.game.open); } // resume a round in progress
    $("gate").classList.add("off");
    renderAll();
  } catch(e) {
    $("gateMsg").innerHTML = "Не удалось подключиться к серверу.<br>" + esc(e.message);
    setTimeout(boot, 3000);
  }
}
boot();
setInterval(() => { if (!S) return; renderTimer(); if ($("v-bonus").classList.contains("on")) renderBonus(); renderDots(); }, 1000);
// refresh from server when the app comes back to the foreground (e.g. after midnight or admin gift)
document.addEventListener("visibilitychange", () => { if (!document.hidden && S && !busy) api("state", {}).then(renderAll).catch(()=>{}); });
})();
