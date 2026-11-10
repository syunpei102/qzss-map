const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/main.js'),'utf8');
function geometryTools(){const c={};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function eachCoordinate('),source.indexOf('// Lアラートの楕円')),c);const start=source.indexOf('const prefectureAnchorCache');vm.runInContext(source.slice(start,source.indexOf('function createIntensityBadgeMarkers(',start)),c);return c;}
test('all 47 intensity anchors are on land and inside the corresponding camera mainland bounds',()=>{
 const c=geometryTools(),features=JSON.parse(fs.readFileSync(require.resolve('../public/data/prefectures.geojson'))).features;
 for(const f of features){const h=c.prefectureMarkerAnchor(f.geometry),b=c.mainLandBounds(f.geometry);assert(c.pointInPolygonGeometry(h,f.geometry),f.properties.name);assert(h[0]>=b[0]&&h[0]<=b[2]&&h[1]>=b[1]&&h[1]<=b[3],f.properties.name);assert.equal(c.prefectureMarkerAnchor(f.geometry),h);}
});
test('concave shapes and holes still produce an interior anchor',()=>{
 const c=geometryTools();for(const rings of [[[[0,0],[8,0],[8,1],[1,1],[1,8],[0,8],[0,0]]],[[[0,0],[8,0],[8,8],[0,8],[0,0]],[[2,2],[6,2],[6,6],[2,6],[2,2]]]]){const g={type:'Polygon',coordinates:rings};assert(c.pointInPolygonGeometry(c.prefectureMarkerAnchor(g),g));}
});
