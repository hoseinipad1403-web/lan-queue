
// LAN Queue v12 (Railway-ready) - Node (no external deps)
const http = require('http');
const url  = require('url');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const DATA_FILE  = path.join(__dirname, 'tickets.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

function send(res, code, obj, headers={}){
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function readJSON(file, fallback){ try{ return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJSON(file, obj){ fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8'); }
function parseBody(req){
  return new Promise((resolve, reject)=>{
    let d=''; req.on('data', c=> d+=c);
    req.on('end', ()=> { try{ resolve(d? JSON.parse(d) : {});} catch(e){ reject(e);} });
  });
}

// Jalali helpers
function toJalali(gy, gm, gd){
  const gdm=[0,31,59,90,120,151,181,212,243,273,304,334];
  const gy2 = gm>2 ? gy+1 : gy;
  let days = 355666 + 365*gy + Math.floor((gy2+3)/4) - Math.floor((gy2+99)/100) + Math.floor((gy2+399)/400) + gd + gdm[gm-1];
  let jy = -1595 + 33*Math.floor(days/12053); days %= 12053;
  jy += 4*Math.floor(days/1461); days %= 1461;
  if(days>365){ jy += Math.floor((days-1)/365); days=(days-1)%365; }
  const jm = (days<186) ? 1+Math.floor(days/31) : 7+Math.floor((days-186)/30);
  const jd = 1 + ((days<186) ? (days%31) : ((days-186)%30));
  return {jy, jm, jd};
}
function todayJalali(){
  const n = new Date(); const j = toJalali(n.getFullYear(), n.getMonth()+1, n.getDate());
  const p=n=>String(n).padStart(2,'0'); return `${j.jy}/${p(j.jm)}/${p(j.jd)}`;
}
function nowHM(){ const n=new Date(); const p=n=>String(n).padStart(2,'0'); return `${p(n.getHours())}:${p(n.getMinutes())}`; }
function todayKeyGregorian(){ const n=new Date(); const p=n=>String(n).padStart(2,'0'); return `${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}`; }
function findLatestByPhone(db, phone, pred){ for(let i=db.tickets.length-1;i>=0;i--){ const t=db.tickets[i]; if(t.phone===phone && (!pred || pred(t))) return t; } return null; }
function toCSV(rows){
  const headers=["number","phone","date_jalali","created_time","created_by","photo_number","photo_registered_date","photo_registered_time","photo_registered_by","photo_printed_date","photo_printed_time","photo_printed_by"];
  const esc = s => `"${String(s??'').replace(/"/g,'""')}"`;
  return [headers.join(','), ...rows.map(r=> headers.map(h=>esc(r[h])).join(','))].join('\r\n');
}
function toXML(rows){
  const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  const items = rows.map(r => [
    '  <ticket>',
    `    <number>${esc(r.number)}</number>`,
    `    <mobile>${esc(r.phone)}</mobile>`,
    `    <date>${esc(r.date_jalali)}</date>`,
    `    <created_time>${esc(r.created_time||'')}</created_time>`,
    `    <created_by>${esc(r.created_by||'')}</created_by>`,
    `    <photo_number>${esc(r.photo_number||'')}</photo_number>`,
    `    <photo_registered_date>${esc(r.photo_registered_date||'')}</photo_registered_date>`,
    `    <photo_registered_time>${esc(r.photo_registered_time||'')}</photo_registered_time>`,
    `    <photo_registered_by>${esc(r.photo_registered_by||'')}</photo_registered_by>`,
    `    <photo_printed_date>${esc(r.photo_printed_date||'')}</photo_printed_date>`,
    `    <photo_printed_time>${esc(r.photo_printed_time||'')}</photo_printed_time>`,
    `    <photo_printed_by>${esc(r.photo_printed_by||'')}</photo_printed_by>`,
    '  </ticket>'
  ].join('\n')).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tickets>\n${items}\n</tickets>\n`;
}

// sessions
const sessions = {}; // sid -> {username, display, is_admin, ts}
function newToken(){ return crypto.randomBytes(24).toString('hex'); }
function parseCookies(req){
  const hdr = req.headers.cookie || ''; const map={};
  hdr.split(';').forEach(p=>{ const i=p.indexOf('='); if(i>0){ map[p.slice(0,i).trim()] = decodeURIComponent(p.slice(i+1)); }});
  return map;
}
function requireAuth(req, res, adminOnly=false){
  const c = parseCookies(req); const sid = c.sid;
  if(!sid || !sessions[sid]){ send(res, 401, {error:'unauthorized'}); return null; }
  if(adminOnly && !sessions[sid].is_admin){ send(res, 403, {error:'forbidden'}); return null; }
  return sessions[sid];
}

// bootstrap files
if(!fs.existsSync(DATA_FILE)) writeJSON(DATA_FILE, {counters:{}, tickets:[]});
if(!fs.existsSync(USERS_FILE)) writeJSON(USERS_FILE, [
  {"username":"admin","password":"1234","display":"مدیر اصلی","is_admin":true},
  {"username":"ali","password":"2222","display":"علی احمدی","is_admin":false},
  {"username":"sara","password":"3333","display":"سارا محمدی","is_admin":false},
  {"username":"reza","password":"4444","display":"رضا راد","is_admin":false},
  {"username":"mina","password":"5555","display":"مینا موسوی","is_admin":false}
]);

const server = http.createServer(async (req, res)=>{
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';
  const method = req.method;

  if (req.headers.origin){
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials','true');
  }
  if (method==='OPTIONS'){ res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS,PUT,DELETE'); res.setHeader('Access-Control-Allow-Headers','Content-Type'); res.writeHead(204); return res.end(); }

  // auth
  if(method==='POST' && pathname==='/login'){
    const {username,password} = await parseBody(req);
    const users = readJSON(USERS_FILE, []);
    const u = users.find(x=>x.username===username && x.password===password);
    if(!u) return send(res, 401, {error:'bad credentials'});
    const sid = newToken();
    sessions[sid] = { username:u.username, display:u.display, is_admin:!!u.is_admin, ts:Date.now() };
    return send(res, 200, {ok:true, user:{username:u.username, display:u.display, is_admin:!!u.is_admin}}, {'Set-Cookie':`sid=${encodeURIComponent(sid)}; Path=/; HttpOnly`});
  }
  if(method==='POST' && pathname==='/logout'){
    const c=parseCookies(req); if(c.sid) delete sessions[c.sid];
    return send(res, 200, {ok:true}, {'Set-Cookie':'sid=; Max-Age=0; Path=/'});
  }

  // user management (admin)
  if(pathname==='/users'){
    if(method==='GET'){
      const a = requireAuth(req,res,true); if(!a) return;
      const users = readJSON(USERS_FILE, []);
      return send(res, 200, users.map(u=>({username:u.username, display:u.display, is_admin:!!u.is_admin})));
    }
    if(method==='POST'){
      const a = requireAuth(req,res,true); if(!a) return;
      const {username,password,display,is_admin} = await parseBody(req);
      if(!username || !password) return send(res,400,{error:'username & password required'});
      const users = readJSON(USERS_FILE, []);
      if(users.find(u=>u.username===username)) return send(res,409,{error:'exists'});
      users.push({username,password,display:display||username,is_admin:!!is_admin});
      writeJSON(USERS_FILE, users);
      return send(res,200,{ok:true});
    }
    if(method==='PUT'){
      const a = requireAuth(req,res,true); if(!a) return;
      const {username,password,display,is_admin} = await parseBody(req);
      const users = readJSON(USERS_FILE, []);
      const u = users.find(x=>x.username===username);
      if(!u) return send(res,404,{error:'not found'});
      if(password) u.password = password;
      if(typeof display==='string') u.display = display;
      if(typeof is_admin==='boolean') u.is_admin = is_admin;
      writeJSON(USERS_FILE, users);
      return send(res,200,{ok:true});
    }
    if(method==='DELETE'){
      const a = requireAuth(req,res,true); if(!a) return;
      const {username} = await parseBody(req);
      if(username==='admin') return send(res,400,{error:'cannot delete admin'});
      let users = readJSON(USERS_FILE, []);
      users = users.filter(u=>u.username!==username);
      writeJSON(USERS_FILE, users);
      return send(res,200,{ok:true});
    }
  }

  // tickets
  if(method==='POST' && pathname==='/issue'){
    const a=requireAuth(req,res); if(!a) return;
    const {phone} = await parseBody(req);
    if(!phone) return send(res,400,{error:'phone required'});
    const db = readJSON(DATA_FILE, {counters:{}, tickets:[]});
    const jdate = todayJalali();
    const dup = [...db.tickets].reverse().find(t=> t.phone===phone && t.date_jalali===jdate);
    if(dup) return send(res, 200, { number:dup.number, date_jalali:dup.date_jalali, created_time:dup.created_time, duplicate:true });
    const key = todayKeyGregorian();
    const next = (db.counters[key]||0) + 1;
    db.counters[key] = next;
    const t = {
      phone, number: next, date_jalali: jdate,
      created_time: nowHM(), created_by: a.display,
      photo_number: null, photo_registered_date: null, photo_registered_time: null, photo_registered_by: null,
      photo_printed_date: null, photo_printed_time: null, photo_printed_by: null
    };
    db.tickets.push(t); writeJSON(DATA_FILE, db);
    return send(res,200,{number:t.number,date_jalali:t.date_jalali,created_time:t.created_time});
  }
  if(method==='POST' && pathname==='/photo-registered'){
    const a=requireAuth(req,res); if(!a) return;
    const {phone, photo_number} = await parseBody(req);
    if(!phone || !photo_number) return send(res,400,{error:'phone and photo_number required'});
    const db = readJSON(DATA_FILE, {counters:{}, tickets:[]});
    const t = findLatestByPhone(db, phone, x=> x.photo_registered_date===null);
    if(!t) return send(res,404,{error:'no pending ticket'});
    t.photo_number = String(photo_number);
    t.photo_registered_date = todayJalali();
    t.photo_registered_time = nowHM();
    t.photo_registered_by = a.display;
    writeJSON(DATA_FILE, db);
    return send(res,200,{number:t.number,date_jalali:t.photo_registered_date,time:t.photo_registered_time,photo_number:t.photo_number});
  }
  if(method==='POST' && pathname==='/photo-printed'){
    const a=requireAuth(req,res); if(!a) return;
    const {phone} = await parseBody(req);
    if(!phone) return send(res,400,{error:'phone required'});
    const db = readJSON(DATA_FILE, {counters:{}, tickets:[]});
    const t = findLatestByPhone(db, phone, x=> x.photo_registered_date && !x.photo_printed_date);
    if(!t) return send(res,404,{error:'no registered-but-unprinted ticket'});
    t.photo_printed_date = todayJalali();
    t.photo_printed_time = nowHM();
    t.photo_printed_by = a.display;
    writeJSON(DATA_FILE, db);
    return send(res,200,{number:t.number,date_jalali:t.photo_printed_date,time:t.photo_printed_time});
  }
  if(method==='GET' && pathname==='/ticket'){
    const a=requireAuth(req,res); if(!a) return;
    const num = parseInt((parsed.query.number||'').toString(),10);
    const db = readJSON(DATA_FILE, {counters:{}, tickets:[]});
    const t = db.tickets.find(x=> x.number===num);
    if(!t) return send(res,404,{error:'not found'});
    return send(res,200,t);
  }
  if(method==='GET' && pathname==='/list'){
    const a=requireAuth(req,res); if(!a) return;
    const date = (parsed.query.date||'').toString().trim();
    const db = readJSON(DATA_FILE, {counters:{}, tickets:[]});
    const rows = db.tickets.filter(t=> !date || t.date_jalali===date);
    return send(res,200,rows);
  }
  if(method==='GET' && pathname==='/csv'){
    const a=requireAuth(req,res); if(!a) return;
    const date = (parsed.query.date||'').toString().trim();
    const db = readJSON(DATA_FILE, {counters:{}, tickets:[]});
    const rows = db.tickets.filter(t=> !date || t.date_jalali===date);
    const csv = rows.length? toCSV(rows) : 'number,phone,date_jalali,created_time,created_by,photo_number,photo_registered_date,photo_registered_time,photo_registered_by,photo_printed_date,photo_printed_time,photo_printed_by\r\n';
    return send(res,200,csv,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="tickets.csv"'});
  }
  if(method==='GET' && pathname==='/xml'){
    const a=requireAuth(req,res); if(!a) return;
    const date = (parsed.query.date||'').toString().trim();
    const db = readJSON(DATA_FILE, {counters:{}, tickets:[]});
    const rows = db.tickets.filter(t=> !date || t.date_jalali===date);
    const xml = toXML(rows);
    return send(res,200,xml,{'Content-Type':'application/xml; charset=utf-8','Content-Disposition':'attachment; filename="tickets.xml"'});
  }
  if(method==='GET' && pathname==='/stats'){
    const a=requireAuth(req,res); if(!a) return;
    const from = (parsed.query.from||'').toString().trim();
    const to   = (parsed.query.to||'').toString().trim();
    const db = readJSON(DATA_FILE, {counters:{}, tickets:[]});
    const inRange = t=>{
      if(!from && !to) return true;
      if(from && t.date_jalali < from) return false;
      if(to   && t.date_jalali > to)   return false;
      return true;
    };
    const rows = db.tickets.filter(inRange);
    const countIssue = rows.length;
    const countPhoto = rows.filter(t=> t.photo_registered_date).length;
    const countPrint = rows.filter(t=> t.photo_printed_date).length;
    return send(res,200,{from, to, countIssue, countPhoto, countPrint});
  }

  // static
  if(method==='GET'){
    const file = pathname === '/' ? '/index.html' : pathname;
    const fp = path.join(PUBLIC_DIR, file);
    if(!fp.startsWith(PUBLIC_DIR)) return send(res,403,'Forbidden');
    fs.stat(fp, (err, st)=>{
      if(err || !st.isFile()) return send(res,404,'Not Found');
      const ext = path.extname(fp).toLowerCase();
      const types = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
      res.writeHead(200, {'Content-Type': types[ext] || 'application/octet-stream'});
      fs.createReadStream(fp).pipe(res);
    });
    return;
  }

  send(res,404,'Not Found');
});

server.listen(PORT, HOST, ()=> console.log(`LAN Queue v12 (Railway) on http://${HOST}:${PORT}`));
