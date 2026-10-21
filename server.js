const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {WebSocketServer}=require('ws');
/* ---------- config (set these in Render > Environment) ---------- */
const SB_URL=(process.env.SUPABASE_URL||'').replace(/\/+$/,''),SB_KEY=process.env.SUPABASE_KEY||'';
const ACC=!!(SB_URL&&SB_KEY);
const SECRET=process.env.TOKEN_SECRET||crypto.createHash('sha256').update('awd|'+SB_KEY).digest('hex');
const CODES={FRTCDE123067:1000};
(process.env.CODES||'').split(',').forEach(p=>{const a=p.trim().split(':'),c=(a[0]||'').toUpperCase(),n=+a[1];if(/^[A-Z0-9_]{1,24}$/.test(c)&&n>0)CODES[c]=n});
const SPECIAL={'20FSFFNB10_10':'rareSkin'};
const PRICE=[0,25,40];
const normU=x=>String(x||'').trim().normalize('NFKC');
const okUser=x=>{const n=Array.from(x).length;return n>=3&&n<=16&&/^[\p{L}\p{N}_]+$/u.test(x)};
/* ---------- static files ---------- */
const TYPES={'.html':'text/html; charset=utf-8','.json':'application/json','.png':'image/png'};
const SAFE=/^(index|game-[A-Za-z0-9_.-]+)\.html$|^(manifest\.json|icon-(192|512)\.png)$/;
function latest(){try{const g=fs.readdirSync(__dirname).filter(f=>/^game-[A-Za-z0-9_.-]+\.html$/.test(f)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));return g.length?g[g.length-1]:'index.html'}catch(e){return 'index.html'}}
function find(n){for(const d of [__dirname,path.join(__dirname,'public')]){const f=path.join(d,n);if(fs.existsSync(f))return f}return null}
/* ---------- database (Supabase REST, table "players") ---------- */
async function sb(method,qs,body){
  const h={apikey:SB_KEY,'Content-Type':'application/json',Prefer:'return=representation'};
  if(/^eyJ/.test(SB_KEY))h.Authorization='Bearer '+SB_KEY; /* new sb_secret_ keys go in "apikey" only */
  const r=await fetch(SB_URL+'/rest/v1/players'+qs,{method,headers:h,body:body?JSON.stringify(body):undefined});
  const t=await r.text();let j=null;try{j=t?JSON.parse(t):null}catch(e){}
  if(!r.ok){const e=new Error('db '+r.status);e.status=r.status;e.detail=String((j&&(j.message||j.hint||j.error))||t||'').slice(0,160);console.log('supabase error',method,r.status,e.detail);throw e}
  return j;
}
async function getUser(u){const a=await sb('GET','?username=eq.'+encodeURIComponent(u)+'&select=*');return a&&a[0]||null}
async function patchUser(u,o){const a=await sb('PATCH','?username=eq.'+encodeURIComponent(u),o);return a&&a[0]||null}
const locks=new Map();
function withLock(u,fn){const p=(locks.get(u)||Promise.resolve()).then(fn,fn);locks.set(u,p.catch(()=>{}));return p}
function pub(r){return{u:r.display||r.username,k:r.username,coins:r.coins|0,own:r.own||{},eq:r.eq||{},friends:Array.isArray(r.friends)?r.friends:[],wins:r.wins|0,losses:r.losses|0,chars:(r.chars&&typeof r.chars==='object')?r.chars:{}}}
/* ---------- passwords + tokens ---------- */
function hashPw(p,salt){salt=salt||crypto.randomBytes(16).toString('hex');return new Promise((res,rej)=>crypto.scrypt(p,salt,32,(e,k)=>e?rej(e):res(salt+':'+k.toString('hex'))))}
async function checkPw(p,stored){try{const salt=String(stored).split(':')[0],x=await hashPw(p,salt);return x.length===stored.length&&crypto.timingSafeEqual(Buffer.from(x),Buffer.from(stored))}catch(e){return false}}
function mkTok(u,d){const b=Buffer.from(JSON.stringify({u,d,exp:Date.now()+30*864e5})).toString('base64url');return b+'.'+crypto.createHmac('sha256',SECRET).update(b).digest('base64url')}
function vfTok(t){try{const [b,s]=String(t).split('.'),e=crypto.createHmac('sha256',SECRET).update(b).digest('base64url');if(!s||s.length!==e.length||!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(e)))return null;const o=JSON.parse(Buffer.from(b,'base64url'));return o.exp>Date.now()&&o.u?{u:o.u,d:o.d||o.u}:null}catch(e){return null}}
/* ---------- rate limits ---------- */
function lim(map,key,max,win){const n=Date.now(),a=(map.get(key)||[]).filter(t=>n-t<win);a.push(n);map.set(key,a);return a.length>max}
const limLogin=new Map(),limReg=new Map(),limApi=new Map(),pairHits=new Map(),dayHits=new Map();
setInterval(()=>{const n=Date.now();for(const m of [limLogin,limReg,limApi,pairHits]){for(const [k,a] of m){if(!a.some(t=>n-t<3600000))m.delete(k)}}dayHits.clear()},864e5/4);
function ipOf(req){return((req.headers['x-forwarded-for']||'').split(',')[0].trim())||req.socket.remoteAddress}
/* ---------- import of an old local wallet (first registration only) ---------- */
function cleanImp(im){const o={coins:0,own:{},eq:{},codes:{}};if(!im||typeof im!=='object')return o;
  o.coins=Math.max(0,Math.min(1100,(+im.coins|0)||0));
  if(im.own&&typeof im.own==='object')for(const k of Object.keys(im.own)){const m=/^(\d)_([12])$/.exec(k);if(m&&im.own[k])o.own[k]=1}
  if(im.eq&&typeof im.eq==='object')for(const k of Object.keys(im.eq)){const ch=+k,s=im.eq[k]|0;if(ch>=0&&ch<10&&(s===0||o.own[ch+'_'+s]))o.eq[ch]=s}
  if(im.codes&&typeof im.codes==='object')for(const k of Object.keys(im.codes)){const c=String(k).toUpperCase();if(CODES[c])o.codes[c]=1}
  return o}
