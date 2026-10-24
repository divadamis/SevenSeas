// Sedm moří – herní server
//  • zobrazí hru (složka public/)
//  • účty hráčů: registrace, přihlášení, zlaťáky a vlastněné lodě (soubor data/accounts.json)
//  • přeposílá polohy a salvy mezi hráči (WebSocket /mp)
// Spuštění: npm install && npm start   (PORT, DATA_DIR, MAX_PLAYERS z proměnných prostředí)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'accounts.json');
const MAX_PLAYERS = +(process.env.MAX_PLAYERS || 64);
const MAX_MSG = 4096, MAX_RATE = 40;

const PROG = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'progress.json'), 'utf8'));
const SHIPS = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(PUBLIC, 'ships.json'), 'utf8')).ships.map(s => [s.id, s]));
const tierOf = id => PROG.tiers.findIndex(t => t.includes(id));
const GIFT = PROG.gift || [];                       // lodě, které má každý hráč (nepočítají se do postupu)
const isGift = id => GIFT.includes(id);
// vylepšení z kovárny: [děla, plachty, výztuhy, paluba], cena podle ceny lodi (stejný vzorec jako ve hře)
const UPG = PROG.upgrades || { max: 7, frac: [0.05, 0.07, 0.09, 0.11, 0.13, 0.15, 0.17], min: [400, 650, 900, 1150, 1400, 1700, 2000], kind: [1, 0.8, 0.9, 1.3, 0.6, 1.1, 0.8, 0.5] };
// ceny předchozí verze (před zlevněním vyšších úrovní) – pro vrácení rozdílu za už koupené úrovně
const v1UpgCost = (id, k, lvl) => Math.round(Math.max([400, 700, 1100, 1600, 2300, 3200, 4500][lvl - 1], (PROG.price[id] || 0) * [0.06, 0.1, 0.15, 0.22, 0.3, 0.4, 0.52][lvl - 1]) * UPG.kind[k] / 50) * 50;
const UPG_N = 8;
const oldUpgCost = (id, k, lvl) => Math.round(Math.max([500, 1200, 2500][lvl - 1], (PROG.price[id] || 0) * [0.1, 0.22, 0.4][lvl - 1]) * [1, 0.8, 0.9, 1.3][k] / 50) * 50;   // děla, plachty, výztuhy, paluba, kormidlo, dělostřelci, honicí děla, tesaři
// plachty: +1 uzel na úroveň, rychlost je ale omezená na 30 uzlů – úrovně bez účinku se neprodávají (stejný výpočet jako ve hře)
const HULLS = Object.values(SHIPS).map(s => s.hull), H_MIN = Math.min(...HULLS), H_MAX = Math.max(...HULLS);
const baseKn = id => { const s = SHIPS[id]; if (!s) return 30; const f = Math.max(0, Math.min(1, (s.hull - H_MIN) / Math.max(1, H_MAX - H_MIN))); return Math.round((20 + 5 * f) * 10) / 10; };   // základ 20–25 uzlů
// nejvyšší úroveň vylepšení podle lodi (menší lodě méně úrovní); plachty navíc jen do limitu 30 uzlů (+0,7 uzlu na úroveň)
const shipCap = id => { const c = PROG.upgCap && PROG.upgCap[id]; if (c !== undefined) return Math.max(0, Math.min(UPG.max, c | 0)); const s = SHIPS[id]; return s ? Math.max(3, Math.min(UPG.max, 3 + Math.round(4 * (s.hull - 177) / (460 - 177)))) : 3; };
const upgMax = (id, k) => k === 1 ? Math.max(0, Math.min(shipCap(id), Math.round((30 - baseKn(id)) / 0.7))) : shipCap(id);
const upgCost = (id, k, lvl) => Math.round(Math.max(UPG.min[lvl - 1], (PROG.price[id] || 0) * UPG.frac[lvl - 1]) * UPG.kind[k] / 50) * 50;
const upgOf = (acc, id) => { const a = (acc && acc.upg && acc.upg[id]) || []; return Array.from({ length: UPG_N }, (_, i) => Math.max(0, Math.min(upgMax(id, i), a[i] | 0))); };
// bezpečné vody (stejně jako v klientu): kruh uprostřed mapy + okolí přístavů
const WORLDJ = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'world.json'), 'utf8'));
const SAFE_C = { x: WORLDJ.W / 2, y: WORLDJ.W / 2, r: WORLDJ.W * 0.14 }, SAFE_PORT_R = 5200;
function isSafe(x, y) { x = +x || 0; y = +y || 0; return Math.hypot(x - SAFE_C.x, y - SAFE_C.y) < SAFE_C.r || WORLDJ.ports.some(P => Math.hypot(P.wx - x, P.wy - y) < SAFE_PORT_R); }
const QUESTS = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(PUBLIC, 'quests.json'), 'utf8')).quests.map(q => [q.id, q]));

