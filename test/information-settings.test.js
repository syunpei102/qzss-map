const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Settings = require('../public/information-settings');
const source = fs.readFileSync(require.resolve('../server.js'),'utf8');
test('information defaults disable only weather, volcano warnings and ash', () => {
  for(const cat of [8,9,10])assert.equal(Settings.isEnabled({disaster_category_no:cat}),false);
  for(const cat of [1,2,3,4,5,6,11])assert.equal(Settings.isEnabled({disaster_category_no:cat}),true);
  assert.deepEqual(Settings.normalize({weatherEnabled:'false',volcanoEnabled:true}),{weatherEnabled:false,volcanoEnabled:true});
});
test('server notification gate follows independent category switches', () => {
  const start=source.indexOf('function shouldNotify('),end=source.indexOf('// public/main.jsの同名関数',start);
  const context={PUSH_ENABLED:true,InformationSettings:Settings,informationCategorySettings:{weatherEnabled:false,volcanoEnabled:false},isStaleForNotification:()=>false,globalShowTrainingBroadcasts:true,TrainingReportFilter:{shouldProcess:()=>true},isEndSignal:()=>false,tsunamiInfoHasLocation:()=>true,globalLalertEnabled:true,PUSH_NOTIFY_CATEGORY_NOS:new Set([1,2,3,5,8,9,10,11])};
  vm.runInNewContext(source.slice(start,end),context);
  for(const weather of [false,true])for(const volcano of [false,true]){
    context.informationCategorySettings={weatherEnabled:weather,volcanoEnabled:volcano};
    for(const [cat,expected] of [[10,weather],[8,volcano],[9,volcano],[1,true],[5,true],[11,true]]){
      assert.equal(context.shouldNotify({disaster_category_no:cat}),expected,`${cat}/${weather}/${volcano}`);
    }
  }
});