/* ---------- JSON API ---------- */
function api(req,res,route){
  const send=(c,o)=>{res.writeHead(c,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(o))};
  if(route==='health'){
    if(!ACC)return send(200,{accounts:false,why:'SUPABASE_URL or SUPABASE_KEY is missing'});
    return sb('GET','?select=username&limit=1').then(()=>send(200,{accounts:true,db:'ok'}),e=>send(200,{accounts:true,db:'fail',status:e.status||0,detail:e.detail||String(e.message).slice(0,120)}));
  }
  if(req.method!=='POST')return send(405,{err:'method'});
  if(!ACC)return send(503,{err:'cfg'});
  let b='';req.on('data',d=>{b+=d;if(b.length>8192)req.destroy()});
  req.on('end',async()=>{
    let j={};try{j=JSON.parse(b||'{}')}catch(e){return send(400,{err:'json'})}
    try{
      const ip=ipOf(req);if(lim(limApi,ip,150,60000))return send(429,{err:'rate'});
      if(route==='register'){
        if(lim(limReg,ip,30,3600000))return send(429,{err:'rate'});
        const u=normU(j.u),pw=String(j.p||'');
        if(!okUser(u))return send(400,{err:'user'});
        if(pw.length<4||pw.length>64)return send(400,{err:'pass'});
        const key=u.toLowerCase();if(await getUser(key))return send(409,{err:'taken'});
        const imp=cleanImp(j.imp),hp=await hashPw(pw);let row;
        try{const a=await sb('POST','',{username:key,display:u,pass:hp,coins:imp.coins,own:imp.own,eq:imp.eq,codes:imp.codes,friends:[],wins:0,losses:0});row=a&&a[0]}catch(e){if(e.status===409)return send(409,{err:'taken'});throw e}
        return send(200,{ok:1,token:mkTok(key,u),me:pub(row)});
      }
      if(route==='login'){
        if(lim(limLogin,ip,40,60000))return send(429,{err:'rate'});
        const u=normU(j.u).toLowerCase(),r=okUser(u)?await getUser(u):null;
        if(!r||!(await checkPw(String(j.p||''),r.pass)))return send(401,{err:'bad'});
        return send(200,{ok:1,token:mkTok(u,r.display||u),me:pub(r)});
      }
      const who=vfTok(String(req.headers.authorization||'').replace(/^Bearer\s+/i,''));if(!who)return send(401,{err:'auth'});const uid=who.u;
      if(route==='me'){const r=await getUser(uid);if(!r)return send(401,{err:'auth'});return send(200,{ok:1,me:pub(r)})}
      if(route==='top'){
        const now=Date.now();
        if(!topCache.rows||now-topCache.t>30000){const a=await sb('GET','?select=username,display,wins,losses&wins=gt.0&order=wins.desc,losses.asc&limit=20');topCache={t:now,rows:a||[]}}
        const r=await getUser(uid);let rank=0;
        if(r&&(r.wins|0)>0){const a=await sb('GET','?select=username&wins=gt.'+(r.wins|0)+'&limit=1000');rank=(a?a.length:0)+1}
        return send(200,{ok:1,rows:topCache.rows.map((x,i)=>({r:i+1,u:x.display||x.username,k:x.username,w:x.wins|0,l:x.losses|0})),me:{rank,w:r?r.wins|0:0,l:r?r.losses|0:0}});
      }
      if(route==='friend'){
        const t=normU(j.u).toLowerCase(),del=j.a==='del';
        if(!okUser(t)||t===uid)return send(400,{err:'user'});
        const tr=await getUser(t);if(!del&&!tr)return send(200,{ok:0,err:'nf'});
        const res1=await withLock(uid,async()=>{const r=await getUser(uid);let f=Array.isArray(r.friends)?r.friends.slice():[];
          if(!del){if(f.includes(t))return{err:'dup',r};if(f.length>=100)return{err:'full',r};f.push(t)}else f=f.filter(x=>x!==t);return{r:await patchUser(uid,{friends:f})}});
        if(res1.err)return send(200,{ok:0,err:res1.err,me:pub(res1.r)});
        let tNew=null;if(tr)tNew=await withLock(t,async()=>{const r=await getUser(t);let f=Array.isArray(r.friends)?r.friends.slice():[];if(!del){if(!f.includes(uid))f.push(uid)}else f=f.filter(x=>x!==uid);return await patchUser(t,{friends:f})});
        {const x=users.get(uid);if(x)x.fr=new Set(res1.r.friends||[]);const y=users.get(t);if(y&&tNew)y.fr=new Set(tNew.friends||[])}
        if(!del)notify(t,{t:'added',from:uid,name:who.d});
        return send(200,{ok:1,me:pub(res1.r)});
      }
      return await withLock(uid,async()=>{
        const r=await getUser(uid);if(!r)return send(401,{err:'auth'});
        if(route==='buy'){const ch=j.ch|0,s=j.s|0;if(ch<0||ch>9||(s!==1&&s!==2))return send(400,{err:'arg'});
          const k=ch+'_'+s,own=r.own||{};if(own[k])return send(200,{ok:0,err:'owned',me:pub(r)});if((r.coins|0)<PRICE[s])return send(200,{ok:0,err:'poor',me:pub(r)});
          own[k]=1;const eq=r.eq||{};eq[ch]=s;const n=await patchUser(uid,{coins:(r.coins|0)-PRICE[s],own,eq});return send(200,{ok:1,me:pub(n)})}
        if(route==='equip'){const ch=j.ch|0,s=j.s|0;if(ch<0||ch>9||s<0||s>2)return send(400,{err:'arg'});const own=r.own||{};if(s>0&&!own[ch+'_'+s])return send(200,{ok:0,err:'notowned',me:pub(r)});
          const eq=r.eq||{};eq[ch]=s;const n=await patchUser(uid,{eq});return send(200,{ok:1,me:pub(n)})}
        if(route==='redeem'){const code=String(j.code||'').toUpperCase().replace(/[^A-Z0-9_]/g,'').slice(0,24),used=r.codes||{};
          if(SPECIAL[code]){
            if(used[code])return send(200,{ok:0,err:'used',me:pub(r)});
            const own=r.own||{},eq=r.eq||{},pool=[];for(let ch=0;ch<10;ch++)if(!own[ch+'_1'])pool.push(ch);
            used[code]=1;
            if(pool.length){const ch=pool[crypto.randomInt(pool.length)];own[ch+'_1']=1;if(!eq[ch])eq[ch]=1;const n=await patchUser(uid,{own,eq,codes:used});return send(200,{ok:1,special:1,kind:'skin',ch,s:1,me:pub(n)})}
            const n=await patchUser(uid,{coins:(r.coins|0)+25,codes:used});return send(200,{ok:1,special:1,kind:'coins',add:25,me:pub(n)});
          }
          const amt=code?CODES[code]:0;
          if(!amt)return send(200,{ok:0,err:'bad',me:pub(r)});if(used[code])return send(200,{ok:0,err:'used',me:pub(r)});
          used[code]=1;const n=await patchUser(uid,{coins:(r.coins|0)+amt,codes:used});return send(200,{ok:1,kind:'coins',add:amt,me:pub(n)})}
        return send(404,{err:'route'});
      });
    }catch(e){console.log('api error',route,e&&e.message,e&&e.detail||'');try{send(500,{err:'server'})}catch(x){}}
  });
}
const server=http.createServer((req,res)=>{
  const p0=req.url.split('?')[0];
  if(p0.startsWith('/api/'))return api(req,res,p0.slice(5));
  let p=decodeURIComponent(p0);
  const n=(p==='/'||p==='/index.html')?latest():p.slice(1);
  if(!SAFE.test(n)){res.writeHead(404);return res.end('Not found')}
  const f=find(n);
  if(!f){res.writeHead(404);return res.end('File missing: '+n)}
  fs.readFile(f,(e,d)=>{if(e){res.writeHead(500);return res.end('Error')}
    res.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(d)});
});
const wss=new WebSocketServer({noServer:true,maxPayload:4096});
const cws=new WebSocketServer({noServer:true,maxPayload:2048});
server.on('upgrade',(req,sock,head)=>{
  const p=req.url.split('?')[0];
  if(p==='/ws')wss.handleUpgrade(req,sock,head,ws=>wss.emit('connection',ws,req));
  else if(p==='/chat')cws.handleUpgrade(req,sock,head,ws=>cws.emit('connection',ws,req));
  else sock.destroy();
});
/* ---------- match rooms (+ server-side win detection) ---------- */
const rooms=new Map();
let topCache={t:0,rows:null};
async function award(wu,lu,wws,wch,lch){
  try{
    const pk=[wu,lu].sort().join('|'),day=new Date().toISOString().slice(0,10)+wu;
    if(lim(pairHits,pk,8,3600000))return;
    const dc=(dayHits.get(day)||0)+1;dayHits.set(day,dc);if(dc>60)return;
    const bump=(u,ch)=>{const c=Object.assign({},(u.chars&&typeof u.chars==='object')?u.chars:{});ch|=0;if(ch>=0&&ch<10)c[ch]=(c[ch]|0)+1;return c};
    const upd=(name,ch,fn)=>withLock(name,async()=>{const u=await getUser(name);if(!u)return null;const base=fn(u);
      try{return await patchUser(name,Object.assign({},base,{chars:bump(u,ch)}))}catch(e){if(e.status===400)return await patchUser(name,base);throw e}});
    const w=await upd(wu,wch,u=>({coins:(u.coins|0)+1,wins:(u.wins|0)+1}));
    await upd(lu,lch,u=>({losses:(u.losses|0)+1}));
    topCache.t=0;
    if(w&&wws&&wws.readyState===1)wws.send(JSON.stringify({t:'award',add:1,coins:w.coins|0}));
  }catch(e){console.log('award error',e&&e.message)}
}
function judge(set){
  if(!ACC)return;const a=[...set].filter(w=>w.user&&w.last&&w.last.g);if(a.length!==2)return;
  const hw=a.find(w=>w.last.host)||a[0],rounds=Math.max(1,Math.min(9,hw.last.rounds|0)),la=a[0].last.L|0,lb=a[1].last.L|0,sum=la+lb;
  if(sum<(set.lastSum||0))set.done=false;set.lastSum=sum;
  if(set.done||sum<rounds)return;set.done=true;
  if(la===lb||Date.now()-(set.since||0)<10000)return;
  const w=la<lb?a[0]:a[1],l=w===a[0]?a[1]:a[0];if(w.user===l.user)return;
  award(w.user,l.user,w,w.last.ch,l.last.ch);
}
wss.on('connection',(ws,req)=>{
  const q=new URL(req.url,'http://x').searchParams,room=(q.get('room')||'').toLowerCase();
  if(ACC){const o=vfTok(q.get('tok'));if(!o)return ws.close(1008);ws.user=o.u}
  if(!/^[a-z0-9]{2,20}$/.test(room)){return ws.close(1008)}
  let set=rooms.get(room);if(!set){set=new Set();rooms.set(room,set)}
  if(set.size>=2){return ws.close(1013)}
  set.add(ws);ws.alive=true;if(set.size===2){set.since=Date.now();set.done=false;set.lastSum=0}
  ws.on('pong',()=>{ws.alive=true});
  for(const o of set)if(o!==ws&&o.last)ws.send(JSON.stringify({t:'p',id:o.id,d:o.last}));
  ws.on('message',(raw)=>{
    let m;try{m=JSON.parse(raw)}catch(e){return}
    if(m.t!=='p'||typeof m.id!=='string'||m.id.length>20)return;
    ws.id=m.id;ws.last=m.d;
    const out=JSON.stringify({t:'p',id:m.id,d:m.d});
    for(const o of set)if(o!==ws&&o.readyState===1)o.send(out);
    judge(set);
  });
  ws.on('close',()=>{
    set.delete(ws);
    if(ws.id){const out=JSON.stringify({t:'l',id:ws.id});for(const o of set)if(o.readyState===1)o.send(out)}
    if(!set.size)rooms.delete(room);
  });
});
/* ---------- friends chat (needs a valid login token) ---------- */
const users=new Map();
function notify(u,o){const x=users.get(u);if(x&&x.ws.readyState===1)x.ws.send(JSON.stringify(o))}
cws.on('connection',ws=>{
  ws.alive=true;ws.hist=[];ws.on('pong',()=>{ws.alive=true});
  const send=o=>{if(ws.readyState===1)ws.send(JSON.stringify(o))};
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw)}catch(e){return}
    if(!m||typeof m.t!=='string')return;
    if(m.t==='hi'){
      const o=vfTok(m.tok);if(!o)return send({t:'err',auth:1});const id=o.u;
      if(ws.uid&&ws.uid!==id){const u=users.get(ws.uid);if(u&&u.ws===ws)users.delete(ws.uid)}
      const old=users.get(id);if(old&&old.ws!==ws)old.ws.close(4000);
      ws.uid=id;const ent={ws,name:o.d,id,fr:new Set()};users.set(id,ent);getUser(id).then(r=>{if(r&&Array.isArray(r.friends)&&users.get(id)===ent)ent.fr=new Set(r.friends)}).catch(()=>{});return send({t:'hi',ok:1});
    }
    if(!ws.uid)return;
    const now=Date.now();ws.hist=ws.hist.filter(t=>now-t<3000);
    if(ws.hist.length>=6){if(m.t==='msg')send({t:'err',cid:m.cid,rate:1});return}
    ws.hist.push(now);
    const me=users.get(ws.uid);if(!me)return;
    if(m.t==='who'){
      const on=(Array.isArray(m.ids)?m.ids:[]).slice(0,100).map(i=>String(i).toLowerCase()).filter(i=>me.fr.has(i)&&users.has(i)).map(i=>({id:i,name:users.get(i).name}));
      return send({t:'st',on});
    }
    const to=users.get(String(m.to||'').toLowerCase());
    if(m.t==='msg'){
      const text=String(m.text||'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,300);
      if(!text)return;
      if(!to||to.ws===ws||to.ws.readyState!==1||!me.fr.has(to.id)||!to.fr.has(ws.uid))return send({t:'err',cid:m.cid});
      to.ws.send(JSON.stringify({t:'msg',from:ws.uid,name:me.name,text,ts:now}));
      return send({t:'ack',cid:m.cid});
    }
  });
  ws.on('close',()=>{if(ws.uid){const u=users.get(ws.uid);if(u&&u.ws===ws)users.delete(ws.uid)}});
});
setInterval(()=>{[wss,cws].forEach(x=>x.clients.forEach(c=>{if(!c.alive)return c.terminate();c.alive=false;c.ping()}))},30000);
server.listen(process.env.PORT||3000,()=>console.log('running'+(ACC?' (accounts on)':' (accounts OFF: set SUPABASE_URL and SUPABASE_KEY)')));
                                     