// ---------------- účty ----------------
let db = { accounts: {}, tokens: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { /* první spuštění */ }
db.accounts = db.accounts || {}; db.tokens = db.tokens || {};
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); }
    catch (e) { console.error('Uložení účtů selhalo:', e.message); }
  }, 1500);
}
const keyOf = name => name.toLocaleLowerCase('cs');
const NAME_RE = /^[\p{L}\p{N} _.\-]{3,20}$/u;
function hashPass(pass, salt) { return crypto.scryptSync(pass, salt, 32).toString('hex'); }
function newToken(acc) {
  const t = crypto.randomBytes(24).toString('hex');
  db.tokens[t] = { k: keyOf(acc.name), exp: Date.now() + 60 * 864e5 };
  return t;
}
function accByToken(t) {
  const e = t && db.tokens[t]; if (!e) return null;
  if (e.exp < Date.now()) { delete db.tokens[t]; save(); return null; }
  return db.accounts[e.k] || null;
}
// převod starých účtů: lodě mimo současnou nabídku hráčům zmizí (zůstávají jen jako NPC), startovní loď mají všichni
function migrate(acc) {
  const ok = id => PROG.price[id] !== undefined || PROG.start.includes(id) || isGift(id);
  acc.owned = acc.owned.filter(ok);
  if (!acc.migLinie) { acc.owned = acc.owned.filter(id => id !== 24); acc.migLinie = 1; }   // Zefyr byl dřív dárek, teď se kupuje
  for (const s of PROG.start) if (!acc.owned.includes(s)) acc.owned.unshift(s);
  if (!acc.owned.includes(acc.sel)) acc.sel = PROG.start[0];
  // plachty koupené dřív nad limit rychlosti: vrátit zlato za úrovně, které nic nedělaly
  if (acc.upg) for (const id in acc.upg) { const a = acc.upg[id]; if (!Array.isArray(a)) continue;
    for (let k = 0; k < a.length && k < UPG_N; k++) { const top = upgMax(id | 0, k); while ((a[k] | 0) > top) { acc.gold += upgCost(id | 0, k, a[k] | 0); a[k] = (a[k] | 0) - 1; acc.dirty = 1; } } }
  // přechod na 7 úrovní: dřívější úrovně 1–3 byly dražší – rozdíl ceny se vrací
  if (!acc.upg7) { acc.upg7 = 1; acc.dirty = 1; if (acc.upg) for (const id in acc.upg) { const a = acc.upg[id]; if (!Array.isArray(a)) continue;
    for (let k = 0; k < 4; k++) for (let l = 1; l <= Math.min(3, a[k] | 0); l++) acc.gold += Math.max(0, oldUpgCost(id | 0, k, l) - v1UpgCost(id | 0, k, l)); } }
  // zlevnění vyšších úrovní: rozdíl ceny za už koupené úrovně se vrací
  if (!acc.upgV2) { acc.upgV2 = 1; acc.dirty = 1; if (acc.upg) for (const id in acc.upg) { const a = acc.upg[id]; if (!Array.isArray(a)) continue;
    for (let k = 0; k < a.length && k < UPG_N; k++) for (let l = 1; l <= (a[k] | 0) && l <= UPG.max; l++) acc.gold += Math.max(0, v1UpgCost(id | 0, k, l) - upgCost(id | 0, k, l)); } }
  if (acc.dirty) { delete acc.dirty; save(); }
}
// jednorázové přidání zlaťáků: proměnná prostředí GRANT_GOLD="Jméno kapitána:5000000" (více účtů oddělit čárkou).
// Každá hodnota se připíše jen jednou – při dalším restartu už ne. Pro nové připsání stačí hodnotu změnit.
function grantGold() {
  const spec = String(process.env.GRANT_GOLD || '').trim(); if (!spec) return;
  db.grants = db.grants || [];
  for (const part of spec.split(',')) { const i = part.lastIndexOf(':'); if (i < 1) continue;
    const name = part.slice(0, i).trim(), add = Math.floor(+part.slice(i + 1)); if (!(add > 0)) continue;
    const tag = part.trim(); if (db.grants.includes(tag)) continue;
    const acc = db.accounts[keyOf(name)]; if (!acc) { console.log('GRANT_GOLD: účet nenalezen –', name); continue; }
    acc.gold = (acc.gold || 0) + add; db.grants.push(tag); console.log('GRANT_GOLD: +' + add + ' zl. pro ' + acc.name); }
  save();
}
function profile(acc) { migrate(acc); for (const g of GIFT) if (!acc.owned.includes(g)) acc.owned.push(g); return { name: acc.name, gold: Math.floor(acc.gold), owned: acc.owned, sel: acc.sel, kills: acc.kills || 0, st: acc.st || null, qdone: acc.qdone || [], upg: acc.upg || {}, pos: acc.pos || null }; }

