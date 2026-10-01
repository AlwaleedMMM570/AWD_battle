
const http=require('http'),fs=require('fs'),path=require('path');
const {WebSocketServer}=require('ws');
const OK=new Set(['index.html','manifest.json','icon-192.png','icon-512.png']);
const TYPES={'.html':'text/html; charset=utf-8','.json':'application/json','.png':'image/png'};
function find(n){for(const d of [__dirname,path.join(__dirname,'public')]){const f=path.join(d,n);if(fs.existsSync(f))return f}return null}
const server=http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';
  const n=p.slice(1);
  if(!OK.has(n)){res.writeHead(404);return res.end('Not found')}
  const f=find(n);
  if(!f){res.writeHead(404);return res.end('File missing: '+n)}
  fs.readFile(f,(e,d)=>{if(e){res.writeHead(500);return res.end('Error')}
    res.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream'});res.end(d)});
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
  
