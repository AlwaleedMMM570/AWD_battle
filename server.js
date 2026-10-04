const http=require('http'),fs=require('fs'),path=require('path');
const {WebSocketServer}=require('ws');
const TYPES={'.html':'text/html; charset=utf-8','.json':'application/json','.png':'image/png'};
const SAFE=/^(index|game-[A-Za-z0-9_.-]+)\.html$|^(manifest\.json|icon-(192|512)\.png)$/;
function latest(){try{const g=fs.readdirSync(__dirname).filter(f=>/^game-[A-Za-z0-9_.-]+\.html$/.test(f)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));return g.length?g[g.length-1]:'index.html'}catch(e){return 'index.html'}}
function find(n){for(const d of [__dirname,path.join(__dirname,'public')]){const f=path.join(d,n);if(fs.existsSync(f))return f}return null}
const CODES={};(process.env.CODES||'').split(',').forEach(p=>{const a=p.trim().split(':');const c=(a[0]||'').toUpperCase(),amt=+a[1],max=+a[2]||0;if(/^[A-Z0-9]{1,20}$/.test(c)&&amt>0)CODES[c]={amt:amt,max:max,ids:new Set()}});
const hits=new Map();
function limited(ip){const n=Date.now(),a=(hits.get(ip)||[]).filter(t=>n-t<60000);a.push(n);hits.set(ip,a);return a.length>10}
function redeem(req,res){
  const ip=((req.headers['x-forwarded-for']||'').split(',')[0].trim())||req.socket.remoteAddress;
  let b='';req.on('data',d=>{b+=d;if(b.length>1024)req.destroy()});
  req.on('end',()=>{
    const send=(c,o)=>{res.writeHead(c,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(o))};
    if(limited(ip))return send(429,{ok:false,err:'rate'});
    let j;try{j=JSON.parse(b)}catch(e){return send(400,{ok:false})}
    const code=String(j.code||'').toUpperCase().replace(/[^A-Z0-9]/g,''),id=String(j.id||'');
    if(!/^[a-z0-9]{8,40}$/i.test(id))return send(400,{ok:false});
    const r=CODES[code];if(!r)return send(200,{ok:false});
    if(r.ids.has(id)||(r.max&&r.ids.size>=r.max))return send(200,{ok:false,used:true});
    r.ids.add(id);send(200,{ok:true,amount:r.amt});
  });
}
const server=http.createServer((req,res)=>{
  if(req.method==='POST'&&req.url.split('?')[0]==='/redeem')return redeem(req,res);
  let p=decodeURIComponent(req.url.split('?')[0]);
  const n=(p==='/'||p==='/index.html')?latest():p.slice(1);
  if(!SAFE.test(n)){res.writeHead(404);return res.end('Not found')}
  const f=find(n);
  if(!f){res.writeHead(404);return res.end('File missing: '+n)}
  fs.readFile(f,(e,d)=>{if(e){res.writeHead(500);return res.end('Error')}
    res.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(d)});
});
const wss=new WebSocketServer({server,path:'/ws',maxPayload:4096});
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
setInterval(()=>{wss.clients.forEach(c=>{if(!c.alive)return c.terminate();c.alive=false;c.ping()})},30000);
server.listen(process.env.PORT||3000,()=>console.log('running'));