// jednoduché omezení pokusů o přihlášení z jedné adresy
const tries = new Map();
function tooMany(ip) { const now = Date.now(); const e = tries.get(ip) || { n: 0, t: now }; if (now - e.t > 60000) { e.n = 0; e.t = now; } e.n++; tries.set(ip, e); return e.n > 12; }

function json(res, code, obj) { const s = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(s); }
function readBody(req) { return new Promise((ok, bad) => { let n = 0; const ch = []; req.on('data', c => { n += c.length; if (n > 16384) { bad(new Error('big')); req.destroy(); } else ch.push(c); }); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(ch).toString('utf8') || '{}')); } catch (e) { bad(e); } }); req.on('error', bad); }); }

// odměny počítá server sám (z druhu události a délky trupu potopené lodi), s omezením četnosti
const R = PROG.reward;
// zajímavá místa ze světa (odměna za první objevení) – jména a druhy
const PORTS = (() => { try { return JSON.parse(fs.readFileSync(path.join(PUBLIC, 'world.json'), 'utf8')).ports; } catch (e) { return []; } })();
const PORT_IDS = PORTS.map(q => q.id);
function nearestPort(x, y) { let b = null, bd = Infinity; for (const P of PORTS) { const d = Math.hypot(P.wx - x, P.wy - y); if (d < bd) { bd = d; b = P; } } return b; }
const POIS = (() => { try { const w = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'world.json'), 'utf8')); const m = {}; for (const q of w.pois || []) m[q.name] = q.type; return m; } catch (e) { return {}; } })();
function rewardFor(ev, acc) {
  const now = Date.now(); acc.rl = acc.rl || {};
  const gap = (k, ms) => { if (now - (acc.rl[k] || 0) < ms) return false; acc.rl[k] = now; return true; };
  if (ev.k === 'npc') { const s = SHIPS[ev.s | 0]; if (!s || !gap('npc', 2500)) return 0; return Math.round(ev.p ? R.pirateBase + s.hull * R.pirateHull : R.merchantBase + s.hull * R.merchantHull); }
  if (ev.k === 'mon') { if (!gap('mon', 15000)) return 0; return ev.t === 'kraken' ? R.kraken : ev.t === 'serpent' ? R.serpent : 0; }
  return 0;
}

