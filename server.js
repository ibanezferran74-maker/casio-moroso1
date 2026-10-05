// Casino Moroso — servidor de salas en tiempo real.
// Sirve la página del juego y mantiene, por websockets, un pequeño almacén de
// documentos (salas y jugadores) más la presencia y los mensajes de cada sala.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const MAX_DOCS = 20000;
const MAX_DOC_BYTES = 64 * 1024;
const ROOM_TTL_MS = 3 * 24 * 3600 * 1000;

/* ---------------- almacén ---------------- */
let store = {};
try { store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {}; } catch { store = {}; }
let dirty = false;
setInterval(() => {
  if (!dirty) return; dirty = false;
  fs.writeFile(DATA_FILE, JSON.stringify(store), err => { if (err) console.warn('No se pudo guardar data.json:', err.message); });
}, 5000);
setInterval(() => { // borra salas viejas y sus jugadores
  const now = Date.now(); let n = 0;
  for (const p of Object.keys(store)) {
    const seg = p.split('/');
    if (seg[0] === 'rooms' && seg.length === 2 && now - (store[p].createdAt || 0) > ROOM_TTL_MS) {
      for (const q of Object.keys(store)) if (q === p || q.startsWith(p + '/')) { delete store[q]; n++; }
    }
  }
  if (n) { dirty = true; console.log(`Limpieza: ${n} documentos antiguos borrados`); }
}, 3600 * 1000);

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function validPath(p, wantDoc) {
  if (typeof p !== 'string' || p.length > 1000) return false;
  const s = p.split('/'); if (s.length > 16 || !s.every(x => SEG.test(x) && x !== '.' && x !== '..')) return false;
  return wantDoc ? s.length % 2 === 0 : s.length % 2 === 1;
}
const parentOf = p => p.split('/').slice(0, -1).join('/');
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(a, b) { const out = Object.assign({}, a); for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v; return out; }
function docSnap(p) { return { id: p.split('/').pop(), exists: p in store, data: p in store ? store[p] : undefined }; }
function query(col, o = {}) {
  let ds = Object.keys(store).filter(k => parentOf(k) === col).map(docSnap);
  if (Array.isArray(o.where)) for (const [f, op, v] of o.where) ds = ds.filter(d => { const x = d.data[f]; return op === '==' ? x === v : op === '!=' ? x !== v : op === '<' ? x < v : op === '<=' ? x <= v : op === '>' ? x > v : op === '>=' ? x >= v : true; });
  if (o.orderBy) { const f = o.orderBy, dir = o.dir === 'desc' ? -1 : 1; ds.sort((a, b) => { const x = a.data[f], y = b.data[f]; if (x === y) return 0; if (x === undefined) return 1; if (y === undefined) return -1; return (x < y ? -1 : 1) * dir; }); }
  else ds.sort((a, b) => a.id < b.id ? -1 : 1);
  if (o.limit) ds = ds.slice(0, Math.min(1000, o.limit));
  return ds;
}

/* ---------------- clientes ---------------- */
const clients = new Set();
const leases = new Map();
const rooms = new Map(); // nombre -> Map(ws -> {presence, updatedAt})
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };

function notify(p) {
  const parent = parentOf(p);
  for (const ws of clients) for (const [sid, s] of ws.subs) {
    if (s.kind === 'doc' && s.path === p) send(ws, { t: 'snap', sid, doc: docSnap(p) });
    else if (s.kind === 'col' && s.path === parent) send(ws, { t: 'snap', sid, docs: query(s.path, s.o) });
  }
}
function peersOf(name) {
  const r = rooms.get(name); if (!r) return [];
  return [...r.entries()].map(([ws, st]) => ({ peer: ws.peer, by: ws.uid || null, presence: st.presence, updatedAt: st.updatedAt }));
}
const pending = new Map();
function broadcastPeers(name) { // como mucho ~16 veces por segundo por sala
  if (pending.has(name)) return;
  pending.set(name, setTimeout(() => {
    pending.delete(name); const r = rooms.get(name); if (!r) return;
    const peers = peersOf(name); for (const ws of r.keys()) send(ws, { t: 'peers', room: name, peers });
  }, 60));
}
function leaveRoom(ws, name) {
  const r = rooms.get(name); if (!r) return; r.delete(ws);
  if (!r.size) rooms.delete(name); else broadcastPeers(name);
}

