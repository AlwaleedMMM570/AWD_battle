const http=require('http'),fs=require('fs'),path=require('path');
const {WebSocketServer}=require('ws');
const TYPES={'.html':'text/html; charset=utf-8','.json':'application/json','.png':'image/png'};
const SAFE=/^(index|game-[A-Za-z0-9_.-]+)\.html$|^(manifest\.json|icon-(192|512)\.png)$/;
function latest(){try{const g=fs.readdirSync(__dirname).filter(f=>/^game-[A-Za-z0-9_.-]+\.html$/.test(f)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));return g.length?g[g.length-1]:'index.html'}catch(e){return 'index.html'}}
function find(n){for(const d of [__dirname,path.join(__dirname,'public')]){const f=path.join(d,n);if(fs.existsSync(f))return f}return null}
const server=http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]);
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
const rooms=new Map();
wss.on('connection',(ws,req)=>{
  const room=(new URL(req.url,'http://x').searchParams.get('room')||'').toLowerCase();
  if(!/^[a-z0-9]{2,20}$/.test(room)){return ws.close(1008)}
  let set=rooms.get(room);if(!set){set=new Set();rooms.set(room,set)}
  if(set.size>=2){return ws.close(1013)}
  set.add(ws);ws.alive=true;
  ws.on('pong',()=>{ws.alive=true});
  for(const o of set)if(o!==ws&&o.last)ws.send(JSON.stringify({t:'p',id:o.id,d:o.last}));
  ws.on('message',(raw)=>{
    let m;try{m=JSON.parse(raw)}catch(e){return}
    if(m.t!=='p'||typeof m.id!=='string'||m.id.length>20)return;
    ws.id=m.id;ws.last=m.d;
    const out=JSON.stringify({t:'p',id:m.id,d:m.d});
    for(const o of set)if(o!==ws&&o.readyState===1)o.send(out);
  });
  ws.on('close',()=>{
    set.delete(ws);
    if(ws.id){const out=JSON.stringify({t:'l',id:ws.id});for(const o of set)if(o.readyState===1)o.send(out)}
    if(!set.size)rooms.delete(room);
  });
});
const users=new Map();
cws.on('connection',ws=>{
  ws.alive=true;ws.hist=[];ws.on('pong',()=>{ws.alive=true});
  const send=o=>{if(ws.readyState===1)ws.send(JSON.stringify(o))};
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw)}catch(e){return}
    if(!m||typeof m.t!=='string')return;
    if(m.t==='hi'){
      const id=String(m.id||'').toUpperCase();if(!/^[A-Z0-9]{6,12}$/.test(id))return;
      if(ws.uid&&ws.uid!==id){const u=users.get(ws.uid);if(u&&u.ws===ws)users.delete(ws.uid)}
      const old=users.get(id);if(old&&old.ws!==ws)old.ws.close(4000);
      ws.uid=id;users.set(id,{ws,name:String(m.name||'').replace(/[\u0000-\u001f]/g,'').slice(0,14)});
      return send({t:'hi',ok:1});
    }
    if(!ws.uid)return;
    const now=Date.now();ws.hist=ws.hist.filter(t=>now-t<3000);
    if(ws.hist.length>=6){if(m.t==='msg')send({t:'err',cid:m.cid,rate:1});return}
    ws.hist.push(now);
    const me=users.get(ws.uid);if(!me)return;
    if(m.t==='who'){
      const on=(Array.isArray(m.ids)?m.ids:[]).slice(0,60).map(i=>String(i).toUpperCase()).filter(i=>users.has(i)).map(i=>({id:i,name:users.get(i).name}));
      return send({t:'st',on});
    }
    const to=users.get(String(m.to||'').toUpperCase());
    if(m.t==='add'){if(to&&to.ws!==ws&&to.ws.readyState===1)to.ws.send(JSON.stringify({t:'added',from:ws.uid,name:me.name}));return}
    if(m.t==='msg'){
      const text=String(m.text||'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,300);
      if(!text)return;
      if(!to||to.ws===ws||to.ws.readyState!==1)return send({t:'err',cid:m.cid});
      to.ws.send(JSON.stringify({t:'msg',from:ws.uid,name:me.name,text,ts:now}));
      return send({t:'ack',cid:m.cid});
    }
  });
  ws.on('close',()=>{if(ws.uid){const u=users.get(ws.uid);if(u&&u.ws===ws)users.delete(ws.uid)}});
});
setInterval(()=>{[wss,cws].forEach(x=>x.clients.forEach(c=>{if(!c.alive)return c.terminate();c.alive=false;c.ping()}))},30000);
server.listen(process.env.PORT||3000,()=>console.log('running'));