async function api(req, res, p) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (req.method !== 'POST' && p !== '/api/me') return json(res, 405, { error: 'Metoda není povolena.' });
  let b = {}; if (req.method === 'POST') { try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'Neplatný požadavek.' }); } }

  if (p === '/api/register' || p === '/api/login') {
    if (tooMany(ip)) return json(res, 429, { error: 'Příliš mnoho pokusů, zkus to za minutu.' });
    const name = String(b.name || '').trim(), pass = String(b.pass || '');
    if (!NAME_RE.test(name)) return json(res, 400, { error: 'Jméno musí mít 3–20 znaků (písmena, číslice, mezera, _ . -).' });
    if (pass.length < 6 || pass.length > 100) return json(res, 400, { error: 'Heslo musí mít aspoň 6 znaků.' });
    const k = keyOf(name);
    if (p === '/api/register') {
      if (db.accounts[k]) return json(res, 409, { error: 'Tohle jméno už někdo používá.' });
      const salt = crypto.randomBytes(16).toString('hex');
      db.accounts[k] = { name, salt, hash: hashPass(pass, salt), gold: PROG.startGold ?? 2000, owned: PROG.start.slice(), sel: PROG.start[0], kills: 0, created: Date.now() };
    } else {
      const a = db.accounts[k];
      if (!a || !crypto.timingSafeEqual(Buffer.from(hashPass(pass, a.salt), 'hex'), Buffer.from(a.hash, 'hex'))) return json(res, 401, { error: 'Špatné jméno nebo heslo.' });
    }
    const acc = db.accounts[k]; const token = newToken(acc); save();
    return json(res, 200, { token, profile: profile(acc) });
  }

  const acc = accByToken(auth);
  if (!acc) return json(res, 401, { error: 'Nejsi přihlášený.' });
  if (p === '/api/me') return json(res, 200, { profile: profile(acc) });
  if (p === '/api/logout') { delete db.tokens[auth]; save(); return json(res, 200, { ok: true }); }

  if (p === '/api/buy') {
    const id = b.ship | 0, price = PROG.price[id], t = tierOf(id);
    if (price === undefined || t < 0) return json(res, 400, { error: 'Neznámá loď.' });
    if (acc.owned.includes(id)) return json(res, 400, { error: 'Tuhle loď už máš.' });
    if (acc.gold < price) return json(res, 402, { error: 'Nemáš dost zlaťáků.' });
    acc.gold -= price; acc.owned.push(id); acc.sel = id; save();
    return json(res, 200, { profile: profile(acc) });
  }
  if (p === '/api/upgrade') {
    const id = b.ship | 0, k = b.k | 0;
    if (!acc.owned.includes(id)) return json(res, 403, { error: 'Tuhle loď nevlastníš.' });
    if (k < 0 || k >= UPG_N) return json(res, 400, { error: 'Neznámé vylepšení.' });
    const a = upgOf(acc, id); if (a[k] >= upgMax(id, k)) return json(res, 400, { error: k === 1 ? 'Rychlejší už tahle loď být nemůže (limit 30 uzlů).' : 'Tohle vylepšení už má u této lodi nejvyšší úroveň.' });
    const cost = upgCost(id, k, a[k] + 1); if (acc.gold < cost) return json(res, 402, { error: 'Nemáš dost zlaťáků.' });
    acc.gold -= cost; a[k]++; acc.upg = acc.upg || {}; acc.upg[id] = a; save();
    return json(res, 200, { profile: profile(acc) });
  }
  if (p === '/api/pos') {   // poslední poloha lodi (pokračování po návratu do hry)
    const x = +b.x, y = +b.y, h = +b.h, WW = PROG.worldW || 172032;
    if (!isFinite(x) || !isFinite(y) || x < 0 || y < 0 || x > WW || y > WW) return json(res, 400, { error: 'Neplatná poloha.' });
    const dk = PORT_IDS.includes(b.dk) ? b.dk : null;
    const hpf = Math.max(0.05, Math.min(1, +b.hpf || 1));
    acc.pos = { x: Math.round(x), y: Math.round(y), h: isFinite(h) ? Math.round(h * 1000) / 1000 : 0, dk, hpf }; save();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/select') {
    const id = b.ship | 0; if (!acc.owned.includes(id)) return json(res, 403, { error: 'Tuhle loď nevlastníš.' });
    acc.sel = id; save(); return json(res, 200, { profile: profile(acc) });
  }
  if (p === '/api/stats') {   // statistiky kapitána pro úkoly (ukládá je hra)
    const st = b.st; if (!st || typeof st !== 'object' || Array.isArray(st)) return json(res, 400, { error: 'Neplatná data.' });
    if (JSON.stringify(st).length > 8000) return json(res, 413, { error: 'Příliš velká data.' });
    acc.st = st; save(); return json(res, 200, { ok: true });
  }
  if (p === '/api/quest') {   // odměna za úkol – každý úkol jen jednou
    const q = QUESTS[b.id | 0]; if (!q) return json(res, 400, { error: 'Neznámý úkol.' });
    acc.qdone = acc.qdone || [];
    if (acc.qdone.includes(q.id)) return json(res, 200, { gold: Math.floor(acc.gold), got: 0 });
    const c = q.c;   // co server ověřit umí, ověří sám
    if (c[0] === 'gold' && acc.gold < c[1]) return json(res, 403, { error: 'Úkol ještě není splněný.', gold: Math.floor(acc.gold) });
    if (c[0] === 'tier' && !acc.owned.some(o => !isGift(o) && tierOf(o) >= c[1])) return json(res, 403, { error: 'Úkol ještě není splněný.', gold: Math.floor(acc.gold) });
    const now = Date.now(); acc.rl = acc.rl || {}; if (now - (acc.rl.quest || 0) < 1500) return json(res, 429, { error: 'Pomaleji.', gold: Math.floor(acc.gold) });
    acc.rl.quest = now; acc.qdone.push(q.id); acc.gold += q.r; save();
    return json(res, 200, { gold: Math.floor(acc.gold), got: q.r });
  }
  if (p === '/api/event') {
    const k = b.k;
    if (k === 'npc' || k === 'mon') { const g = rewardFor(b, acc); if (g > 0) { acc.gold += g; acc.kills = (acc.kills || 0) + 1; save(); } return json(res, 200, { gold: Math.floor(acc.gold), got: g }); }
    if (k === 'loot') {   // náplavy a poklady: částku určuje server, s omezením četnosti
      const t = b.t === 'crate' ? 'crate' : b.t === 'treasure' ? 'treasure' : b.t === 'chest' ? 'chest' : 'barrel', L = (R.loot || {})[t] || [40, 110];
      const now = Date.now(); acc.rl = acc.rl || {}; const gap = t === 'treasure' ? 120000 : t === 'chest' ? 1500 : 6000;
      if (now - (acc.rl['loot_' + t] || 0) < gap) return json(res, 200, { gold: Math.floor(acc.gold), got: 0 });
      acc.rl['loot_' + t] = now;
      // truhla z potopené lodi: podle velikosti lodi (délka trupu)
      const g = t === 'chest' ? Math.round(30 + ((SHIPS[b.s | 0] || {}).hull || 200) * (L[0] + Math.random() * (L[1] - L[0]))) : Math.round(L[0] + Math.random() * (L[1] - L[0]));
      acc.gold += g; save();
      return json(res, 200, { gold: Math.floor(acc.gold), got: g });
    }
    if (k === 'poi') {    // první objevení místa – každé jen jednou
      const ty = POIS[String(b.n || '')]; if (!ty) return json(res, 400, { error: 'Neznámé místo.' });
      acc.pois = acc.pois || []; if (acc.pois.includes(b.n)) return json(res, 200, { gold: Math.floor(acc.gold), got: 0 });
      acc.pois.push(b.n); const g = (R.poi || {})[ty] || 0; acc.gold += g; save();
      return json(res, 200, { gold: Math.floor(acc.gold), got: g });
    }
    if (k === 'death') { const now = Date.now(); if (now - (acc.lastDeath || 0) > 3000) { acc.lastDeath = now; acc.gold = Math.floor(acc.gold * (1 - PROG.deathLoss)); save(); } return json(res, 200, { gold: Math.floor(acc.gold) }); }
    if (k === 'repair') { const a = Math.max(0, Math.ceil(+b.amount || 0)); if (a > acc.gold) return json(res, 402, { error: 'Nemáš dost zlaťáků.', gold: Math.floor(acc.gold) }); acc.gold -= a; acc.lastRepair = a; save(); return json(res, 200, { gold: Math.floor(acc.gold) }); }
    if (k === 'refund') { const a = Math.max(0, Math.min(acc.lastRepair || 0, Math.floor(+b.amount || 0))); acc.gold += a; acc.lastRepair = 0; save(); return json(res, 200, { gold: Math.floor(acc.gold) }); }
    return json(res, 400, { error: 'Neznámá událost.' });
  }
  return json(res, 404, { error: 'Nenalezeno.' });
}

