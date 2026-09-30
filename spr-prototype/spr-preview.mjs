#!/usr/bin/env node
// Local browser test host, not a ChatGPT emulator or proof of Desktop compatibility.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHandler, VERSION } from './spr-server.mjs';
import { killChildren } from '../lib/limits.mjs';

const handle = createHandler();
const page = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>LimitBar — local bridge test</title>
<style>:root{color-scheme:light dark;font:14px system-ui}body{margin:24px}header{max-width:540px;margin:0 auto 20px}iframe{display:block;width:min(100%,540px);height:600px;margin:auto;border:1px solid ButtonBorder;border-radius:12px;background:Canvas}button{font:inherit;margin-right:8px}</style>
<header><p>Local MCP Apps bridge test · not ChatGPT Desktop</p><button id="spr-theme">Toggle theme</button><button id="spr-width">Toggle narrow panel</button></header>
<iframe id="spr-frame" title="LimitBar" src="/spr-widget" sandbox="allow-scripts allow-same-origin"></iframe>
<script>
const frame=document.getElementById('spr-frame'); let theme='light';
document.getElementById('spr-theme').onclick=()=>{theme=theme==='light'?'dark':'light';document.documentElement.style.colorScheme=theme;frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme}},location.origin)};
document.getElementById('spr-width').onclick=()=>{frame.style.width=frame.style.width==='300px'?'min(100%,540px)':'300px'};
window.addEventListener('message',async event=>{
  if(event.source!==frame.contentWindow||event.origin!==location.origin||event.data?.jsonrpc!=='2.0')return;
  const message=event.data;
  if(message.method==='ui/notifications/size-changed'){
    const height=message.params?.height;
    if(Number.isFinite(height))frame.style.height=Math.max(100,Math.min(2000,Math.ceil(height)))+'px';
    return;
  }
  if(message.id===undefined||!message.method)return;
  let response;
  if(message.method==='ui/initialize')response={jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'spr-preview',version:'${VERSION}'},hostCapabilities:{serverTools:{}},hostContext:{theme,displayMode:'inline'}}};
  else if(message.method==='tools/call'){
    try{response=await (await fetch('/spr-rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)})).json()}
    catch{response={jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'Preview request failed'}}}
  }else response={jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}};
  frame.contentWindow.postMessage(response,location.origin);
});
</script></html>`;
const server = createServer(async (req, res) => {
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) {
    res.writeHead(403).end(); return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page); return;
  }
  if (req.method === 'GET' && req.url === '/spr-widget') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(await readFile(new URL('./spr-widget.html', import.meta.url), 'utf8')); return;
  }
  if (req.method === 'POST' && req.url === '/spr-rpc') {
    if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') {
      res.writeHead(403).end(); return;
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) { res.writeHead(413).end(); return; }
      }
      const request = JSON.parse(body);
      if (request.method !== 'tools/call') { res.writeHead(400).end(); return; }
      const response = await handle(request);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
    } catch { res.writeHead(400).end(); }
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/`));
process.on('exit', killChildren);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
