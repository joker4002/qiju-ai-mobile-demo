import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const envFile=process.env.ARK_ENV_FILE||path.resolve(root,'../../.env');
if(fs.existsSync(envFile))for(const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/)){
  const match=line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if(match&&!process.env[match[1]])process.env[match[1]]=match[2];
}
const key=process.env.ARK_API_KEY||'';
const model=process.env.ARK_MODEL||'doubao-seed-2-1-pro-260915';
const base=(process.env.ARK_BASE_URL||'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/,'');
const port=Number(process.env.QIJU_API_PORT||4185);
const host=process.env.QIJU_API_HOST||'127.0.0.1';
const products=JSON.parse(fs.readFileSync(path.join(root,'catalog.json'),'utf8'));
const productById=new Map(products.map(p=>[p.id,p]));
const catalogContext=products.map(p=>`${p.id} ${p.name}｜${p.category}｜¥${p.price}｜${p.size}｜${p.material}｜${p.colors}｜${p.features}`).join('\n');
const allowOrigins=new Set(['https://joker4002.github.io','https://qiju.treenewmedicare.top']);
const counts=new Map();
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'};

function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));}
function permitted(req){const origin=req.headers.origin;return !origin||allowOrigins.has(origin)||/^http:\/\/127\.0\.0\.1:\d+$/.test(origin);}
function cors(req,res){const origin=req.headers.origin;if(origin&&permitted(req)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');}}
function quota(req){
 const hour=Math.floor(Date.now()/3600000),ip=String(req.headers['cf-connecting-ip']||req.socket.remoteAddress||'unknown');
 for(const k of counts.keys())if(!k.startsWith(hour+':'))counts.delete(k);
 const global=hour+':global',person=hour+':'+ip;
 if((counts.get(global)||0)>=120||(counts.get(person)||0)>=18)return false;
 counts.set(global,(counts.get(global)||0)+1);counts.set(person,(counts.get(person)||0)+1);return true;
}
function readBody(req){return new Promise((resolve,reject)=>{
 let raw='',size=0;req.on('data',chunk=>{size+=chunk.length;if(size>24000){reject(new Error('TOO_LARGE'));req.destroy();return;}raw+=chunk;});
 req.on('end',()=>{try{resolve(JSON.parse(raw));}catch{reject(new Error('BAD_JSON'));}});req.on('error',reject);
});}
function normalizeOrders(value){return(Array.isArray(value)?value:[]).slice(0,3).map(o=>({
 id:String(o.id||'').slice(0,40),status:String(o.status||'').slice(0,20),stage:Number(o.stage)||0,
 items:(Array.isArray(o.items)?o.items:[]).slice(0,8).map(x=>({name:productById.get(x.id)?.name||'未知商品',qty:Math.max(1,Math.min(9,Number(x.qty)||1))}))
}));}
function normalizeCart(value){return Object.entries(value&&typeof value==='object'&&!Array.isArray(value)?value:{}).slice(0,20).map(([id,qty])=>({name:productById.get(id)?.name||'未知商品',qty:Math.max(0,Math.min(9,Number(qty)||0))})).filter(x=>x.qty);}

async function chat(req,res){
 if(!permitted(req))return json(res,403,{code:'ORIGIN_DENIED'});
 if(!quota(req))return json(res,429,{code:'RATE_LIMIT'});
 let data;try{data=await readBody(req);}catch{return json(res,400,{code:'BAD_REQUEST'});}
 const question=String(data?.message||'').trim().slice(0,500);
 if(!question)return json(res,400,{code:'EMPTY_MESSAGE'});
 const history=(Array.isArray(data.history)?data.history:[]).slice(-10).filter(x=>['user','assistant'].includes(x?.role)&&typeof x.content==='string').map(x=>({role:x.role,content:x.content.slice(0,700)}));
 const cart=normalizeCart(data.cart),orders=normalizeOrders(data.orders);
 const system=`你是「栖居 AI 家具服务站」的顾客端 AI 管家。当前真实模型为火山引擎方舟的 ${model}。\n回答规则：先直接回答用户实际问题，不要把“你是什么模型”“你是谁”“你会什么”等问题误判为买家具需求；被问到模型时如实说明由火山方舟豆包模型驱动。除非用户要求，不要强行推荐商品。语言自然、具体、简洁，通常 2-5 句；复杂对比可以分点。\n商品推荐必须仅使用下方 32 件演示商品的真实字段；价格、尺寸、材质不可编造。缺少尺寸、库存、活动或政策数据时直说未知，不编造承诺。订单、物流、售后、支付均为演示流程，尚未接入京东真实系统；不能声称已支付、真实发货、实际提交售后。涉及下单时可引导顾客使用页面上的购物袋和模拟下单按钮。商品列表：\n${catalogContext}`;
 const context=`当前浏览器体验数据（由页面提交，仅供本次回答参考）：购物袋 ${JSON.stringify(cart)}；最近订单 ${JSON.stringify(orders)}。`;
 const payload={model,messages:[{role:'system',content:system},{role:'system',content:context},...history,{role:'user',content:question}],thinking:{type:'disabled'},max_tokens:550,temperature:0.45};
 if(!key)return json(res,503,{code:'ARK_KEY_MISSING'});
 try{
  const upstream=await fetch(base+'/chat/completions',{method:'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(40000)});
  const body=await upstream.json();
  if(!upstream.ok){const upstreamCode=body?.error?.code||body?.error?.type||'unknown';console.error('Ark API error',upstream.status,upstreamCode);return json(res,503,{code:upstream.status===401?'ARK_AUTH':upstreamCode==='ModelNotOpen'?'ARK_MODEL_NOT_OPEN':'ARK_UPSTREAM'});}
  const reply=body?.choices?.[0]?.message?.content;
  if(typeof reply!=='string'||!reply.trim())return json(res,503,{code:'ARK_EMPTY'});
  return json(res,200,{reply:reply.trim(),model:body.model||model});
 }catch(error){console.error('Ark request failed',error?.name||'Error');return json(res,503,{code:'ARK_NETWORK'});}
}

http.createServer(async(req,res)=>{
 cors(req,res);
 if(req.method==='OPTIONS'&&req.url==='/api/chat'){res.writeHead(permitted(req)?204:403);return res.end();}
 if(req.url==='/api/health')return json(res,200,{service:'qiju-ai',model,configured:Boolean(key),catalogProducts:products.length});
 if(req.url==='/api/chat')return req.method==='POST'?chat(req,res):json(res,405,{code:'METHOD_NOT_ALLOWED'});
 if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{code:'METHOD_NOT_ALLOWED'});
 let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);}catch{return json(res,400,{code:'BAD_PATH'});}
 const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
 if(!file.startsWith(root+path.sep)||pathname.split('/').some(segment=>segment.startsWith('.'))||file.endsWith('.mjs')||file.endsWith('.md'))return json(res,404,{code:'NOT_FOUND'});
 let stat;try{stat=fs.statSync(file);}catch{return json(res,404,{code:'NOT_FOUND'});}
 if(!stat.isFile())return json(res,404,{code:'NOT_FOUND'});
 res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':/\.(html|js|css)$/.test(file)?'no-store':'public, max-age=3600','X-Content-Type-Options':'nosniff'});
 if(req.method==='HEAD')return res.end();fs.createReadStream(file).pipe(res);
}).listen(port,host,()=>console.log(`Qiju AI server listening on ${host}:${port}; model ${model}; ${products.length} products; key configured ${Boolean(key)}`));
