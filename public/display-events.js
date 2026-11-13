// 表示用のイベント状態．通知・音・録画の判定とは独立する．
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DisplayEvents = api;
})(typeof self !== 'undefined' ? self : this, function() {
  const EARTHQUAKE_TTL_MS = 600000, WARNING_TTL_MS = 1200000, ROTATION_MS = 10000;
  const PHASE = {1:'eew', 2:'hypocenter', 3:'intensity'};
  const ORDER = {eew:1, hypocenter:2, intensity:3};
  const scope = r => r.is_test_data ? 'test' : r.report_classification_no === 7
    || r.a1_message_type === 'Test' || r.a4_hazard_type === 'Test alert' ? 'training' : 'live';
  const kind = r => PHASE[r?.disaster_category_no] ? 'earthquake'
    : [5,6].includes(r?.disaster_category_no) ? 'tsunami'
    : r?.type === 'QzssDcxJAlert' ? 'jalert' : null;
  const identity = r => ({time:r.occurrence_time_of_earthquake || r.occurrenceTime || null,
    epicenter:r.seismic_epicenter_raw ?? r.epicenterRaw ?? null});
  function sameIdentity(a,b) {
    a=identity(a); b=identity(b);
    if(a.time && b.time) return a.time === b.time;
    return a.epicenter != null && b.epicenter != null && a.epicenter === b.epicenter;
  }
  function resolveEarthquakeId(report, candidates = []) {
    if (report.display_event_id) return report.display_event_id;
    const own=identity(report), prefix=scope(report)+'|earthquake|';
    const matches=candidates.filter(e => (e.kind ? e.kind==='earthquake' : !!PHASE[(e.report || e).disaster_category_no]) && (e.scope || scope(e.report || e)) === scope(report)
      && sameIdentity(e.report || e,report));
    // 同じ発生時刻なら震央の訂正も同一．欠損時の推測は候補が一意の場合だけ．
    if (own.time) {
      const exact=matches.find(e => identity(e.report || e).time === own.time);
      if (exact) return exact.id || exact.eventId || exact.report?.display_event_id || prefix+'time:'+own.time;
      const fallback=matches.filter(e => !identity(e.report || e).time);
      if (fallback.length===1) return fallback[0].id || fallback[0].eventId || prefix+'time:'+own.time;
      return prefix+'time:'+own.time;
    }
    const unique=new Map(matches.map(e => [e.id || e.eventId || e.report?.display_event_id || JSON.stringify(identity(e.report || e)),e]));
    if (unique.size===1) {
      const e=[...unique.values()][0];
      return e.id || e.eventId || e.report?.display_event_id || prefix+'time:'+identity(e.report || e).time;
    }
    // 安易にunknown同士を統合しない．同じ電文の再受信だけは同じIDにする．
    return prefix+'unidentified:'+JSON.stringify([own.epicenter,report.report_time || null,report.raw || report.message || report.sentence || report]);
  }
  function warningId(report) {
    if (report.display_event_id) return report.display_event_id;
    const k=kind(report), s=scope(report);
    if(k==='tsunami') return `${s}|tsunami|${report.disaster_category_no}|${(report.tsunami_forecast_regions_raw || []).join(',') || 'unspecified'}`;
    return `${s}|jalert|${report.a4_hazard_type || 'unknown'}|${report.a6a7_hazard_onset_datetime || [...(report.ex9_target_area_list_ja || [])].sort().join(',')}`;
  }
  function resolveWarningId(report, candidates=[]) {
    if (report.display_event_id || kind(report)!=='jalert') return warningId(report);
    const direct=warningId(report);
    if (report.a6a7_hazard_onset_datetime) return direct;
    const areas=JSON.stringify([...(report.ex9_target_area_list_ja || [])].sort());
    const matches=candidates.filter(e => (e.kind==='jalert' || e.report?.type==='QzssDcxJAlert')
      && (e.scope || scope(e.report))===scope(report)
      && e.report.a4_hazard_type===report.a4_hazard_type
      && JSON.stringify([...(e.report.ex9_target_area_list_ja || [])].sort())===areas);
    const ids=[...new Set(matches.map(e=>e.id || e.report.display_event_id || warningId(e.report)))];
    return ids.length===1 ? ids[0] : direct;
  }
  function parts(report) {
    if(report.disaster_category_no!==5 || !report.tsunami_forecast_regions_raw?.length) return [report];
    const fields=['tsunami_forecast_regions_raw','tsunami_forecast_regions','tsunami_heights_raw','tsunami_heights','expected_tsunami_arrival_times'];
    return report.tsunami_forecast_regions_raw.map((_,i) => {
      const part={...report}; for(const f of fields) if(Array.isArray(report[f])) part[f]=report[f].slice(i,i+1);
      return part;
    });
  }
  const cancelled = r => r.information_type_no===2 || r.a1_message_type==='All Clear'
    || r.disaster_category_no===5 && [1,2].includes(r.tsunami_warning_code_raw)
    || r.disaster_category_no===6 && r.tsunamigenic_potential_raw===0;
  function cancellationMatches(event, report, candidates) {
    if(event.kind!==kind(report) || event.scope!==scope(report)) return false;
    if(event.kind==='earthquake') {
      if(!identity(report).time && identity(report).epicenter==null && !report.display_event_id) return false;
      return event.id===resolveEarthquakeId(report,candidates);
    }
    if(event.kind==='tsunami') {
      if(event.report.disaster_category_no!==report.disaster_category_no) return false;
      const codes=report.tsunami_forecast_regions_raw || [];
      return !codes.length || (event.report.tsunami_forecast_regions_raw || []).some(c=>codes.includes(c));
    }
    return event.id===resolveWarningId(report,candidates);
  }
  class EventStore {
    constructor({now=Date.now,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),onChange=()=>{}}={}) {
      this.now=now;this.setTimer=setTimer;this.clearTimer=clearTimer;this.onChange=onChange;
      this.events=new Map();this.history=new Map();this.timers=new Map();
    }
    receive(report, presentation=null) {
      if(!kind(report)) return [];
      const now=this.now();this.expire(now);
      if(cancelled(report)) {
        const ids=[...this.events.values()].filter(e=>cancellationMatches(e,report,[...this.events.values()])).map(e=>e.id);
        for(const id of ids)this.remove(id,false);
        if(ids.length)this.onChange({reason:'cancel',ids});
        return ids;
      }
      const changed=[];
      for(const part of parts(report)) {
        const k=kind(part), id=k==='earthquake' ? resolveEarthquakeId(part,[...this.events.values()]) : resolveWarningId(part,[...this.events.values()]);
        const previous=this.events.get(id), phase=PHASE[part.disaster_category_no] || k;
        const memo=this.history.get(id) || {phaseFirst:{},highest:0,lastSeen:now};
        memo.lastSeen=now;
        if(k==='earthquake' && ORDER[phase]<memo.highest)continue;
        const age=Math.max(0,Number(part.replay_age_ms)||0)+Math.max(0,Number(part.display_phase_age_ms)||0);
        const receivedAt=now-age;
        const phaseFirst=memo.phaseFirst[phase] ?? receivedAt;
        memo.phaseFirst[phase]=Math.min(phaseFirst,receivedAt);
        memo.highest=Math.max(memo.highest,ORDER[phase] || 0);this.history.set(id,memo);
        const ttl=part.is_test_data ? 60000 : scope(part)==='training' ? WARNING_TTL_MS
          : k==='earthquake' ? EARTHQUAKE_TTL_MS : WARNING_TTL_MS;
        const expiresAt=(k==='earthquake' ? memo.phaseFirst[phase] : receivedAt)+ttl;
        if(expiresAt<=now)continue;
        const effective = k==='earthquake' ? {...part, occurrence_time_of_earthquake:part.occurrence_time_of_earthquake || previous?.report.occurrence_time_of_earthquake, seismic_epicenter_raw:part.seismic_epicenter_raw ?? previous?.report.seismic_epicenter_raw} : part;
        const event={id,kind:k,phase,scope:scope(part),region:part.tsunami_forecast_regions || part.ex9_target_area_list_ja || part.seismic_epicenter || null,
          receivedAt,firstReceivedAt:previous?.firstReceivedAt ?? (Number.isFinite(part.display_first_received_age_ms) ? now-part.display_first_received_age_ms-(part.display_transport_delay_ms || 0) : now-age),
          phaseFirstReceivedAt:memo.phaseFirst[phase],lastReceivedAt:Number.isFinite(part.display_last_received_age_ms) ? now-part.display_last_received_age_ms-(part.display_transport_delay_ms || 0) : receivedAt,expiresAt,status:'active',report:effective,
          presentation:typeof presentation==='function' ? presentation(effective) : presentation};
        this.events.set(id,event);this.arm(event);changed.push(id);
      }
      for(const [id,memo] of this.history)if(now-memo.lastSeen>172800000)this.history.delete(id);
      while(this.history.size>5000)this.history.delete(this.history.keys().next().value);
      if(changed.length)this.onChange({reason:'receive',ids:changed});
      return changed;
    }
    arm(event) {
      if(this.timers.has(event.id))this.clearTimer(this.timers.get(event.id));
      this.timers.set(event.id,this.setTimer(()=>{
        const current=this.events.get(event.id);
        if(!current)return;
        if(current.expiresAt<=this.now())this.remove(event.id);
        else this.arm(current);
      },Math.max(0,event.expiresAt-this.now())));
    }
    remove(id,notify=true) {
      if(!this.events.has(id))return false;
      this.events.delete(id);this.clearTimer(this.timers.get(id));this.timers.delete(id);
      if(notify)this.onChange({reason:'remove',ids:[id]});return true;
    }
    expire(now=this.now()) {
      const ids=[...this.events.values()].filter(e=>e.expiresAt<=now).map(e=>e.id);
      for(const id of ids)this.remove(id,false);
      if(ids.length)this.onChange({reason:'expire',ids});
    }
    clear() {const ids=[...this.events.keys()];for(const id of ids)this.remove(id,false);this.history.clear();if(ids.length)this.onChange({reason:'clear',ids});}
  }
  const recordKind = r => r.displayKind || (r.jalertKey ? 'jalert' : PHASE[r.disasterCategoryNo] ? 'earthquake' : [5,6].includes(r.disasterCategoryNo) ? 'tsunami' : null);
  class ViewCycle {
    constructor(){this.current=null;this.nextAt=0;this.paused=false;}
    select(records,now=Date.now()) {
      let active=[...records].filter(r=>recordKind(r) && (r.expiresAt==null || r.expiresAt>now));
      if(active.some(r=>!r.isTraining && !r.isTestData))active=active.filter(r=>!r.isTraining && !r.isTestData);
      const warnings=active.filter(r=>recordKind(r)!=='earthquake');
      const eew=active.filter(r=>recordKind(r)==='earthquake' && r.disasterCategoryNo===1);
      const quakes=active.filter(r=>recordKind(r)==='earthquake' && r.disasterCategoryNo!==1)
        .sort((a,b)=>(a.firstReceivedAt ?? a.updatedAt ?? 0)-(b.firstReceivedAt ?? b.updatedAt ?? 0) || String(a.id).localeCompare(String(b.id)));
      let selected=[];
      if(eew.length){this.paused=true;selected=eew;}
      else if(quakes.length){
        let index=quakes.findIndex(r=>r.id===this.current);
        if(index<0){index=0;this.nextAt=now+ROTATION_MS;}
        if(this.paused){this.nextAt=now+ROTATION_MS;this.paused=false;}
        if(now>=this.nextAt){index=(index+1)%quakes.length;this.nextAt=now+ROTATION_MS;}
        this.current=quakes[index].id;selected=warnings.some(r=>recordKind(r)==='tsunami') ? quakes : [quakes[index]];
      }else {this.current=null;this.nextAt=0;this.paused=false;}
      return [...selected,...warnings];
    }
  }
  return {EventStore,ViewCycle,ROTATION_MS,EARTHQUAKE_TTL_MS,WARNING_TTL_MS,kind,scope,identity,sameIdentity,resolveEarthquakeId,warningId,resolveWarningId,parts,cancelled,cancellationMatches};
});
