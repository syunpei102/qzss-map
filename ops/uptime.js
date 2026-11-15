(function(){'use strict';
const DAY=86400000,JST=9*3600000;
function between(start,end){
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return '未取得';
 const first=new Date(start+JST),last=new Date(end+JST);if(!Number.isFinite(first.getTime())||!Number.isFinite(last.getTime()))return '未取得';
 const anniversary=months=>{const year=first.getUTCFullYear(),month=first.getUTCMonth()+months;const maxDay=new Date(Date.UTC(year,month+1,0)).getUTCDate();return Date.UTC(year,month,Math.min(first.getUTCDate(),maxDay),first.getUTCHours(),first.getUTCMinutes(),first.getUTCSeconds(),first.getUTCMilliseconds())-JST;};
 let months=(last.getUTCFullYear()-first.getUTCFullYear())*12+last.getUTCMonth()-first.getUTCMonth();if(anniversary(months)>end)months--;months=Math.max(0,months);
 const years=Math.floor(months/12),month=months%12,remainder=Math.max(0,end-anniversary(months)),days=Math.floor(remainder/DAY),hours=Math.floor(remainder%DAY/3600000);
 const minutes=Math.floor(remainder%3600000/60000),seconds=Math.floor(remainder%60000/1000);
 return [[years,'年'],[month,'か月'],[days,'日']].filter(([value])=>value>0).map(([value,unit])=>value+unit).join('')+hours+'時間'+minutes+'分'+seconds+'秒';
}
function fromDuration(ms,end=Date.now()){return Number.isFinite(ms)&&ms>=0?between(end-ms,end):'未取得';}
if(typeof module!=='undefined'&&module.exports)module.exports={between,fromDuration};else globalThis.QzssUptime={between,fromDuration};
})();
