const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const src=fs.readFileSync(require.resolve('../public/main.js'),'utf8');const start=src.indexOf('function cameraPaddingForPanel('),end=src.indexOf('function getMapCameraPadding(',start);const padding=vm.runInNewContext(src.slice(start,end)+';cameraPaddingForPanel');
const rect=(x,y,w,h)=>({left:x,top:y,right:x+w,bottom:y+h,width:w,height:h});
test('narrow desktop reserves the entire panel instead of clamping to 35 percent',()=>{const p=padding(rect(0,0,800,480),rect(12,12,340,438));assert(p.left>=368);assert(800-p.left-p.right>0);});
test('mobile camera fits below the actual panel height',()=>{const p=padding(rect(0,0,390,844),rect(4,4,382,330));assert(p.top>=350);assert(p.left+p.right<390);assert(p.top+p.bottom<844);});
test('short desktop panel can use the larger region below it',()=>{const p=padding(rect(0,0,900,1000),rect(12,12,340,100));assert(p.top>=128);assert(p.left<100);});
test('map container offsets and larger panels are measured in the same coordinate system',()=>{const p=padding(rect(100,50,800,600),rect(112,62,440,520));assert(p.left>=468);assert(p.left+p.right<800);});
test('hidden or non-overlapping panels reserve no space',()=>{for(const panel of [null,rect(0,0,0,0),rect(-500,0,100,100)]){const p=padding(rect(0,0,900,600),panel);assert.equal(p.left,p.right);assert.equal(p.top,p.bottom);}});
