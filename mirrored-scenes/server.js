// server.js — Fog of War v6.2
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const chokidar = require('chokidar');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

function resolvePort() {
  const a = process.argv.find(x=>x.startsWith('--port='));
  if (a) { const v = parseInt(a.split('=')[1],10); if (v>0&&v<65536) return v; }
  const i = process.argv.indexOf('-p'); if (i>-1 && process.argv[i+1]) { const v=parseInt(process.argv[i+1],10); if (v>0&&v<65536) return v; }
  const e = parseInt(process.env.PORT||'',10); if (e>0&&e<65536) return e;
  return 5000;
}

const ROOT = __dirname;
const PUBLIC_BASE = '/scenes';
const IMG_PATH = path.join(ROOT, 'current-scene.webp');
const COMBAT_PATH = path.join(ROOT, 'combat.json');
const STATE_DIR = path.join(ROOT, '.fow');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, {recursive:true});

const app = express();
app.use(bodyParser.json({limit:'2mb'}));
app.use(PUBLIC_BASE, express.static(ROOT, {extensions:['html']}));

let currentHash = hashFileIfExists(IMG_PATH);
let state = loadState(currentHash);
let grid = loadJSON(path.join(STATE_DIR,'grid.json'), {show:true});
// Config only stores grid sizes; player/GM stage auto-fit to viewport
let config = loadJSON(path.join(STATE_DIR,'config.json'), {cols:19, rows:10, imgCols:19, imgRows:10});
let clock = loadJSON(path.join(STATE_DIR,'clock.json'), {running:true, elapsed:0, startAt: Date.now()});

// preference: should the clock auto-run after reset?
const CLOCK_PREFS_FILE = path.join(STATE_DIR,'clock_prefs.json');
let clockPrefs = loadJSON(CLOCK_PREFS_FILE, { resetRuns: true }); // default: auto-run after reset

let combat = loadCombat();

// ---- helpers
function hashFileIfExists(p) { try{ return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0,12); }catch{ return ''; } }
function loadJSON(p, d) { try{ return Object.assign({}, d, JSON.parse(fs.readFileSync(p,'utf8'))); }catch{ return d; } }
function saveJSON(p, v) { try{ fs.writeFileSync(p, JSON.stringify(v)); }catch{} }
function loadState(h) { const p=path.join(STATE_DIR,(h||'nohash')+'.json'); return loadJSON(p, {hidden:[], highlight:[], note:{visible:false,text:''}}); }
function saveState(h, v) { const p=path.join(STATE_DIR,(h||'nohash')+'.json'); saveJSON(p, v); }
function normalizeTurns(arr) {
  const out = (arr||[]).map((it,i)=>{
    if (!it || typeof it!=='object') return null;
    return {
      id: String(it.id||i), name: String(it.name||('Char '+(i+1))), 
      initiative: (typeof it.initiative==='number')? it.initiative : null,
      order: (typeof it.order==='number')? it.order : null,
      condition: String(it.condition||''), ac: (typeof it.ac==='number')? it.ac : null,
      hp: it.hp ?? null, hpMax: it.hpMax ?? null, active: !!it.active
    };
  }).filter(Boolean);
  out.sort((a,b)=> (a.order??1e9)-(b.order??1e9) || (b.initiative??-1e9)-(a.initiative??-1e9));
  out.forEach((t,i)=>{ if(t.order==null) t.order=i; });
  return out;
}
function loadCombat() {
  try {
    if (!fs.existsSync(COMBAT_PATH)) return {round:null,turnIndex:null,activeId:null,list:[]};
    const j = JSON.parse(fs.readFileSync(COMBAT_PATH,'utf8'));
    const list = normalizeTurns(j.turns||j.combat||[]);
    const turnIndex = Number.isInteger(j.turn)? j.turn : list.findIndex(t=>t.active);
    const activeId = (turnIndex>=0 && list[turnIndex])? list[turnIndex].id : (list.find(t=>t.active)?.id ?? null);
    const round = Number.isFinite(j.round)? j.round : null;
    return {round, turnIndex:(turnIndex>=0?turnIndex:null), activeId, list};
  } catch { return {round:null,turnIndex:null,activeId:null,list:[]}; }
}

