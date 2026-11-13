'use strict';
const ROUTES=new Map([['/push/subscribe','POST'],['/push/unsubscribe','POST'],['/push/vapid-public-key','GET'],['/monitoring/discord','POST']]);
function createNotificationBackend(base,fetcher=fetch){
 if(!base)return (_req,_res,next)=>next();
 const target=new URL(base);if(target.protocol!=='https:'||target.username||target.password||target.search||target.hash)throw Error('notification backend must be an HTTPS origin');
 return async(req,res,next)=>{
  if(ROUTES.get(req.path)!==req.method)return next();
  try{
   const url=new URL(req.path,target);if(req.path==='/monitoring/discord')url.search=new URL(req.originalUrl,'http://localhost').search;
   const response=await fetcher(url,{method:req.method,headers:{'Content-Type':'application/json'},body:req.method==='GET'?undefined:JSON.stringify(req.body||{}),signal:AbortSignal.timeout(15000),redirect:'error'});
   res.status(response.status);const type=response.headers.get('content-type');if(type)res.set('Content-Type',type);return res.send(Buffer.from(await response.arrayBuffer()));
  }catch{return res.status(503).json({error:'notification backend unavailable'});}
 };
}
module.exports={createNotificationBackend,ROUTES};
