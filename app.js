/* ============================================================
   NextTrain — app.js (Réécrit et Optimisé)
   ============================================================ */

(function(){
  // ---------- CONFIG ----------
  const API_BASE = 'https://api.irail.be';
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const AUTO_REFRESH_MS = 60000;
  const MAX_RETRIES = 2; // Non utilisé dans l'extrait fourni, mais conservé

  // ---------- STATE ----------
  const state = {
    mode: localStorage.getItem('nt_mode') || 'departure',
    station: localStorage.getItem('nt_station') || 'Libramont',
    stationsList: [], // Non utilisé dans l'extrait fourni, mais conservé
    disturbances: [],
    expandedVehicle: null, // Non utilisé dans l'extrait fourni, mais conservé
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
    cacheKeyForVehicle(id,date){ return `${id}_${date}` },
    // NOUVEAU : Fonction de Debounce pour améliorer la performance de la recherche
    debounce(func, delay) {
      let timeout;
      return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), delay);
      };
    }
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
    let optionsCount = 0; // Compteur pour gérer l'affichage de la liste
    Object.keys(stationsByLine).forEach(cat=>{
      const og=document.createElement('optgroup'); og.label=cat;
      stationsByLine[cat].forEach(s=>{
        if(!filter || s.toLowerCase().includes(filter.toLowerCase())){
          const o=document.createElement('option'); o.value=s; o.textContent=s;
          if(s===state.station) o.selected=true;
          og.appendChild(o);
          optionsCount++;
        }
      });
      // Ajouter l'optgroup seulement s'il contient des options filtrées
      if(og.children.length > 0) frag.appendChild(og);
    });
    sel.appendChild(frag);

    // Afficher/Masquer la liste déroulante en fonction du filtre
    refs.stationSelect.style.display = (filter && optionsCount > 0) ? 'block' : 'none';
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

  // NOTE: Cette fonction était incomplète dans l'extrait initial, j'ai ajouté la gestion d'erreur et d'absence de trains.
  async function processTrainsData(data){
    const cont=refs.trainsList; cont.innerHTML='';
    const key=state.mode+'s'; 
    const trains=data[key] && data[key].train ? (Array.isArray(data[key].train) ? data[key].train : [data[key].train]) : [];

    // Afficher les perturbations en premier
    cont.innerHTML += showBannerIfDisturbances(trains);

    if (trains.length === 0) {
      cont.innerHTML += `<div class="info">Aucun ${state.mode === 'departure' ? 'départ' : 'arrivée'} prévu pour la gare de ${state.station}.</div>`;
      return;
    }

    // Rendre les trains
    trains.forEach(t => {
      cont.innerHTML += renderTrainItem(t);
    });
  }
  
  // ---------- Event Handlers ----------

  // Gestion de la saisie dans le champ de recherche
  function handleSearchInput(e){
    const filter = e.target.value;
    renderStationSelect(filter);
    // Le masquage/affichage est désormais géré dans renderStationSelect pour plus de cohérence
  }

  // Gestion du clic sur un train pour afficher les détails (fonction manquante, ajoutée pour compléter la logique)
  async function handleTrainClick(e) {
      const trainEl = e.target.closest('.train');
      if (!trainEl) return;

      const vehicleId = trainEl.dataset.vehicle;
      const dateStr = trainEl.dataset.datestr;
      const detailsEl = trainEl.nextElementSibling;

      // Toggle l'état d'expansion
      const isExpanded = trainEl.classList.contains('expanded');

      // 1. Fermer tous les autres trains
      document.querySelectorAll('.train.expanded').forEach(el => {
          el.classList.remove('expanded');
          el.nextElementSibling.innerHTML = '';
      });

      if (isExpanded) {
          // Si on était déjà expanded, on vient de fermer
          state.expandedVehicle = null;
          return;
      }

      // 2. Ouvrir le train actuel
      trainEl.classList.add('expanded');
      state.expandedVehicle = vehicleId;

      // 3. Afficher le loader
      detailsEl.innerHTML = `<div class="loading"><div class="spinner small"></div>Chargement des détails...</div>`;

      // 4. Charger les détails
      const details = await loadTrainDetails(vehicleId, dateStr);

      // 5. Rendre les détails (simplifié pour cet exemple)
      let content = '<h4>Détails du train</h4>';
      if (details.vehicle && details.vehicle.stops) {
          content += `<div class="stops">Stops: ${details.vehicle.stops.stop.map(s => `<div>${s.station} (${utils.formatTime(s.time)})</div>`).join('')}</div>`;
      } else {
          content += '<p>Détails d\'arrêt non disponibles.</p>';
      }

      if (details.composition) {
          content += `<h4>Composition</h4><p>Nombre de voitures: ${details.composition.nrOfCars || 'N/A'}</p>`;
          // Logique de rendu de wagons (simplifiée)
      } else {
          content += '<p>Composition non disponible.</p>';
      }

      detailsEl.innerHTML = content;
  }
  
  function setupListeners(){
    // 1. Recherche de gare : Utilise DEBOUNCE (300ms) pour éviter de recalculer à chaque frappe (OPTIMISATION)
    refs.stationSearch.addEventListener(
      'input', 
      utils.debounce(handleSearchInput, 300)
    );
    
    // 2. Sélection de gare
    refs.stationSelect.addEventListener('change', (e) => {
      state.station = e.target.value;
      refs.stationSelect.style.display = 'none'; // Masquer la liste après sélection
      refs.stationSearch.value = ''; // Vider la recherche
      saveState();
      init(); // Recharger les données pour la nouvelle gare
    });
    
    // 3. Onglets de mode (Départ/Arrivée)
    refs.tabDeparture.addEventListener('click', () => { state.mode='departure'; saveState(); init(); });
    refs.tabArrival.addEventListener('click', () => { state.mode='arrival'; saveState(); init(); });
    
    // 4. Bouton Actualiser
    refs.refreshBtn.addEventListener('click', () => init(true));

    // 5. Clic sur un train pour détails
    refs.trainsList.addEventListener('click', handleTrainClick);

    // 6. Gestion du clic pour masquer la liste de sélection si l'utilisateur clique en dehors de la recherche.
    document.addEventListener('click', (e) => {
      const isSelect = refs.stationSelect.contains(e.target);
      const isSearch = refs.stationSearch.contains(e.target);
      if (!isSelect && !isSearch) {
          refs.stationSelect.style.display = 'none';
      }
    });

    // NOTE: locateBtn (géolocalisation) nécessite une implémentation séparée de l'API de géolocalisation.
  }

  // ---------- Initialisation ----------

  async function init(forceRefresh = false){
    // Utiliser isFetching pour éviter les appels multiples
    if(state.isFetching && !forceRefresh) return;
    state.isFetching = true;

    // 1. Mise à jour de l'interface
    renderHeader();
    renderStationSelect(); 
    
    // 2. Annuler l'auto-refresh précédent
    if(state.autoRefreshHandle) clearTimeout(state.autoRefreshHandle);

    // 3. Afficher l'indicateur de chargement
    refs.trainsList.innerHTML = `<div class="loading" id="initialLoading"><div class="spinner"></div><div style="margin-top:10px">Chargement des horaires...</div></div>`;

    try{
      // 4. Charger les perturbations (en parallèle)
      await loadDisturbances(); 
      
      // 5. Charger les horaires
      const url = `${API_BASE}/board/?station=${encodeURIComponent(state.station)}&lang=${utils.lang()}&format=json`;
      const data = await fetchJsonWithTimeout(url);
      
      // 6. Rendre les trains
      await processTrainsData(data);

      // 7. Configurer l'auto-refresh
      state.autoRefreshHandle = setTimeout(init, AUTO_REFRESH_MS);

    } catch(e) {
      console.error('Initialisation Error:', e);
      refs.trainsList.innerHTML = `<div class="error">Impossible de charger les horaires pour le moment. Veuillez réessayer. (${e.message})</div>`;
    } finally {
      state.isFetching = false;
    }
  }

  // Lancement de l'application
  setupListeners();
  init();

})(); // Fin de l'IIFE