// ---------------- web ----------------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon'
};
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p.startsWith('/api/')) return api(req, res, p).catch(e => { console.error(e); json(res, 500, { error: 'Chyba serveru.' }); });
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok ' + clients.size); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Nenalezeno'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': st.size, 'cache-control': (ext === '.html' || ext === '.json') ? 'no-cache' : 'public, max-age=86400' });
    fs.createReadStream(file).pipe(res);
  });
});

// ---------------- hráči na moři ----------------
const wss = new WebSocketServer({ server, path: '/mp', maxPayload: MAX_MSG });
const clients = new Map();   // ws -> {peer, p, n, t, acc, guest, lastDc}
let nextId = 1;
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj, except) { const s = JSON.stringify(obj); for (const ws of clients.keys()) if (ws !== except && ws.readyState === 1) ws.send(s); }
function cleanNick(v) { return String(v || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 20); }

wss.on('connection', (ws, req) => {
  if (clients.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); return ws.close(); }
  let tok = ''; try { tok = new URL(req.url, 'http://x').searchParams.get('t') || ''; } catch (e) {}
  const acc = accByToken(tok);
  const me = 'k' + (nextId++).toString(36) + crypto.randomBytes(3).toString('hex');
  const c = { peer: me, p: null, n: 0, t: Date.now(), acc, lastDc: null };
  clients.set(ws, c);
  // návrat do hry: případná „opuštěná“ loď stejného kapitána zmizí
  if (acc) for (const [gp, g] of ghosts) if (g.acc === acc && !g.p.dead) { ghosts.delete(gp); ghostSavePos(g); broadcast({ t: 'left', peer: gp }); }
  send(ws, { t: 'hello', me, peers: [...clients.values()].filter(x => x !== c && x.p).map(x => ({ peer: x.peer, p: x.p })).concat([...ghosts.values()].map(g => ({ peer: g.peer, p: g.p }))), chat: chatHist });

  ws.on('message', (buf) => {
    const now = Date.now();
    if (now - c.t > 1000) { c.t = now; c.n = 0; }
    if (++c.n > MAX_RATE || buf.length > MAX_MSG) return;
    let d; try { d = JSON.parse(buf); } catch (e) { return; }
    if (d && d.t === 'hit') return ghostHit(c, d);
    if (d && d.t === 'chat') return chatMsg(c, d);
    if (!d || d.t !== 'p' || typeof d.p !== 'object' || Array.isArray(d.p) || !d.p) return;
    const p = d.p;
    // jméno a loď podle účtu (nelze se vydávat za jiného ani plout v nekoupené lodi)
    if (c.acc) { p.nm = c.acc.name; if (!c.acc.owned.includes(p.id | 0) && !isGift(p.id | 0)) p.id = c.acc.sel; p.ug = upgOf(c.acc, p.id | 0).join(''); }
    else { p.nm = 'Host ' + (cleanNick(p.nm).replace(/^Host\s*/i, '') || me.slice(-4)); if (!PROG.start.includes(p.id | 0) && !isGift(p.id | 0)) p.id = PROG.start[0]; p.ug = '0000'; }
    // potopení: odměna pro přihlášeného hráče, který potápěl (podle hlášení potopeného)
    const dc = p.dc | 0;
    if (c.lastDc === null) c.lastDc = dc;
    else if (dc > c.lastDc) {
      c.lastDc = dc;
      if (p.kb && p.dead && !isSafe(p.x, p.y)) { for (const [kws, kc] of clients) if (kc.peer === p.kb && kc.acc && kc !== c && !(kc.p && isSafe(kc.p.x, kc.p.y))) {
        const s = SHIPS[p.id | 0]; const g = Math.round(R.pvpBase + (s ? s.hull : 200) * R.pvpHull);
        const now2 = Date.now(); kc.acc.rl = kc.acc.rl || {};
        if (now2 - (kc.acc.rl.pvp || 0) > 5000) { kc.acc.rl.pvp = now2; kc.acc.gold += g; kc.acc.kills = (kc.acc.kills || 0) + 1; save(); send(kws, { t: 'gold', gold: Math.floor(kc.acc.gold), got: g }); }
      } }
    }
    c.p = p;
    broadcast({ t: 'p', peer: me, p }, ws);
  });
  ws.on('close', () => { clients.delete(ws);
    // odchod ze hry mimo přístav: loď zůstane 15 s na moři a dá se potopit (žádný útěk z boje zavřením hry)
    const p = c.p;
    if (p && !p.dead && !p.dk && typeof p.x === 'number') {
      const g = { peer: me, acc: c.acc, until: Date.now() + GHOST_MS, hp: Math.max(1, +p.hp || 1), mh: Math.max(1, +p.mh || 1), p: { ...p, sp: 0, sv: [], np: [], nsv: [], nh: [], gh: 1, kb: null } };   // opuštěná loď nemá NPC ani salvy
      ghosts.set(me, g); broadcast({ t: 'p', peer: me, p: g.p });
    } else broadcast({ t: 'left', peer: me }); });
  ws.on('error', () => {});
});
setInterval(() => { for (const ws of clients.keys()) { try { ws.ping(); } catch (e) {} } }, 25000);
// ---- chat: zprávy všem na moři, posledních 30 dostane i nově připojený
const chatHist = [];
function chatMsg(c, d) {
  const now = Date.now(); if (now - (c.lastChat || 0) < 800) return; c.lastChat = now;
  const m = String(d.m || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!m) return;
  const nm = c.acc ? c.acc.name : ((c.p && c.p.nm) || 'Host');
  const o = { t: 'chat', peer: c.peer, nm, m, ts: now }; chatHist.push(o); if (chatHist.length > 30) chatHist.shift();
  broadcast(o);
}
// ---- lodě odpojených hráčů (15 s na moři)
const GHOST_MS = 15000, ghosts = new Map();
function ghostSavePos(g) { if (g.acc && g.acc.pos && !g.p.dead) { g.acc.pos.hpf = Math.max(0.05, Math.min(1, g.hp / g.mh)); save(); } }
function ghostHit(c, d) {
  const g = ghosts.get(String(d.peer || '')); if (!g || g.p.dead || !c.p || c.p.dead) return;
  if (Math.hypot(c.p.x - g.p.x, c.p.y - g.p.y) > 2600 || isSafe(g.p.x, g.p.y) || isSafe(c.p.x, c.p.y)) return;
  // zprávu tvoří dávka zásahů (n koulí); nejvýš 80 poškození na kouli a 100 koulí za sekundu
  const n = Math.max(1, Math.min(40, d.n | 0 || 1));
  const now = Date.now(); c.hw = c.hw && now - c.hw.t < 1000 ? c.hw : { t: now, n: 0 }; if ((c.hw.n += n) > 100) return;
  g.hp -= Math.max(0, Math.min(80 * n, +d.d || 0)); g.p.hp = Math.max(0, Math.round(g.hp));
  if (g.hp <= 0) {   // potopení opuštěné lodi: odměna pro útočníka; majitel o zlaťáky nepřichází, jen začne příště v přístavu
    g.p.dead = true; g.p.dc = (g.p.dc | 0) + 1; g.p.kb = c.peer; g.until = now + 3500;
    if (g.acc) { const P = nearestPort(g.p.x, g.p.y); g.acc.pos = P ? { x: Math.round(P.wx), y: Math.round(P.wy), h: 0, dk: P.id, hpf: 1 } : null; }   // příště začne zakotvený v nejbližším přístavu
    if (c.acc && c.acc !== g.acc) { const s = SHIPS[g.p.id | 0]; const gg = Math.round(R.pvpBase + (s ? s.hull : 200) * R.pvpHull); c.acc.rl = c.acc.rl || {};
      if (now - (c.acc.rl.pvp || 0) > 5000) { c.acc.rl.pvp = now; c.acc.gold += gg; c.acc.kills = (c.acc.kills || 0) + 1;
        for (const [kws, kc] of clients) if (kc === c) send(kws, { t: 'gold', gold: Math.floor(c.acc.gold), got: gg }); } }
    save(); }
  broadcast({ t: 'p', peer: g.peer, p: g.p });
}
setInterval(() => { const now = Date.now(); for (const [gp, g] of ghosts) if (now > g.until) { ghosts.delete(gp); ghostSavePos(g); broadcast({ t: 'left', peer: gp }); } }, 500);
process.on('SIGTERM', () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {} process.exit(0); });

grantGold();
server.listen(PORT, () => console.log('Sedm moří běží na portu ' + PORT + ' · účty: ' + DB_FILE));
