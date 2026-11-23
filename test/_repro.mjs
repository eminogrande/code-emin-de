import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { JSDOM, VirtualConsole } from "jsdom";
import { startWebServer } from "/opt/pi-durable-swarm/src/web.mjs";
function crc32(b){let c=~0;for(const x of b){c^=x;for(let k=0;k<8;k++)c=(c>>>1)^(0xedb88320&-(c&1));}return ~c>>>0;}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const body=Buffer.concat([Buffer.from(t,"latin1"),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(body));return Buffer.concat([l,body,c]);}
function png(){const i=Buffer.alloc(13);i.writeUInt32BE(1,0);i.writeUInt32BE(1,4);i[8]=8;i[9]=6;return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk("IHDR",i),chunk("IDAT",deflateSync(Buffer.alloc(5))),chunk("IEND",Buffer.alloc(0))]);}
async function boot(chatHandler){
  const root=await mkdtemp(join(tmpdir(),"rp-"));const sockPath=join(root,"s.sock");
  const daemon=createServer((req,res)=>{let raw="";req.on("data",c=>raw+=c);req.on("end",()=>{ if(String(req.url).startsWith("/transcript")||String(req.url).startsWith("/history")) return res.end(JSON.stringify({conversationId:1,entries:[]})); res.end(JSON.stringify({ok:true,text:"done"}));});});
  await new Promise(r=>daemon.listen(sockPath,r));
  const web=await startWebServer({port:0,host:"127.0.0.1",sockPath,authDbPath:join(root,"a.sqlite"),rpId:"localhost",origin:"http://localhost"});
  web.auth.verifySession=()=>true;
  const base=`http://127.0.0.1:${web.server.address().port}`;
  const get=p=>fetch(base+p,{headers:{Cookie:"swarm_s=x"}});
  const html=await (await get("/")).text();const cs=await (await get("/chat-client.js")).text();const is=await (await get("/chat-images.js")).text();
  const vc=new VirtualConsole();const errors=[];vc.on("jsdomError",e=>errors.push(e.message));
  const dom=new JSDOM(html,{url:base+"/",runScripts:"dangerously",pretendToBeVisual:true,virtualConsole:vc});
  const w=dom.window;const revoked=[];
  w.URL.createObjectURL=f=>"blob:"+(f.name||"x");w.URL.revokeObjectURL=u=>revoked.push(u);
  w.fetch=(u,o={})=>{ if(String(u).startsWith("/api/chat")) return chatHandler(base,o,w); return fetch(base+String(u),{...o,headers:{...(o.headers||{}),Cookie:"swarm_s=x"}});};
  w.eval(cs);w.eval(is);w.eval([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).pop());
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await new Promise(r=>setTimeout(r,300));
  return {w,revoked,errors,close:async()=>{w.close();web.server.close();await new Promise(r=>daemon.close(r));await rm(root,{recursive:true,force:true});}};
}
function paste(w){const ev=new w.Event("paste",{bubbles:true,cancelable:true});ev.clipboardData={items:[{kind:"file",type:"image/png",getAsFile:()=>new w.File([png()],"s.png",{type:"image/png"})}],getData:()=>""};const q=w.document.getElementById("q");q.focus();q.dispatchEvent(ev);}
const enter=w=>w.document.getElementById("q").dispatchEvent(new w.KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
const flush=(ms=600)=>new Promise(r=>setTimeout(r,ms));
for (const [name,fn] of [
  ["text", ()=>new Response(JSON.stringify({ok:true,text:"done"}),{status:200,headers:{"Content-Type":"application/json"}})],
  ["html", ()=>new Response(JSON.stringify({ok:true,text:"done",html:"<p>done</p>"}),{status:200,headers:{"Content-Type":"application/json"}})],
  ["images", ()=>new Response(JSON.stringify({ok:true,text:"done",images:["abc"]}),{status:200,headers:{"Content-Type":"application/json"}})],
  ["202pending", ()=>new Response(JSON.stringify({status:"pending"}),{status:202,headers:{"Content-Type":"application/json"}})],
  ["500", ()=>new Response(JSON.stringify({error:"boom"}),{status:500,headers:{"Content-Type":"application/json"}})],
  ["malformed", ()=>new Response("<html>oops</html>",{status:200,headers:{"Content-Type":"text/html"}})],
]) {
  test(name, async()=>{const t=await boot(()=>fn());try{paste(t.w);await flush(150);
    const before=t.w.chatImages.count();
    t.w.document.getElementById("q").value="hi";enter(t.w);await flush(900);
    console.log(name,"before=",before,"after=",t.w.chatImages.count(),"hidden=",t.w.document.getElementById("pending-images").hidden,"revoked=",t.revoked.length);
  } finally {await t.close();}});
}
