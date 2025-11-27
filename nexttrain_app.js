/* ============================================================
   NextTrain — app.js (extracted)
   All logic from optimized inline JS
   ============================================================ */

(function(){
  // ---------- CONFIG ----------
  const API_BASE = 'https://api.irail.be';
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const AUTO_REFRESH_MS = 60000;
  const MAX_RETRIES = 2;

  // ---------- STATE ----------
  const state = {
    mode: localStorage.getItem('nt_mode') || 'departure',
    station: localStorage.getItem('nt_station') || 'Libramont',
    stationsList: [],
    disturbances: [],
    expandedVehicle: null,
    trainDetailsCache: {},
    autoRefreshHandle: null,
    isFetching: false
  };

  // ---------- Utils ----------
  const utils = {
    lang(){ const nav = navigator.language || 'fr-BE'; return nav.startsWith('fr') ? 'fr' : 'en'; },
    nowSec(){ return Math.floor(Date.now()/1000) },
    formatTime(ts){ const d=new Date(ts*1000); return d.toLocaleTimeString('fr-BE',{hour:'2-digit',minute:'2-digit'}) },
    getDateString(date){ const d=date||new Date(); return String(d.getDate()).padStart(2,'0')+String(d.getMonth()+1).padStart(2,'0')+String(d.getFullYear()).slice(-2); },
    delay(ms){ return new Promise(r=>setTimeout(r,ms)); },
    cacheKeyForVehicle(id,date){ return `${id}_${date}` }
  };

  // ---------- DOM refs ----------
  const refs = {
    stationNameText: document.getElementById('stationNameText'),
    stationSelect: document.getElementById('stationSelect'),
    stationSearch: document.getElementById('stationSearch'),
    tabDeparture: document.getElementById('tabDeparture'),
    tabArrival: document.getElementById('tabArrival'),
    trainsList: document.getElementById('trainsList'),
    locateBtn: document.getElementById('locateBtn'),
    refreshBtn: document.getElementById('refreshBtn')
  };

  // ---------- Stations list ----------
  const stationsByLine = {
    'Ligne L162 (Luxembourg-Bruxelles)': [ 'Libramont','Arlon','Neufchâteau','Jemelle','Marloie','Ciney','Namur','Luxembourg' ],
    'Ligne L161 (Bruxelles-Namur)': [ 'Bruxelles-Luxembourg','Ottignies','Gembloux','Namur' ],
    'Ligne L34 (Liège)': [ 'Liège-Guillemins' ],
    'Autres gares IC': [ 'Bruxelles-Midi','Bruxelles-Central','Bruxelles-Nord','Antwerpen-Centraal','Gent-Sint-Pieters','Charleroi-Sud','Bruges','Leuven','Mons','Tournai','Mechelen','Hasselt','Kortrijk','Oostende' ]
  };

  // ---------- Render helpers ----------
  function setActiveTab(){
    refs.tabDeparture.classList.toggle('active', state.mode==='departure');
    refs.tabArrival.classList.toggle('active', state.mode==='arrival');
  }
  function saveState(){ localStorage.setItem('nt_mode',state.mode); localStorage.setItem('nt_station',state.station); }

  function renderStationSelect(filter=''){
    const sel = refs.stationSelect; sel.innerHTML='';
    const frag = document.createDocumentFragment();
    Object.keys(stationsByLine).forEach(cat=>{
      const og=document.createElement('optgroup'); og.label=cat;
      stationsByLine[cat].forEach(s=>{
        if(!filter || s.toLowerCase().includes(filter.toLowerCase())){
          const o=document.createElement('option'); o.value=s; o.textContent=s;
          if(s===state.station) o.selected=true;
          og.appendChild(o);
        }
      });
      frag.appendChild(og);
    });
    sel.appendChild(frag);
  }

  function renderHeader(){ refs.stationNameText.textContent = state.station; setActiveTab(); }

  // ---------- Networking ----------
  async function fetchJsonWithTimeout(url,{timeout=7000}={}){
    const controller=new AbortController(); const id=setTimeout(()=>controller.abort(),timeout);
    try{
      const r=await fetch(url,{signal:controller.signal}); clearTimeout(id);
      if(!r.ok) throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){ clearTimeout(id); throw e; }
  }

  function getCachedVehicle(key){
    const c=state.trainDetailsCache[key];
    if(!c) return null;
    if(Date.now()-c.ts > CACHE_TTL_MS){ delete state.trainDetailsCache[key]; return null; }
    return c.data;
  }
  function setCachedVehicle(key,data){ state.trainDetailsCache[key]={ts:Date.now(),data}; }

  // ---------- Disturbances ----------
  async function loadDisturbances(){
    try{
      const d=await fetchJsonWithTimeout(`${API_BASE}/disturbances/?format=json&lang=${utils.lang()}`,{timeout:5000});
      state.disturbances=d.disturbance||[];
    }catch(e){ console.warn('no disturbances',e); }
  }

  // ---------- Train details & composition ----------
  async function loadTrainDetails(vehicleId,dateStr){
    const key=utils.cacheKeyForVehicle(vehicleId,dateStr);
    const cached=getCachedVehicle(key); if(cached) return cached;
    try{
      const [vehicle,composition] = await Promise.all([
        fetchJsonWithTimeout(`${API_BASE}/vehicle/?id=${encodeURIComponent(vehicleId)}&format=json&lang=${utils.lang()}&date=${dateStr}`).catch(()=>null),
        fetchJsonWithTimeout(`${API_BASE}/composition/?id=${encodeURIComponent(vehicleId)}&format=json&date=${dateStr}`).catch(()=>null)
      ]);
      const det={vehicle,composition}; setCachedVehicle(key,det); return det;
    }catch(e){ console.error('details error',e); return {vehicle:null,composition:null}; }
  }

  // ---------- Rendering trains ----------
  function renderOccupancyBadge(occ){
    if(!occ||!occ.name||occ.name==='unknown') return '';
    const name=occ.name;
    const cls=name==='high'?'occ-high':(name==='medium'?'occ-medium':'');
    const pct=name==='high'?0.95:(name==='medium'?0.6:0.25);
    return `<span class="occupancy ${cls}" title="${name}"><span class="occ-bar"><span class="occ-fill" style="width:${pct*100}%"></span></span></span>`;
  }

  function showBannerIfDisturbances(trains){
    const d=state.disturbances||[];
    if(!d.length) return '';
    const rel=d.filter(x=>(x.title||'').toLowerCase().includes(state.station.toLowerCase())||(x.description||'').toLowerCase().includes(state.station.toLowerCase())).slice(0,3);
    if(!rel.length) return '';
    return `<div class="banner"><strong>⚠️ Perturbations</strong><div style="margin-top:6px">${rel.map(r=>r.title).join('<br>')}</div></div>`;
  }

  function renderTrainItem(t){
    const time=utils.formatTime(t.time);
    const num=(t.vehicleinfo&&t.vehicleinfo.shortname)||t.vehicle||'—';
    const plat=t.platform||'—';
    const delay=t.delay>0?`<div class=\"delay\">+${Math.floor(t.delay/60)} min</div>`:`<div class=\"delay\">À l'heure</div>`;
    const cancelled=(t.canceled==='1'||t.canceled===1||t.canceled===true);
    const occ=renderOccupancyBadge(t.occupancy);
    const direction=t.direction? (state.mode==='departure'?`→ ${t.direction.name}`:`${t.direction.name} →`):'';
    const dateStr=utils.getDateString(new Date(t.time*1000));

    return `
    <div class="train ${cancelled?'cancelled':''}" data-vehicle="${t.vehicle}" data-datestr="${dateStr}">
      <div class="left">
        <div class="train-number">${num} ${occ}</div>
        <div class="route">${state.mode==='departure'?`${state.station} ${direction}`:`${direction} ${state.station}`}</div>
        <div class="platform">Quai: ${plat}</div>
      </div>
      <div style="text-align:right">
        <div class="time">${time}</div>
        ${delay}
      </div>
    </div>
    <div class="details"></div>`;
  }

  async function processTrainsData(data){
    const cont=refs.trainsList; cont.innerHTML='';
    const key=state.mode+'s'; const trains=data[state.mode+'s']?data[state.mode+'