// ---- routes
app.get(`${PUBLIC_BASE}/player.html`, (_req,res)=> res.sendFile(path.join(ROOT,'player.html')));
app.get(`${PUBLIC_BASE}/server.html`, (_req,res)=> res.sendFile(path.join(ROOT,'server.html')));
app.get(`${PUBLIC_BASE}/hash`, (_req,res)=> res.json({hash: currentHash}));
app.get(`${PUBLIC_BASE}/state`, (req,res)=> res.json(Object.assign({hash: currentHash}, state)));
app.put(`${PUBLIC_BASE}/state`, (req,res)=> {
  const ops = req.body?.ops || [];
  ops.forEach(op=>{
    const set = (op.mode==='highlight')? 'highlight' : 'hidden';
    if (op.type==='toggle' && op.key) {
      const i = (state[set]||[]).indexOf(op.key);
      if (i>=0) state[set].splice(i,1); else state[set].push(op.key);
    } else if (op.type==='clear') { state[set] = []; }
    else if (op.type==='set' && op.key) {
      const i = (state[set]||[]).indexOf(op.key);
      const want = !!op.value;
      if (want && i<0) state[set].push(op.key);
      if (!want && i>=0) state[set].splice(i,1);
    }
  });
  saveState(currentHash, state);
  bcast({type:'state', state});
  res.json({ok:true});
});

app.get(`${PUBLIC_BASE}/combat`, (_req,res)=> res.json(combat));

app.get(`${PUBLIC_BASE}/grid`, (_req,res)=> res.json(grid));
app.put(`${PUBLIC_BASE}/grid`, (req,res)=>{ grid.show = !!req.body?.show; saveJSON(path.join(STATE_DIR,'grid.json'), grid); bcast({type:'grid', show:grid.show}); res.json({ok:true}); });

app.get(`${PUBLIC_BASE}/config`, (_req,res)=> res.json(config));
app.put(`${PUBLIC_BASE}/config`, (req,res)=>{ 
  // Update only provided keys
  const n = {...config};
  if (req.body && 'cols' in req.body) n.cols = Math.max(1, parseInt(req.body.cols,10));
  if ('rows' in req.body) n.rows = Math.max(1, parseInt(req.body.rows,10));
  if ('imgCols' in req.body) n.imgCols = Math.max(1, parseInt(req.body.imgCols,10));
  if ('imgRows' in req.body) n.imgRows = Math.max(1, parseInt(req.body.imgRows,10));
  config = n; saveJSON(path.join(STATE_DIR,'config.json'), config);
  bcast({type:'config', config}); res.json({ok:true, config});
});

// clock (server-authoritative for pause/reset)
app.get(`${PUBLIC_BASE}/clock`, (_req,res)=> res.json({serverTime: Date.now(), clock}));
app.put(`${PUBLIC_BASE}/clock`, (req,res)=>{
  const action = req.body?.action;
  const now = Date.now();
  if (action==='reset') {
    clock.elapsed = 0;
    clock.startAt = now;
    clock.running = !!clockPrefs.resetRuns;
  } else if (action==='pause') { if (clock.running) { clock.elapsed += (now - (clock.startAt||now)); clock.running=false; } }
  else if (action==='resume') { if (!clock.running) { clock.running=true; clock.startAt=now; } }
  else if (action==='toggle') { if (clock.running) { clock.elapsed += (now - (clock.startAt||now)); clock.running=false; } else { clock.running=true; clock.startAt=now; } }
  else return res.status(400).json({error:'action must be pause|resume|toggle|reset'});
  saveJSON(path.join(STATE_DIR,'clock.json'), clock);
  const payload = {type:'clock', serverTime: now, clock}; bcast(payload);
  res.json({ok:true, ...payload});
});

// clock preferences
app.get(`${PUBLIC_BASE}/clockprefs`, (_req,res)=> res.json(clockPrefs));
app.put(`${PUBLIC_BASE}/clockprefs`, (req,res)=>{
  clockPrefs.resetRuns = !!req.body?.resetRuns;
  saveJSON(CLOCK_PREFS_FILE, clockPrefs);
  res.json({ok:true, ...clockPrefs});
});

// ---- ws
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: `${PUBLIC_BASE}/ws` });
function bcast(obj) { const m=JSON.stringify(obj); wss.clients.forEach(c=>{ if(c.readyState===WebSocket.OPEN) c.send(m); }); }

chokidar.watch(IMG_PATH, {ignoreInitial:true}).on('all', ()=>{
  const h = hashFileIfExists(IMG_PATH);
  if (h && h!==currentHash) { currentHash=h; state = loadState(currentHash); bcast({type:'hash', hash:h}); }
  else { bcast({type:'refresh'}); }
});

let lastActive = combat.activeId || null;
chokidar.watch(COMBAT_PATH, {ignoreInitial:true}).on('all', ()=>{
  combat = loadCombat();
  const newActive = combat.activeId || null;
  if (newActive !== lastActive) { lastActive = newActive; clock = {running: !!clockPrefs.resetRuns, elapsed:0, startAt: Date.now()}; saveJSON(path.join(STATE_DIR,'clock.json'), clock); }
  bcast({type:'combat', combat});
  bcast({type:'clock', serverTime: Date.now(), clock});
});

const PORT = resolvePort();
server.listen(PORT, ()=>{
  console.log(`Fog of War v6.2 on http://localhost:${PORT}${PUBLIC_BASE}`);
});
