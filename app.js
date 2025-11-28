/* ============================================================
   NextTrain – app.js (Version Complète, Corrigée et Optimisée - v8)
   ============================================================ */

(function(){
  // ---------- CONFIGURATION ----------
  const CONFIG = {
    API_BASE: 'https://api.irail.be',
    CACHE_TTL: 5 * 60 * 1000,
    AUTO_REFRESH: 60000,
    DEBOUNCE_DELAY: 150,
    FETCH_TIMEOUT: 7000
  };

  // ---------- ÉTAT GLOBAL ----------
  const state = {
    mode: localStorage.getItem('nt_mode') || 'departure',
    station: localStorage.getItem('nt_station') || 'Libramont',
    allStations: [],
    disturbances: [],
    expandedVehicle: null,
    trainDetailsCache: {},
    autoRefreshHandle: null,
    isFetching: false
  };

  // ---------- STATIONS PAR LIGNE ----------
  const STATIONS = {
    "Bruxelles": [
      "Bruxelles-Midi","Bruxelles-Central","Bruxelles-Nord",
      "Bruxelles-Luxembourg","Bruxelles-Schuman","Bruxelles-Chapelle",
      "Bruxelles-Ouest","Etterbeek","Schaerbeek","Berchem-Sainte-Agathe"
    ],
    "Brabant Flamand": [
      "Leuven","Aarschot","Diest","Tienen","Landen","Herent",
      "Haacht","Rotselaar","Kessel-Lo","Heverlee"
    ],
    "Brabant Wallon": [
      "Wavre","Louvain-la-Neuve","Ottignies","Braine-l'Alleud",
      "Waterloo","Rixensart","Genval","La Hulpe"
    ],
    "Anvers": ["Antwerpen-Centraal","Antwerpen-Berchem","Antwerpen-Zuid","Mechelen"],
    "Flandre Occidentale": ["Bruges","Oostende","Kortrijk","Roeselare","Izegem"],
    "Flandre Orientale": ["Gent-Sint-Pieters","Aalst","Dendermonde","Sint-Niklaas","Lokeren"],
    "Limbourg": ["Hasselt","Genk","Sint-Truiden","Tongeren"],
    "Liège": ["Liège-Guillemins","Liège-Palais","Verviers-Central","Seraing"],
    "Namur": ["Namur","Ciney","Dinant","Gembloux","Marloie"],
    "Hainaut": ["Mons","Charleroi-Sud","Tournai","Mouscron","La Louvière-Sud"],
    "Luxembourg": ["Libramont","Arlon","Neufchâteau","Virton"],
    "Autres connexions": ["Luxembourg","Maastricht","Roosendaal","Lille-Flandres"]
  };

  // ---------- UTILITAIRES ----------
  const Utils = {
    lang() {
      const nav = navigator.language || 'fr-BE';
      return nav.startsWith('fr') ? 'fr' : 'en';
    },

    nowSeconds() {
      return Math.floor(Date.now() / 1000);
    },

    formatTime(timestamp) {
      const date = new Date(timestamp * 1000);
      return date.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' });
    },

    getDateString(date = new Date()) {
      const d = String(date.getDate()).padStart(2,'0');
      const m = String(date.getMonth()+1).padStart(2,'0');
      const y = String(date.getFullYear()).slice(-2);
      return `${d}${m}${y}`;
    },

    debounce(func, delay) {
      let timeout;
      return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this,args), delay);
      };
    },

    cacheKey(vehicleId,dateStr) {
      return `${vehicleId}_${dateStr}`;
    },

    getDistance(lat1,lon1,lat2,lon2) {
      const R = 6371;
      const dLat = (lat2-lat1)*Math.PI/180;
      const dLon = (lon2-lon1)*Math.PI/180;
      const a = Math.sin(dLat/2)**2 +
                Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180) *
                Math.sin(dLon/2)**2;
      const c = 2 * Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
      return R*c;
    }
  };

  // ---------- DOM ----------
  const DOM = {
    stationNameText: document.getElementById('stationNameText'),
    stationSelect: document.getElementById('stationSelect'),
    stationSearch: document.getElementById('stationSearch'),
    tabDeparture: document.getElementById('tabDeparture'),
    tabArrival: document.getElementById('tabArrival'),
    trainsList: document.getElementById('trainsList'),
    locateBtn: document.getElementById('locateBtn'),
    refreshBtn: document.getElementById('refreshBtn')
  };

  // ---------- CACHE ----------
  const Cache = {
    get(key) {
      const cached = state.trainDetailsCache[key];
      if (!cached) return null;

      if (Date.now() - cached.timestamp > CONFIG.CACHE_TTL) {
        delete state.trainDetailsCache[key];
        return null;
      }
      return cached.data;
    },

    set(key,data) {
      state.trainDetailsCache[key] = {
        timestamp: Date.now(),
        data
      };
    }
  };

  // ---------- API ----------
  const API = {
    async fetchWithTimeout(url, options={}) {
      const timeout = options.timeout || CONFIG.FETCH_TIMEOUT;
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url,{signal:controller.signal});
        clearTimeout(id);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (err) {
        clearTimeout(id);
        throw err;
      }
    },

    getDisturbances() {
      return this.fetchWithTimeout(
        `${CONFIG.API_BASE}/disturbances/?format=json&lang=${Utils.lang()}`,
        { timeout:5000 }
      ).then(d => d.disturbance || []).catch(() => []);
    },

    getAllStations() {
      return this.fetchWithTimeout(
        `${CONFIG.API_BASE}/stations/?format=json&lang=${Utils.lang()}`,
        { timeout:10000 }
      ).then(d => d.station || []).catch(() => []);
    },

    getStationBoard(station,mode) {
      const arrdep = mode === "arrival" ? "ARR" : "DEP";
      const url = `${CONFIG.API_BASE}/liveboard/?station=${encodeURIComponent(station)}&arrdep=${arrdep}&lang=${Utils.lang()}&format=json`;
      return this.fetchWithTimeout(url);
    },

    async getVehicleDetails(vehicleId,dateStr) {
      const key = Utils.cacheKey(vehicleId,dateStr);
      const cached = Cache.get(key);
      if (cached) return cached;

      try {
        const [vehicle,composition] = await Promise.all([
          this.fetchWithTimeout(`${CONFIG.API_BASE}/vehicle/?id=${encodeURIComponent(vehicleId)}&format=json&lang=${Utils.lang()}&date=${dateStr}`).catch(()=>null),
          this.fetchWithTimeout(`${CONFIG.API_BASE}/composition/?id=${encodeURIComponent(vehicleId)}&format=json&date=${dateStr}`).catch(()=>null)
        ]);

        const details = { vehicle, composition };
        Cache.set(key,details);
        return details;

      } catch(err) {
        return { vehicle:null, composition:null };
      }
    }
  };

  // ---------- UI ----------
  const UI = {
    updateHeader() {
      DOM.stationNameText.textContent = state.station;
      DOM.tabDeparture.classList.toggle("active", state.mode === "departure");
      DOM.tabArrival.classList.toggle("active", state.mode === "arrival");
    },

    renderStationSelect(filter='') {
      const select = DOM.stationSelect;
      select.innerHTML = '';

      let count = 0;

      if (state.allStations.length > 0) {
        const fl = filter.toLowerCase();
        const stations = state.allStations
          .filter(s => fl==='' || s.standardname.toLowerCase().includes(fl))
          .slice(0,50)
          .sort((a,b) => a.standardname.localeCompare(b.standardname));

        count = stations.length;

        select.innerHTML = stations
          .map(s => `<option value="${s.standardname}" ${s.standardname===state.station?'selected':''}>${s.standardname}</option>`)
          .join('');
      }

      if (filter) {
        select.style.display = 'block';
        if (count === 0) select.innerHTML = '<option disabled>❌ Aucune gare trouvée</option>';
        if (count === 50) select.innerHTML += '<option disabled>… (limité à 50)</option>';
      } else {
        select.style.display = 'none';
      }
    },

    renderOccupancy(occ) {
      if (!occ || !occ.name || occ.name === 'unknown') return '';
      const level = occ.name;
      const pct = level === 'high' ? 95 : level === 'medium' ? 60 : 25;
      const css = level === 'high' ? 'occ-high' : level === 'medium' ? 'occ-medium' : '';
      return `
        <span class="occupancy ${css}">
          <span class="occ-bar"><span class="occ-fill" style="width:${pct}%"></span></span>
        </span>`;
    },

    renderDisturbanceBanner() {
      const relevant = state.disturbances
        .filter(d => `${d.title} ${d.description}`.toLowerCase().includes(state.station.toLowerCase()))
        .slice(0,3);

      if (relevant.length === 0) return '';

      return `
        <div class="banner">
          <strong>⚠️ Perturbations</strong>
          <div style="margin-top:6px">${relevant.map(d=>d.title).join('<br>')}</div>
        </div>`;
    },

    renderTrain(train) {
      const time = Utils.formatTime(train.time);
      const platform = train.platform || '—';
      const canceled = train.canceled == '1' || train.canceled === true;
      const delayMin = Math.floor(train.delay/60);
      const delayText = train.delay>0
        ? `<div class="delay delayed">+${delayMin} min</div>`
        : `<div class="delay on-time">À l'heure</div>`;

      const occupancy = this.renderOccupancy(train.occupancy);

      // Destination / origine
      const potentials = [
        train.direction?.name,
        train.stationinfo?.standardname,
        train.stationInfo?.name,
        train.name?.split(' ')[1]
      ].filter(Boolean);

      const norm = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,'');

      let mainStation = null;
      for (const src of potentials) {
        if (norm(src) !== norm(state.station)) {
          mainStation = src;
          break;
        }
      }

      const routeText = mainStation
        ? (state.mode==='departure' ? `Vers ${mainStation}` : `Depuis ${mainStation}`)
        : `Gare: ${state.station} (INFO API MANQUANTE ❌)`;


      // Numéro court du train
      let number = '—';
      if (train.vehicle) {
        if (train.vehicle.shortname) number = train.vehicle.shortname;
        else {
          const parts = train.vehicle.split('.');
          number = parts[parts.length-1] || number;
        }
      }

      const dateStr = Utils.getDateString(new Date(train.time*1000));

      return `
        <div class="train ${canceled?'cancelled':''}"
             data-vehicle="${train.vehicle}"
             data-datestr="${dateStr}">
          <div class="left">
            <div class="train-number">${number} ${occupancy}</div>
            <div class="route">${routeText}</div>
            <div class="platform">Voie: ${platform}</div>
          </div>
          <div style="text-align:right">
            <div class="time">${time}</div>
            ${delayText}
          </div>
        </div>
        <div class="details"></div>`;
    },

    renderTrainDetails(details,currentStation) {
      let html = '';

      // ------------------- Arrêts -------------------
      if (details.vehicle?.stops?.stop) {
        const raw = details.vehicle.stops.stop;
        const stops = Array.isArray(raw) ? raw : [raw];

        html += `<h4>Itinéraire</h4><div class="metro-line">`;

        const now = Utils.nowSeconds();
        let lastPassed = -1;

        stops.forEach((stop,i)=>{
          const t = parseInt(stop.time)+(parseInt(stop.delay||0));
          if (t <= now) lastPassed = i;
        });

        stops.forEach((stop,i)=>{
          const isCurrent = norm(stop.station) === norm(currentStation);
          const isTrainHere = i === lastPassed;
          const isPassed = i < lastPassed;

          const delay = parseInt(stop.delay||0);
          const delayMin = Math.floor(delay/60);
          const delayTxt = delay>0 ? ` <span class="stop-delay">+${delayMin}min</span>` : '';

          const canceled = stop.canceled=='1' || stop.canceled===1;

          html += `
            <div class="metro-stop ${isCurrent?'current':''} ${isPassed?'passed':''} ${isTrainHere?'train-position':''}">
              <div class="metro-dot">${isTrainHere?'🚂':''}</div>
              <div class="metro-info">
                <div class="metro-station">
                  ${stop.station}
                  ${canceled?'<span class="stop-canceled">Annulé</span>':''}
                  ${isTrainHere?'<span class="train-here">Train ici</span>':''}
                  ${stop.platform?` <span class="stop-platform">Voie ${stop.platform}</span>`:''}
                </div>
                <div class="metro-time">${Utils.formatTime(stop.time)}${delayTxt}</div>
              </div>
            </div>`;
        });

        html += `</div>`;
      } else {
        html += `<div class="info">ℹ️ Itinéraire indisponible</div>`;
      }

      // ------------------- Composition -------------------
      if (details.composition?.composition?.segments?.segment) {
        const raw = details.composition.composition.segments.segment;
        const segments = Array.isArray(raw) ? raw : [raw];

        html += `<h4 style="margin-top:16px">Composition</h4>`;
        html += `<div class="train-composition">`;

        const seen = new Set();

        segments.forEach(seg=>{
          const unitsRaw = seg?.composition?.units?.unit;
          if (!unitsRaw) return;

          const units = Array.isArray(unitsRaw)?unitsRaw:[unitsRaw];

          units.forEach(u=>{
            const id = u.id || u.materialType || Math.random();
            if (seen.has(id)) return;
            seen.add(id);

            const type = (u.materialType?.parent_type || u.materialType || '?').toString().toUpperCase();

            let icon='🚃', css='wagon';
            if (type.includes('HLE')) { icon='🚂'; css='loco'; }
            else if (type.includes('AM')) { icon='🚊'; css='emu'; }

            html += `
              <div class="train-unit ${css}">
                <div class="unit-icon">${icon}</div>
                <div class="unit-type">${u.materialType||"?"}</div>
              </div>`;
          });
        });

        html += `</div><p style="text-align:center;font-size:11px;color:#64748b;margin-top:8px">← Sens de marche</p>`;
      } else {
        html += `<h4 style="margin-top:16px">Composition</h4><div class="info">ℹ️ Indisponible</div>`;
      }

      return html;
    },

    async renderTrainsList(data) {
      const container = DOM.trainsList;
      container.innerHTML = '';

      const key = state.mode === "departure" ? "departures" : "arrivals";
      const raw = data[key];

      if (!raw) {
        container.innerHTML = `<div class="info">Aucun train pour ${state.station}.</div>`;
        return;
      }

      const trainsKey = state.mode==='departure' ? 'departure' : 'arrival';
      const trains = raw[trainsKey] || [];
      const arr = Array.isArray(trains) ? trains : [trains];

      container.innerHTML += this.renderDisturbanceBanner();

      if (arr.length === 0) {
        container.innerHTML += `<div class="info">Aucun train prévu.</div>`;
        return;
      }

      arr.forEach(t => container.innerHTML += this.renderTrain(t));
    },

    showLoading() {
      DOM.trainsList.innerHTML = `
        <div class="loading">
          <div class="spinner"></div>
          <div style="margin-top:10px">Chargement…</div>
        </div>`;
    },

    showError(msg) {
      DOM.trainsList.innerHTML = `<div class="error">⚠️ ${msg}</div>`;
    }
  };

  // ---------- ÉVÉNEMENTS ----------
  const Events = {
    async handleTrainClick(e) {
      const trainEl = e.target.closest('.train');
      if (!trainEl) return;

      const vehicle = trainEl.dataset.vehicle;
      const dateStr = trainEl.dataset.datestr;
      const detailsEl = trainEl.nextElementSibling;
      const expanded = trainEl.classList.contains('expanded');

      document.querySelectorAll('.train.expanded').forEach(el=>{
        el.classList.remove('expanded');
        el.nextElementSibling.innerHTML='';
      });

      if (expanded) {
        state.expandedVehicle = null;
        return;
      }

      trainEl.classList.add('expanded');
      detailsEl.innerHTML = `<div class="loading"><div class="spinner small"></div> Chargement…</div>`;

      const details = await API.getVehicleDetails(vehicle,dateStr);
      detailsEl.innerHTML = UI.renderTrainDetails(details,state.station);
    },

    handleStationSearch: Utils.debounce((e)=>{
      UI.renderStationSelect(e.target.value);
    }, CONFIG.DEBOUNCE_DELAY),

    handleStationSelect(e) {
      state.station = e.target.value;
      DOM.stationSelect.style.display='none';
      DOM.stationSearch.value='';
      App.saveState();
      App.init();
    },

    handleModeChange(mode) {
      state.mode = mode;
      App.saveState();
      App.init();
    },

    handleDocumentClick(e) {
      if (!DOM.stationSelect.contains(e.target) &&
          !DOM.stationSearch.contains(e.target)) {
        DOM.stationSelect.style.display='none';
      }
    },

    async handleLocate() {
      if (!navigator.geolocation) {
        alert("Géolocalisation non disponible");
        return;
      }

      DOM.locateBtn.disabled=true;
      DOM.locateBtn.textContent="📍 Localisation…";

      try {
        const pos = await new Promise((resolve,reject)=>{
          navigator.geolocation.getCurrentPosition(resolve,reject,{timeout:10000});
        });

        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;

        if (state.allStations.length === 0) {
          alert("Stations en cours de chargement…");
          return;
        }

        let best=null, bestDist=Infinity;
        state.allStations.forEach(st=>{
          if (st.locationY && st.locationX) {
            const d = Utils.getDistance(lat,lon,parseFloat(st.locationY),parseFloat(st.locationX));
            if (d < bestDist) {
              bestDist = d;
              best = st;
            }
          }
        });

        if (best) {
          state.station = best.standardname;
          App.saveState();
          App.init(true);
          DOM.stationNameText.textContent = `${best.standardname} (${bestDist.toFixed(1)} km)`;
          setTimeout(()=>DOM.stationNameText.textContent=best.standardname,3000);
        }

      } catch(err) {
        alert("Géolocalisation refusée ou impossible");
      } finally {
        DOM.locateBtn.disabled=false;
        DOM.locateBtn.textContent="📍 Localiser";
      }
    }
  };

  // ---------- APPLICATION ----------
  const App = {
    saveState() {
      localStorage.setItem('nt_mode', state.mode);
      localStorage.setItem('nt_station', state.station);
    },

    setupListeners() {
      DOM.stationSearch.addEventListener('input', Events.handleStationSearch);
      DOM.stationSelect.addEventListener('change', Events.handleStationSelect);
      DOM.tabDeparture.addEventListener('click',()=>Events.handleModeChange('departure'));
      DOM.tabArrival.addEventListener('click',()=>Events.handleModeChange('arrival'));
      DOM.refreshBtn.addEventListener('click',()=>this.init(true));
      DOM.trainsList.addEventListener('click',Events.handleTrainClick);
      DOM.locateBtn.addEventListener('click',Events.handleLocate);
      document.addEventListener('click',Events.handleDocumentClick);
    },

    async tryGeolocation() {
      const saved = localStorage.getItem('nt_station');
      if (saved) return false;
      if (!navigator.geolocation) return false;

      try {
        const pos = await new Promise((resolve,reject)=>{
          navigator.geolocation.getCurrentPosition(resolve,reject,{timeout:5000});
        });

        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;

        let tries=0;
        while (state.allStations.length===0 && tries<20) {
          await new Promise(r=>setTimeout(r,200));
          tries++;
        }
        if (state.allStations.length===0) return false;

        let best=null, bestDist=Infinity;
        state.allStations.forEach(st=>{
          if (st.locationY && st.locationX) {
            const d = Utils.getDistance(lat,lon,parseFloat(st.locationY),parseFloat(st.locationX));
            if (d < bestDist) {
              bestDist = d;
              best = st;
            }
          }
        });

        if (best && bestDist<50) {
          state.station = best.standardname;
          this.saveState();
          return true;
        }

      } catch(err) {
        return false;
      }
      return false;
    },

    async init(force=false) {
      if (state.isFetching && !force) return;
      state.isFetching=true;

      UI.updateHeader();
      UI.showLoading();

      if (state.autoRefreshHandle) clearTimeout(state.autoRefreshHandle);

      try {
        if (state.allStations.length===0) {
          state.allStations = await API.getAllStations();
        }

        state.disturbances = await API.getDisturbances();

        const data = await API.getStationBoard(state.station,state.mode);
        await UI.renderTrainsList(data);

        state.autoRefreshHandle = setTimeout(()=>this.init(),CONFIG.AUTO_REFRESH);

      } catch(err) {
        UI.showError(`Impossible de charger les horaires. (${err.message})`);
      } finally {
        state.isFetching=false;
      }
    },

    async start() {
      this.setupListeners();
      const init = this.init();
      const geo = await this.tryGeolocation();
      if (geo) await this.init(true);
      else await init;
    }
  };

  // ---------- DÉMARRAGE ----------
  App.start();

})();

/* ============================================================
   ENREGISTREMENT SERVICE WORKER (Avec HOT-UPDATE)
   ============================================================ */

if ('serviceWorker' in navigator) {

  window.addEventListener('load', () => {

    navigator.serviceWorker.register('/service-worker.js')
      .then(reg => {

        console.log('Service Worker enregistré');

        // Détection de nouvelle version
        reg.addEventListener('updatefound', () => {
          const newSW = reg.installing;

          newSW.addEventListener('statechange', () => {
            if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
              // Forcer immédiatement l’activation
              newSW.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });

      })
      .catch(err => console.log('Erreur SW:', err));

  });

  // 🔥 Hot update : écouter le SW
  navigator.serviceWorker.addEventListener('message', event => {

    if (event.data?.type === 'CONTROLLER_CHANGE') {
      console.log('🔄 Nouveau SW actif → reload');
      window.location.reload();
    }

    if (event.data?.type === 'UPDATE_READY') {
      console.log('🔥 Nouvelle version disponible → reload');
      window.location.reload();
    }
  });

} 
