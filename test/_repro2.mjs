import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { JSDOM, VirtualConsole } from "jsdom";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openSwarmDaemon } from "../src/daemon.mjs";
import { startWebServer } from "../src/web.mjs";
function crc32(b){let c=~0;for(const x of b){c^=x;for(let k=0;k<8;k++)c=(c>>>1)^(0xedb88320&-(c&1));}return ~c>>>0;}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const body=Buffer.concat([Buffer.from(t,"latin1"),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(body));return Buffer.concat([l,body,c]);}
function png(){const i=Buffer.alloc(13);i.writeUInt32BE(1,0);i.writeUInt32BE(1,4);i[8]=8;i[9]=6;return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk("IHDR",i),chunk("IDAT",deflateSync(Buffer.alloc(5))),chunk("IEND",Buffer.alloc(0))]);}
async function boot(){
  const root=await mkdtemp(join(tmpdir(),"rp2-"));const sockPath=join(root,"s.sock");
  const faux=fauxProvider({provider:"fauxvision",models:[{id:"vision-1",input:["text","image"]}]});
  faux.appendResponses([fauxAssistantMessage([fauxText("saw it")])]);
  const models=createModels();models.setProvider(faux.provider);
  const ref={provider:"fauxvision",modelId:"vision-1"};
  const d=await openSwarmDaemon({dataDir:join(root,"data"),workspaceDir:join(root,"ws"),models,roleModels:Object.fromEntries(["lead","planner","coder","coderFast","reviewer","reviewerDeep","support","social","watcher","btw"].map(k=>[k,ref]))});
  d.harness.resume();
  const daemon=createServer(async(req,res)=>{let raw="";for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};const send=(c,o)=>{res.writeHead(c,{"Content-Type":"application/json"});res.end(JSON.stringify(o));};
    try{ if(String(req.url).startsWith("/transcript")){const e=await d.readTranscript(1,50);return send(200,{conversationId:1,entries:e});}
      if(String(req.url)==="/chat") return send(200, await d.chat(body.text,{images:body.images||[],steer:!!body.steer,targetWorkerId:body.targetWorkerId||"lead"}));
      return send(200,{});
    }catch(e){return send(500,{error:String(e.message||e)});}});
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
  w.fetch=async(u,o={})=>{const r=await fetch(base+String(u),{...o,headers:{...(o.headers||{}),Cookie:"swarm_s=x"}});if(String(u).startsWith("/api/chat")){const c=r.clone();console.log("CHAT",Date.now()%100000,r.status,await c.text());}return r;};
  w.eval(cs);w.eval(is);w.eval([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).pop());
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  const _f=w.fetch;
  await new Promise(r=>setTimeout(r,300));
  return {w,revoked,errors,close:async()=>{w.close();web.server.close();await new Promise(r=>daemon.close(r));await rm(root,{recursive:true,force:true});}};
}
test("real daemon image send", async()=>{const t=await boot();try{
  const ev=new t.w.Event("paste",{bubbles:true,cancelable:true});
  ev.clipboardData={items:[{kind:"file",type:"image/png",getAsFile:()=>new t.w.File([png()],"s.png",{type:"image/png"})}],getData:()=>""};
  const q=t.w.document.getElementById("q");q.focus();q.dispatchEvent(ev);
  await new Promise(r=>setTimeout(r,200));
  console.log("count before",Date.now()%100000,t.w.chatImages.count());
  q.value="hi";console.log("COUNT AT DISPATCH",t.w.chatImages.count());const kd=new t.w.KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true});console.log("dispatch",Date.now()%100000);q.dispatchEvent(kd);
  await new Promise(r=>setTimeout(r,9000));
  console.log("count after",Date.now()%100000,t.w.chatImages.count(),"hidden",t.w.document.getElementById("pending-images").hidden,"revoked",t.revoked.length,"errors",t.errors);
}finally{await t.close();}});