function handle(ws, m) {
  const ok = (data) => send(ws, { t: 'res', id: m.id, ok: true, data });
  const fail = (code, message) => send(ws, { t: 'res', id: m.id, ok: false, code, message });
  switch (m.t) {
    case 'hello':
      if (typeof m.uid === 'string' && /^u_[a-z0-9]{6,40}$/.test(m.uid)) ws.uid = m.uid;
      return send(ws, { t: 'welcome', peer: ws.peer });
    case 'get': if (!validPath(m.path, true)) return fail('invalid_argument', 'ruta'); return ok(docSnap(m.path));
    case 'query': if (!validPath(m.path, false)) return fail('invalid_argument', 'ruta'); return ok(query(m.path, m.o));
    case 'set': case 'update': {
      if (!validPath(m.path, true) || !isObj(m.data)) return fail('invalid_argument', 'datos');
      if (m.t === 'update' && !(m.path in store)) return fail('invalid_argument', 'no existe');
      if (!(m.path in store) && Object.keys(store).length >= MAX_DOCS) return fail('quota_exceeded', 'lleno');
      const next = m.t === 'set' ? m.data : deepMerge(store[m.path], m.data);
      if (JSON.stringify(next).length > MAX_DOC_BYTES) return fail('invalid_argument', 'demasiado grande');
      store[m.path] = next; dirty = true; ok(); return notify(m.path);
    }
    case 'delete': if (!validPath(m.path, true)) return fail('invalid_argument', 'ruta'); delete store[m.path]; dirty = true; ok(); return notify(m.path);
    case 'acquire': {
      if (!validPath(m.path, true)) return fail('invalid_argument', 'ruta');
      const now = Date.now(), l = leases.get(m.path), ttl = Math.max(1000, Math.min(600000, +m.ttlMs || 30000));
      if (l && l.exp > now && l.holder !== m.holder) return ok({ acquired: false, expiresAt: new Date(l.exp).toISOString() });
      leases.set(m.path, { holder: String(m.holder), exp: now + ttl }); return ok({ acquired: true, holder: m.holder });
    }
    case 'sub':
      if (!validPath(m.path, m.kind === 'doc')) return send(ws, { t: 'suberr', sid: m.sid, code: 'invalid_argument' });
      ws.subs.set(m.sid, { kind: m.kind, path: m.path, o: m.o || {} });
      return send(ws, m.kind === 'doc' ? { t: 'snap', sid: m.sid, doc: docSnap(m.path) } : { t: 'snap', sid: m.sid, docs: query(m.path, m.o) });
    case 'unsub': ws.subs.delete(m.sid); return;
    case 'join': {
      const name = String(m.room || ''); if (!/^[a-z0-9_][a-z0-9_.-]{0,47}$/.test(name)) return fail('invalid_argument', 'sala');
      if (!rooms.has(name)) rooms.set(name, new Map());
      const r = rooms.get(name); if (!r.has(ws)) r.set(ws, { presence: {}, updatedAt: Date.now() });
      ws.rooms.add(name); ok(); return broadcastPeers(name);
    }
    case 'leave': ws.rooms.delete(m.room); leaveRoom(ws, m.room); return ok();
    case 'presence': {
      const r = rooms.get(m.room); const st = r && r.get(ws); if (!st || !isObj(m.patch)) return;
      const next = Object.assign({}, st.presence); for (const [k, v] of Object.entries(m.patch)) { if (v === null) delete next[k]; else next[k] = v; }
      if (JSON.stringify(next).length > 4096) return;
      st.presence = next; st.updatedAt = Date.now(); return broadcastPeers(m.room);
    }
    case 'emit': {
      const r = rooms.get(m.room); if (!r || !r.has(ws) || typeof m.topic !== 'string') return;
      if (JSON.stringify(m.data ?? null).length > 4096) return;
      for (const other of r.keys()) send(other, { t: 'msg', room: m.room, topic: m.topic, data: m.data, peer: ws.peer, by: ws.uid || null });
      return;
    }
  }
}

/* ---------------- http + ws ---------------- */
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url !== '/' && url !== '/index.html') { res.writeHead(302, { Location: '/' }); return res.end(); }
  fs.readFile(INDEX_PATH, (err, buf) => {
    if (err) { res.writeHead(500); return res.end('Falta public/index.html'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(buf);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 128 * 1024 });
wss.on('connection', ws => {
  ws.peer = crypto.randomBytes(8).toString('hex'); ws.subs = new Map(); ws.rooms = new Set(); ws.alive = true;
  clients.add(ws);
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } try { handle(ws, m); } catch (e) { console.warn(e); } });
  ws.on('close', () => { clients.delete(ws); for (const r of ws.rooms) leaveRoom(ws, r); });
});
setInterval(() => { for (const ws of clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch { } } }, 25000);
server.listen(PORT, () => console.log(`Casino Moroso escuchando en el puerto ${PORT}`));
