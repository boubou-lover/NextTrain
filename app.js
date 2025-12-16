/* ============================================================
   NextTrain – app.js (Version Complète et Optimisée)
   - Recherche gares + autocomplete
   - Recherche train globale (numéro chiffres) + validation Android (Enter/loupe)
   - Itinéraire cliquable (gare -> liveboard)
   - Date affichée en JJ/MM/AAAA (sans casser l'API ddmmyy)
   ============================================================ */

(function(){
  // ---------- CONFIGURATION ----------
  const CONFIG = {
  API_BASE: 'https://api.irail.be',
  CACHE_TTL: 5 * 60 * 1000,       // Cache mémoire pour détails trains
  AUTO_REFRESH: 60000,
  DEBOUNCE_DELAY: 150,
  FETCH_TIMEOUT: 7000,
  OFFLINE_STATIONS_TTL: 7 * 24 * 60 * 60 * 1000, // 7 jours
  OFFLINE_LIVEBOARD_TTL: 10 * 60 * 1000,         // 10 minutes
  GLOBAL_SEARCH_CACHE_TTL: 30 * 60 * 1000,       // 30 minutes (résultats)
  GLOBAL_SEARCH_NEGATIVE_TTL: 2 * 60 * 1000,     // 2 minutes (pas trouvé)
  GLOBAL_SEARCH_CONCURRENCY: 6                   // parallélisme recherche
};

  // ---------- ÉTAT GLOBAL ----------
  const state = {
    mode: localStorage.getItem('nt_mode') || 'departure',
    station: localStorage.getItem('nt_station') || 'Libramont',
    allStations: [],              // Liste complète depuis l'API
    allStationsNormalized: [],    // Index pour recherche rapide
    disturbances: [],
    expandedVehicle: null,
    trainDetailsCache: {},
    autoRefreshHandle: null,
    isFetching: false,
    globalTrainSearchCache: {}
  };

  // ---------- STATIONS HUBS (pour marquer les correspondances possibles) ----------
  const STATIONS = {
    'Bruxelles': [
      'Bruxelles-Midi', 'Bruxelles-Central', 'Bruxelles-Nord',
      'Bruxelles-Luxembourg', 'Bruxelles-Schuman', 'Bruxelles-Chapelle',
      'Bruxelles-Ouest', 'Etterbeek', 'Schaerbeek', 'Berchem-Sainte-Agathe'
    ],
    'Brabant Flamand': [
      'Leuven', 'Aarschot', 'Diest', 'Tienen', 'Landen', 'Herent',
      'Haacht', 'Rotselaar', 'Kessel-Lo', 'Heverlee', 'Oud-Heverlee',
      'Korbeek-Lo', 'Neerijse', 'Loonbeek', 'Wilsele'
    ],
    'Brabant Wallon': [
      'Wavre', 'Louvain-la-Neuve', 'Ottignies', 'Braine-l\'Alleud',
      'Waterloo', 'Rixensart', 'Genval', 'La Hulpe', 'Profondsart',
      'Bierges-Walibi', 'Limal', 'Court-Saint-Etienne'
    ],
    'Anvers': [
      'Antwerpen-Centraal', 'Antwerpen-Berchem', 'Antwerpen-Zuid',
      'Mechelen', 'Lier', 'Heist-op-den-Berg', 'Duffel', 'Kontich',
      'Mortsel', 'Puurs', 'Willebroek'
    ],
    'Flandre Occidentale': [
      'Bruges', 'Oostende', 'Kortrijk', 'Roeselare', 'Izegem',
      'De Panne', 'Knokke', 'Blankenberge', 'Veurne', 'Diksmuide',
      'Torhout', 'Waregem', 'Wielsbeke', 'Harelbeke'
    ],
    'Flandre Orientale': [
      'Gent-Sint-Pieters', 'Aalst', 'Dendermonde', 'Sint-Niklaas',
      'Lokeren', 'Wetteren', 'Oudenaarde', 'Ronse', 'Geraardsbergen',
      'Zottegem', 'Ninove', 'Eeklo', 'Zelzate', 'Melle'
    ],
    'Limbourg': [
      'Hasselt', 'Genk', 'Sint-Truiden', 'Tongeren', 'Bilzen',
      'Bree', 'Lommel', 'Mol', 'Beringen', 'Diepenbeek'
    ],
    'Liège': [
      'Liège-Guillemins', 'Liège-Palais', 'Verviers-Central', 'Seraing',
      'Herstal', 'Ans', 'Flémalle-Haute', 'Angleur', 'Chênée',
      'Pepinster', 'Spa', 'Trooz', 'Bressoux', 'Kinkempois',
      'Sclessin', 'Jemeppe-sur-Meuse', 'Engis', 'Hermalle-sous-Argenteau'
    ],
    'Namur': [
      'Namur', 'Ciney', 'Dinant', 'Gembloux', 'Marloie', 'Jemelle',
      'Assesse', 'Spy', 'Tamines', 'Andenne', 'Jambes',
      'Dave', 'Yvoir', 'Spontin', 'Godinne', 'Anhée'
    ],
    'Hainaut': [
      'Mons', 'Charleroi-Sud', 'Tournai', 'Mouscron', 'La Louvière-Sud',
      'Braine-le-Comte', 'Ath', 'Binche', 'Manage', 'Jemappes',
      'Quévy', 'Soignies', 'Lessines', 'Leuze', 'Enghien',
      'Marchienne-au-Pont', 'Châtelet', 'Farciennes', 'Montignies-sur-Sambre',
      'Gosselies', 'Fleurus', 'Jumet', 'Frameries', 'Quiévrain',
      'Boussu', 'Saint-Ghislain', 'Péruwelz', 'Silly', 'Comines'
    ],
    'Luxembourg': [
      'Libramont', 'Arlon', 'Neufchâteau', 'Virton', 'Bertrix',
      'Marche-en-Famenne', 'Bastogne', 'Gouvy', 'Marbehan',
      'Habay', 'Florenville', 'Stockem', 'Athus', 'Rodange',
      'Poix-Saint-Hubert', 'Barvaux', 'Melreux-Hotton'
    ],
    'Autres connexions': [
      'Luxembourg', 'Maastricht', 'Roosendaal', 'Essen', 'Lille-Flandres'
    ]
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

    // ddmmyy (pour l'API iRail)
    getDateString(date = new Date()) {
      const d = String(date.getDate()).padStart(2, '0');
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const y = String(date.getFullYear()).slice(-2);
      return `${d}${m}${y}`;
    },

    // JJ/MM/AAAA (affichage)
    formatDateFR(dateInput) {
      const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
      if (Number.isNaN(d.getTime())) return '';
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = d.getFullYear();
      return `${day}/${month}/${year}`;
    },

    // ddmmyy -> JJ/MM/AAAA
    formatDDMMYYToFR(ddmmyy) {
      const s = String(ddmmyy || '').replace(/\D/g, '');
      if (s.length !== 6) return s || '';
      const dd = s.slice(0, 2);
      const mm = s.slice(2, 4);
      const yy = s.slice(4, 6);
      const yyyy = (parseInt(yy, 10) >= 70 ? `19${yy}` : `20${yy}`);
      return `${dd}/${mm}/${yyyy}`;
    },

    debounce(func, delay) {
      let timeout;
      return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
      };
    },

    cacheKey(vehicleId, dateStr) {
      return `${vehicleId}_${dateStr}`;
    },

    // Haversine
    getDistance(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return R * c;
    },

    normalize(str) {
      return (str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '');
    },

    buildStationsIndex() {
      state.allStationsNormalized = state.allStations.map(s => ({
        raw: s,
        norm: Utils.normalize(s.standardname)
      }));
    },

    isConnectionStation(name) {
      if (!name) return false;
      const target = name.toLowerCase();
      for (const region in STATIONS) {
        if (STATIONS[region].some(st => st.toLowerCase() === target)) return true;
      }
      return false;
    }
  };

  // ---------- RÉFÉRENCES DOM ----------
  const DOM = {
    stationNameText: document.getElementById('stationNameText'),
    stationSelect: document.getElementById('stationSelect'),
    stationSearch: document.getElementById('stationSearch'),
    trainSearch: document.getElementById('trainSearch'),
    tabDeparture: document.getElementById('tabDeparture'),
    tabArrival: document.getElementById('tabArrival'),
    trainsList: document.getElementById('trainsList'),
    locateBtn: document.getElementById('locateBtn'),
    refreshBtn: document.getElementById('refreshBtn')
  };

  // ---------- GESTION DU CACHE EN MÉMOIRE ----------
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
    set(key, data) {
      state.trainDetailsCache[key] = { timestamp: Date.now(), data };
    }
  };

  // ---------- GESTION DU CACHE OFFLINE (localStorage) ----------
  const Offline = {
    saveStations(stations) {
      try {
        localStorage.setItem('nt_allStations', JSON.stringify({ timestamp: Date.now(), stations }));
      } catch (e) {
        console.warn('Impossible de stocker les gares offline', e);
      }
    },
    loadStations() {
      try {
        const raw = localStorage.getItem('nt_allStations');
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (Date.now() - data.timestamp > CONFIG.OFFLINE_STATIONS_TTL) return null;
        return data.stations || [];
      } catch (e) {
        console.warn('Erreur lecture gares offline', e);
        return null;
      }
    },
    liveboardKey(station, mode) {
      return `nt_liveboard_${station}_${mode}`;
    },
    saveLiveboard(station, mode, data) {
      try {
        localStorage.setItem(this.liveboardKey(station, mode), JSON.stringify({ timestamp: Date.now(), data }));
      } catch (e) {
        console.warn('Impossible de stocker le liveboard offline', e);
      }
    },
    loadLiveboard(station, mode) {
      try {
        const raw = localStorage.getItem(this.liveboardKey(station, mode));
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (Date.now() - data.timestamp > CONFIG.OFFLINE_LIVEBOARD_TTL) return null;
        return data.data;
      } catch (e) {
        console.warn('Erreur lecture liveboard offline', e);
        return null;
      }
    }
  };

  // ---------- API ----------
  const API = {
    async fetchWithTimeout(url, options = {}) {
  const timeout = options.timeout || CONFIG.FETCH_TIMEOUT;

  // Support d'un AbortSignal externe (utile pour annuler une recherche globale)
  const externalSignal = options.signal;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  let onAbort = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    onAbort = () => controller.abort();
    try { externalSignal.addEventListener('abort', onAbort, { once: true }); } catch (_) {}
  }

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal && onAbort) {
      try { externalSignal.removeEventListener('abort', onAbort); } catch (_) {}
    }
  }
},


    async getDisturbances() {
      try {
        const url = `${CONFIG.API_BASE}/disturbances/?format=json&lang=${Utils.lang()}`;
        const data = await this.fetchWithTimeout(url, { timeout: 5000 });
        return data.disturbance || [];
      } catch (error) {
        console.warn('Erreur chargement perturbations:', error);
        return [];
      }
    },

    async getAllStations() {
      try {
        const url = `${CONFIG.API_BASE}/stations/?format=json&lang=${Utils.lang()}`;
        const data = await this.fetchWithTimeout(url, { timeout: 10000 });
        const stations = data.station || [];
        Offline.saveStations(stations);
        return stations;
      } catch (error) {
        console.warn('Erreur chargement stations, tentative offline:', error);
        return Offline.loadStations() || [];
      }
    },

    async getStationBoard(station, mode) {
      const arrdep = mode === 'arrival' ? 'ARR' : 'DEP';
      const url = `${CONFIG.API_BASE}/liveboard/?station=${encodeURIComponent(station)}&arrdep=${arrdep}&lang=${Utils.lang()}&format=json`;
      try {
        const data = await this.fetchWithTimeout(url);
        Offline.saveLiveboard(station, mode, data);
        return data;
      } catch (error) {
        console.warn('Erreur liveboard, tentative offline:', error);
        const offline = Offline.loadLiveboard(station, mode);
        if (offline) return offline;
        throw error;
      }
    },

    async getVehicleOnly(vehicleId, dateStr) {
      const url = `${CONFIG.API_BASE}/vehicle/?id=${encodeURIComponent(vehicleId)}&format=json&lang=${Utils.lang()}&date=${dateStr}`;
      return await this.fetchWithTimeout(url, { timeout: 7000 });
    },

    async getVehicleDetails(vehicleId, dateStr) {
      const cacheKey = Utils.cacheKey(vehicleId, dateStr);
      const cached = Cache.get(cacheKey);
      if (cached) return cached;

      try {
        const [vehicle, composition] = await Promise.all([
          this.fetchWithTimeout(
            `${CONFIG.API_BASE}/vehicle/?id=${encodeURIComponent(vehicleId)}&format=json&lang=${Utils.lang()}&date=${dateStr}`
          ).catch(() => null),
          this.fetchWithTimeout(
            `${CONFIG.API_BASE}/composition/?id=${encodeURIComponent(vehicleId)}&format=json&date=${dateStr}`
          ).catch(() => null)
        ]);

        const details = { vehicle, composition };
        Cache.set(cacheKey, details);
        return details;
      } catch (error) {
        console.error('Erreur détails train:', error);
        return { vehicle: null, composition: null };
      }
    }
  };

  // ---------- RENDU UI ----------
  const UI = {
    updateHeader() {
      if (DOM.stationNameText) DOM.stationNameText.textContent = state.station;
      if (DOM.tabDeparture) DOM.tabDeparture.classList.toggle('active', state.mode === 'departure');
      if (DOM.tabArrival) DOM.tabArrival.classList.toggle('active', state.mode === 'arrival');
    },

    renderStationSelect(filter = '') {
      const select = DOM.stationSelect;
      if (!select) return;

      select.innerHTML = '';
      const query = Utils.normalize(filter);
      let options = [];

      if (state.allStationsNormalized.length > 0) {
        let list = state.allStationsNormalized;

        if (query) {
          const starts = [];
          const contains = [];
          for (const s of list) {
            if (s.norm.startsWith(query)) starts.push(s.raw);
            else if (s.norm.includes(query)) contains.push(s.raw);
          }
          list = [...starts, ...contains].map(x => ({ raw: x, norm: '' }));
        } else {
          list = state.allStationsNormalized;
        }

        const limited = list.slice(0, 60).map(s => s.raw);
        options = limited.sort((a, b) => a.standardname.localeCompare(b.standardname));
      }

      if (options.length === 0 && filter) {
        select.innerHTML = '<option disabled>❌ Aucune gare trouvée</option>';
      } else {
        select.innerHTML = options.map(station =>
          `<option value="${station.standardname}" ${station.standardname === state.station ? 'selected' : ''}>${station.standardname}</option>`
        ).join('');
        if (options.length === 60) {
          select.innerHTML += '<option disabled>... (affichage limité à 60 résultats)</option>';
        }
      }

      select.style.display = filter ? 'block' : 'none';
    },

    renderOccupancy(occupancy) {
      if (!occupancy || !occupancy.name || occupancy.name === 'unknown') return '';
      const level = occupancy.name;
      const cssClass = level === 'high' ? 'occ-high' : level === 'medium' ? 'occ-medium' : '';
      const percentage = level === 'high' ? 95 : level === 'medium' ? 60 : 25;

      return `
        <span class="occupancy ${cssClass}" title="${level}">
          <span class="occ-bar">
            <span class="occ-fill" style="width:${percentage}%"></span>
          </span>
        </span>
      `;
    },

    renderDisturbanceBanner() {
      const relevant = (state.disturbances || []).filter(d => {
        const text = `${d.title} ${d.description}`.toLowerCase();
        return text.includes((state.station || '').toLowerCase());
      }).slice(0, 3);

      if (relevant.length === 0) return '';

      return `
        <div class="banner">
          <strong>⚠️ Perturbations</strong>
          <div style="margin-top:6px">
            ${relevant.map(d => d.title).join('<br>')}
          </div>
        </div>
      `;
    },

    renderTrain(train) {
      const time = Utils.formatTime(train.time);
      const number = train.vehicleinfo?.shortname || train.vehicle || '—';
      const platform = train.platform || '—';
      const delayMin = Math.floor((parseInt(train.delay || 0, 10)) / 60);
      const delayText = (parseInt(train.delay || 0, 10)) > 0
        ? `<div class="delay delayed">+${delayMin} min</div>`
        : `<div class="delay on-time">À l'heure</div>`;

      const cancelled = train.canceled === '1' || train.canceled === 1 || train.canceled === true;
      const occupancy = this.renderOccupancy(train.occupancy);

      let routeText = '';
      if (train.direction && train.direction.name) {
        routeText = state.mode === 'departure'
          ? `${state.station} → ${train.direction.name}`
          : `${train.direction.name} → ${state.station}`;
      } else {
        routeText = state.station;
      }

      // IMPORTANT: data-datestr = ddmmyy (API), affichage = JJ/MM/AAAA
      const apiDateStr = Utils.getDateString(new Date(train.time * 1000));
      const displayDateStr = Utils.formatDateFR(new Date(train.time * 1000));

      return `
        <div class="train ${cancelled ? 'cancelled' : ''}"
             data-vehicle="${train.vehicle}"
             data-datestr="${apiDateStr}">
          <div class="left">
            <div class="train-number">${number} ${occupancy}</div>
            <div class="route">${routeText}</div>
            <div class="platform">Voie: ${platform}</div>
          </div>
          <div style="text-align:right">
            <div class="time">${time}</div>
            <div class="date">${displayDateStr}</div>
            ${delayText}
          </div>
        </div>
        <div class="details"></div>
      `;
    },

    renderTrainDetails(details, currentStation) {
      let html = '';

      if (details.vehicle && details.vehicle.stops) {
        const stopsData = details.vehicle.stops.stop;
        if (stopsData) {
          const stops = Array.isArray(stopsData) ? stopsData : [stopsData];
          const now = Utils.nowSeconds();
          let lastPassedIndex = -1;

          stops.forEach((stop, index) => {
            const stopTime = parseInt(stop.time, 10);
            const stopDelay = parseInt(stop.delay || 0, 10);
            const actualTime = stopTime + stopDelay;
            if (actualTime <= now) lastPassedIndex = index;
          });

          html += '<h4>Itinéraire</h4><div class="metro-line">';

          stops.forEach((stop, index) => {
            const isCurrent = (stop.station || '').toLowerCase() === (currentStation || '').toLowerCase();
            const isFirst = index === 0;
            const isLast = index === stops.length - 1;
            const isTrainHere = index === lastPassedIndex;
            const isPassed = index < lastPassedIndex;

            const delay = parseInt(stop.delay || 0, 10);
            const delayMin = Math.floor(delay / 60);
            const delayClass = delay > 0 ? 'has-delay' : '';
            const delayText = delay > 0 ? ` <span class="stop-delay">+${delayMin}min</span>` : '';

            const isCanceled = stop.canceled === '1' || stop.canceled === 1;
            const cancelClass = isCanceled ? 'canceled' : '';

            const platform = stop.platform ? ` <span class="stop-platform">Voie ${stop.platform}</span>` : '';
            const isConnection = Utils.isConnectionStation(stop.station);

            html += `
              <div class="metro-stop ${isCurrent ? 'current' : ''} ${isFirst ? 'first' : ''} ${isLast ? 'last' : ''} ${delayClass} ${cancelClass} ${isTrainHere ? 'train-position' : ''} ${isPassed ? 'passed' : ''}">
                <div class="metro-dot">${isTrainHere ? '🚂' : ''}</div>
                <div class="metro-info">
                  <div class="metro-station">
                    <a href="#" class="goto-station" data-station="${stop.station}">${stop.station}</a>
                    ${isCanceled ? ' <span class="stop-canceled">Annulé</span>' : ''}
                    ${isTrainHere ? ' <span class="train-here">Train ici</span>' : ''}
                    ${platform}
                    ${isConnection ? ' <span class="stop-connection">Correspondances possibles</span>' : ''}
                  </div>
                  <div class="metro-time">${Utils.formatTime(stop.time)}${delayText}</div>
                </div>
              </div>
            `;
          });

          html += '</div>';
        } else {
          html += '<div class="info" style="margin:16px 0">ℹ️ Les détails des arrêts ne sont pas disponibles pour ce train.</div>';
        }
      } else {
        html += '<div class="info" style="margin:16px 0">ℹ️ Les détails des arrêts ne sont pas disponibles pour ce train.</div>';
      }

      // Composition (inchangé)
      if (details.composition) {
        const comp = details.composition.composition;
        if (comp && comp.segments && comp.segments.segment) {
          const segments = Array.isArray(comp.segments.segment) ? comp.segments.segment : [comp.segments.segment];

          html += `<h4 style="margin-top:16px">Composition</h4>`;
          html += `<div class="train-composition">`;

          const seenUnits = new Set();

          segments.forEach((seg) => {
            if (seg.composition && seg.composition.units) {
              const units = Array.isArray(seg.composition.units.unit)
                ? seg.composition.units.unit
                : [seg.composition.units.unit];

              units.forEach(unit => {
                const materialType = unit.materialType?.parent_type || unit.materialType || '?';
                const unitId = unit.id || `${materialType}_${Math.random()}`;
                if (seenUnits.has(unitId)) return;
                seenUnits.add(unitId);

                const typeUpper = String(materialType).toUpperCase();
                let icon = '🚃';
                let label = 'Voiture';
                let cssClass = 'wagon';

                if (typeUpper.includes('HLE') || String(materialType).toLowerCase().includes('loco')) {
                  icon = '🚂'; label = 'Locomotive'; cssClass = 'loco';
                } else if (typeUpper.includes('HVP') || typeUpper.includes('HVR')) {
                  icon = '🎛️'; label = 'Voiture pilote'; cssClass = 'pilot';
                } else if (typeUpper.match(/^(M|I|B)\d+/)) {
                  icon = '🚃'; label = 'Voiture'; cssClass = 'wagon';
                } else if (typeUpper.includes('AM')) {
                  icon = '🚊'; label = 'Automotrice'; cssClass = 'emu';
                }

                html += `
                  <div class="train-unit ${cssClass}" title="${label}">
                    <div class="unit-icon">${icon}</div>
                    <div class="unit-type">${materialType}</div>
                  </div>
                `;
              });
            }
          });

          html += `</div>`;
          html += `<p style="margin-top:8px;font-size:11px;color:#64748b;text-align:center">← Sens de marche (tête du train à gauche)</p>`;
        } else {
          html += `<h4 style="margin-top:16px">Composition</h4><div class="info">ℹ️ La composition n'est pas disponible pour ce train</div>`;
        }
      } else {
        html += `<h4 style="margin-top:16px">Composition</h4><div class="info">ℹ️ Données de composition non disponibles</div>`;
      }

      return html;
    },

    async renderTrainsList(data) {
      const container = DOM.trainsList;
      if (!container) return;
      container.innerHTML = '';

      const key = state.mode === 'departure' ? 'departures' : 'arrivals';
      const rawTrains = data ? data[key] : null;

      if (!rawTrains) {
        const modeText = state.mode === 'departure' ? 'départ' : 'arrivée';
        container.innerHTML = `<div class="info">Aucun ${modeText} prévu pour la gare de ${state.station}.</div>`;
        return;
      }

      const trainsKey = state.mode === 'departure' ? 'departure' : 'arrival';
      const trains = rawTrains[trainsKey] || [];
      const trainsArray = Array.isArray(trains) ? trains : (trains ? [trains] : []);

      container.innerHTML += this.renderDisturbanceBanner();

      if (trainsArray.length === 0) {
        const modeText = state.mode === 'departure' ? 'départ' : 'arrivée';
        container.innerHTML += `<div class="info">Aucun ${modeText} prévu pour la gare de ${state.station}.</div>`;
        return;
      }

      trainsArray.forEach(train => { container.innerHTML += this.renderTrain(train); });
    },

    showLoading() {
      if (!DOM.trainsList) return;
      DOM.trainsList.innerHTML = `
        <div class="loading">
          <div class="spinner"></div>
          <div style="margin-top:10px">Chargement des horaires...</div>
        </div>
      `;
    },

    showError(message) {
      if (!DOM.trainsList) return;
      DOM.trainsList.innerHTML = `<div class="error">⚠️ ${message}</div>`;
    }
  };

  // ---------- GESTION DES ÉVÉNEMENTS ----------
  const Events = {
    async handleTrainClick(event) {
      // Clic sur une gare dans l'itinéraire (delegation)
      const goto = event.target.closest('.goto-station');
      if (goto) {
        event.preventDefault();
        const stationName = goto.dataset.station;
        if (stationName) {
          state.station = stationName;
          App.saveState();
          App.init(true);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        return;
      }

      const trainEl = event.target.closest('.train');
      if (!trainEl) return;

      const vehicleId = trainEl.dataset.vehicle;
      const dateStr = trainEl.dataset.datestr; // ddmmyy (API)
      const detailsEl = trainEl.nextElementSibling;
      const isExpanded = trainEl.classList.contains('expanded');

      // Fermer tous les trains
      document.querySelectorAll('.train.expanded').forEach(el => {
        el.classList.remove('expanded');
        if (el.nextElementSibling) el.nextElementSibling.innerHTML = '';
      });

      if (isExpanded) {
        state.expandedVehicle = null;
        return;
      }

      trainEl.classList.add('expanded');
      state.expandedVehicle = vehicleId;

      if (detailsEl) {
        detailsEl.innerHTML = `
          <div class="loading">
            <div class="spinner small"></div>
            Chargement des détails...
          </div>
        `;
      }

      const details = await API.getVehicleDetails(vehicleId, dateStr);
      if (detailsEl) detailsEl.innerHTML = UI.renderTrainDetails(details, state.station);

      Events.preloadNextTrain(trainEl);
    },

    preloadNextTrain(currentTrainEl) {
      const detailsEl = currentTrainEl.nextElementSibling;
      if (!detailsEl) return;
      const nextTrain = detailsEl.nextElementSibling;
      if (!nextTrain || !nextTrain.classList.contains('train')) return;

      const vehicleId = nextTrain.dataset.vehicle;
      const dateStr = nextTrain.dataset.datestr;
      if (!vehicleId || !dateStr) return;

      const cacheKey = Utils.cacheKey(vehicleId, dateStr);
      if (Cache.get(cacheKey)) return;

      API.getVehicleDetails(vehicleId, dateStr).catch(() => {});
    },

    handleStationSearch: Utils.debounce((event) => {
      UI.renderStationSelect(event.target.value);
    }, CONFIG.DEBOUNCE_DELAY),

    // input: si vide, on revient au liveboard normal
    handleTrainSearchInput(event) {
      const v = (event && event.target) ? event.target.value : '';
      if (!v || !v.trim()) App.init(true);
    },

    async handleTrainSearchSubmit(event) {
      if (event && event.preventDefault) event.preventDefault();
      if (!DOM.trainSearch) return;

      const raw = DOM.trainSearch.value.trim();
      const digits = raw.replace(/\D/g, '');
      if (!digits) return;

      await App.searchTrainGlobal(digits);
    },

    handleStationSearchKeyDown(event) {
      const select = DOM.stationSelect;
      if (!select) return;

      if (event.key === 'ArrowDown') {
        if (select.options.length > 0) {
          select.style.display = 'block';
          select.focus();
          if (select.selectedIndex < 0) select.selectedIndex = 0;
          event.preventDefault();
        }
      } else if (event.key === 'Enter') {
        const opt = select.options[select.selectedIndex >= 0 ? select.selectedIndex : 0];
        if (opt && !opt.disabled) {
          state.station = opt.value;
          App.saveState();
          DOM.stationSearch.value = '';
          select.style.display = 'none';
          App.init(true);
          event.preventDefault();
        }
      } else if (event.key === 'Escape') {
        select.style.display = 'none';
      }
    },

    handleStationSelect(event) {
      const value = event.target.value;
      if (!value) return;
      state.station = value;
      DOM.stationSelect.style.display = 'none';
      DOM.stationSearch.value = '';
      App.saveState();
      App.init(true);
    },

    handleModeChange(mode) {
      state.mode = mode;
      App.saveState();
      App.init(true);
    },

    handleDocumentClick(event) {
      const isSelect = DOM.stationSelect && DOM.stationSelect.contains(event.target);
      const isSearch = DOM.stationSearch && DOM.stationSearch.contains(event.target);
      if (!isSelect && !isSearch && DOM.stationSelect) DOM.stationSelect.style.display = 'none';
    },

    async handleLocate() {
      if (!navigator.geolocation) {
        alert('La géolocalisation n\'est pas supportée par votre navigateur.');
        return;
      }

      if (DOM.locateBtn) {
        DOM.locateBtn.disabled = true;
        DOM.locateBtn.textContent = '📍 Localisation...';
      }

      try {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
          });
        });

        const userLat = position.coords.latitude;
        const userLon = position.coords.longitude;

        if (state.allStations.length === 0) {
          alert('Chargement des gares en cours, veuillez réessayer...');
          return;
        }

        const nearest = Events.findNearestStation(userLat, userLon);
        if (!nearest) {
          alert('Aucune gare pertinente trouvée à proximité.');
          return;
        }

        state.station = nearest.standardname;
        App.saveState();
        App.init(true);

        const distance = nearest._distance || 0;
        if (DOM.stationNameText) {
          DOM.stationNameText.textContent = `${nearest.standardname} (${distance.toFixed(1)} km)`;
          setTimeout(() => { DOM.stationNameText.textContent = nearest.standardname; }, 3000);
        }

      } catch (error) {
        console.error('Erreur géolocalisation:', error);
        if (error.code === 1) alert('Vous devez autoriser la géolocalisation pour utiliser cette fonctionnalité.');
        else alert('Erreur lors de la géolocalisation. Veuillez réessayer.');
      } finally {
        if (DOM.locateBtn) {
          DOM.locateBtn.disabled = false;
          DOM.locateBtn.textContent = '📍 Localiser';
        }
      }
    },

    findNearestStation(lat, lon) {
      let nearest = null;
      let minDistance = Infinity;

      state.allStations.forEach(station => {
        if (station.locationY && station.locationX) {
          const sLat = parseFloat(station.locationY);
          const sLon = parseFloat(station.locationX);
          const dist = Utils.getDistance(lat, lon, sLat, sLon);

          if (dist < minDistance) {
            minDistance = dist;
            nearest = station;
          }
        }
      });

      if (!nearest) return null;
      if (minDistance > 15) return null;
      nearest._distance = minDistance;
      return nearest;
    }
  };

  // ---------- APPLICATION ----------
  const App = {
    saveState() {
      localStorage.setItem('nt_mode', state.mode);
      localStorage.setItem('nt_station', state.station);
    },

// --- Cache local (résultats de recherche globale par numéro) ---
loadGlobalSearchCache() {
  try {
    const raw = localStorage.getItem('nt_globalTrainCache_v1');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      state.globalTrainSearchCache = parsed;
    }
  } catch (e) {
    // ignore
  }
},

saveGlobalSearchCache() {
  try {
    localStorage.setItem('nt_globalTrainCache_v1', JSON.stringify(state.globalTrainSearchCache || {}));
  } catch (e) {
    // ignore
  }
},

getGlobalCacheEntry(digits) {
  const c = state.globalTrainSearchCache || {};
  const entry = c[String(digits)];
  if (!entry || !entry.ts) return null;
  const ttl = entry.miss ? CONFIG.GLOBAL_SEARCH_NEGATIVE_TTL : CONFIG.GLOBAL_SEARCH_CACHE_TTL;
  if (Date.now() - entry.ts > ttl) return null;
  return entry;
},

setGlobalCacheEntry(digits, entry) {
  if (!state.globalTrainSearchCache) state.globalTrainSearchCache = {};
  state.globalTrainSearchCache[String(digits)] = { ...entry, ts: Date.now() };
  this.saveGlobalSearchCache();
},

async probeCandidates(candidates, apiDateStr) {
  const concurrency = CONFIG.GLOBAL_SEARCH_CONCURRENCY || 6;
  const batchController = new AbortController();
  let idx = 0;
  let foundVehicleId = null;

  const worker = async () => {
    while (!foundVehicleId && idx < candidates.length) {
      const vehicleId = candidates[idx++];
      try {
        const v = await API.getVehicleOnly(vehicleId, apiDateStr, { signal: batchController.signal });
        if (v && v.stops && v.stops.stop) {
          foundVehicleId = vehicleId;
          batchController.abort(); // stoppe les autres requêtes en cours
          return;
        }
      } catch (e) {
        // ignore (404/400/abort/etc.)
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker());
  await Promise.all(workers);
  return foundVehicleId;
},

    // --- Recherche globale par numéro (digits) ---
                   buildVehicleIdCandidates(digits) {
  // On teste plusieurs familles de trains (NMBS/SNCB + internationaux)
  // iRail utilise souvent des IDs du type: BE.NMBS.IC2120
  const primary = ['IC','S','L','P','IR'];
  const secondary = ['EC','ICE','TGV','THA','Eurostar','EXT','ICT','ICD','R','RE','RB'];

  const uniq = new Set();

  // Priorité: BE.NMBS.<type><digits>
  [...primary, ...secondary].forEach(p => uniq.add(`BE.NMBS.${p}${digits}`));

  // Fallback: sans namespace (certains flux)
  [...primary, ...secondary].forEach(p => uniq.add(`${p}${digits}`));

  return Array.from(uniq);
},

                   async searchTrainGlobal(digits) {
  // 1) Cache: si on a déjà trouvé récemment, on ré-affiche instantanément
  const cached = this.getGlobalCacheEntry(digits);
  if (cached) {
    if (cached.miss) {
      UI.showError(`Aucun train trouvé avec le numéro <strong>${digits}</strong> (cache récent).`);
      return;
    }
    return await this.renderGlobalTrainResult(digits, cached.vehicleId, cached.apiDateStr);
  }

  // UX: loader dédié
  DOM.trainsList.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <div style="margin-top:10px">Recherche du train <strong>${digits}</strong>…</div>
      <div style="margin-top:6px;font-size:12px;color:#64748b">
        Astuce : tape juste les chiffres (ex: 2120).
      </div>
    </div>
  `;

  // On essaye d'abord aujourd'hui (prioritaire), puis hier (utile après minuit),
  // puis demain (dernier recours).
  const now = new Date();
  const dayList = [
    new Date(now),
    new Date(now.getTime() - 24 * 60 * 60 * 1000),
    new Date(now.getTime() + 24 * 60 * 60 * 1000)
  ];

  const candidates = this.buildVehicleIdCandidates(digits);

  let foundVehicleId = null;
  let foundDateStr = null;

  for (const day of dayList) {
    const apiDateStr = Utils.getDateString(day);
    const hit = await this.probeCandidates(candidates, apiDateStr);
    if (hit) {
      foundVehicleId = hit;
      foundDateStr = apiDateStr;
      break;
    }
  }

  if (!foundVehicleId) {
    this.setGlobalCacheEntry(digits, { miss: true });
    UI.showError(`Aucun train trouvé avec le numéro <strong>${digits}</strong> (sur aujourd'hui/hier/demain).`);
    return;
  }

  // Cache positif
  this.setGlobalCacheEntry(digits, { vehicleId: foundVehicleId, apiDateStr: foundDateStr });

  return await this.renderGlobalTrainResult(digits, foundVehicleId, foundDateStr);
},

async renderGlobalTrainResult(digits, vehicleId, apiDateStr) {
  // On charge les détails complets (vehicle + composition) via le cache existant
  const details = await API.getVehicleDetails(vehicleId, apiDateStr);

  const niceLabel = vehicleId.split('.').pop() || vehicleId;
  const prettyDate = Utils.formatDateFR(
    new Date(
      2000 + parseInt(apiDateStr.slice(4, 6), 10),
      parseInt(apiDateStr.slice(2, 4), 10) - 1,
      parseInt(apiDateStr.slice(0, 2), 10)
    )
  );

  DOM.trainsList.innerHTML = `
    <div class="banner" style="margin-bottom:10px">
      <strong>🔎 Résultat</strong><br>
      Train <strong>${digits}</strong> — ${niceLabel}
      <div style="margin-top:6px;font-size:12px;color:#64748b">
        Date : <strong>${prettyDate}</strong> • Appuie sur une gare dans l’itinéraire pour afficher ses horaires.
      </div>
    </div>
    <div class="train expanded" data-vehicle="${vehicleId}" data-datestr="${apiDateStr}">
      <div class="left">
        <div class="train-number">${niceLabel}</div>
        <div class="route">Recherche globale</div>
        <div class="platform">Date: ${prettyDate}</div>
      </div>
      <div style="text-align:right">
        <div class="time">—</div>
        <div class="delay on-time">Détails</div>
      </div>
    </div>
    <div class="details">${UI.renderTrainDetails(details, state.station)}</div>
  `;

  window.scrollTo({ top: 0, behavior: 'smooth' });
},

setupListeners() {
      if (DOM.stationSearch) {
        DOM.stationSearch.addEventListener('input', Events.handleStationSearch);
        DOM.stationSearch.addEventListener('keydown', Events.handleStationSearchKeyDown);
      }

      if (DOM.trainSearch) {
        // input: si on vide, on revient à la liste
        DOM.trainSearch.addEventListener('input', Events.handleTrainSearchInput);

        // Android/iOS: Enter / "Go" / "Search"
        DOM.trainSearch.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') Events.handleTrainSearchSubmit(e);
        });

        // Type="search" sur iOS/Safari peut émettre "search"
        DOM.trainSearch.addEventListener('search', (e) => {
          Events.handleTrainSearchSubmit(e);
        });

        // Fallback: blur/validation
        DOM.trainSearch.addEventListener('change', (e) => {
          Events.handleTrainSearchSubmit(e);
        });
      }

      if (DOM.stationSelect) DOM.stationSelect.addEventListener('change', Events.handleStationSelect);
      if (DOM.tabDeparture) DOM.tabDeparture.addEventListener('click', () => Events.handleModeChange('departure'));
      if (DOM.tabArrival) DOM.tabArrival.addEventListener('click', () => Events.handleModeChange('arrival'));
      if (DOM.refreshBtn) DOM.refreshBtn.addEventListener('click', () => this.init(true));
      if (DOM.trainsList) DOM.trainsList.addEventListener('click', Events.handleTrainClick);
      if (DOM.locateBtn) DOM.locateBtn.addEventListener('click', Events.handleLocate);
      document.addEventListener('click', Events.handleDocumentClick);
    },

    async tryGeolocation() {
      const savedStation = localStorage.getItem('nt_station');
      if (savedStation) return false;
      if (!navigator.geolocation) return false;

      try {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: false,
            timeout: 5000,
            maximumAge: 60000
          });
        });

        const userLat = position.coords.latitude;
        const userLon = position.coords.longitude;

        let attempts = 0;
        while (state.allStations.length === 0 && attempts < 20) {
          await new Promise(resolve => setTimeout(resolve, 200));
          attempts++;
        }
        if (state.allStations.length === 0) return false;

        const nearest = Events.findNearestStation(userLat, userLon);
        if (nearest) {
          state.station = nearest.standardname;
          this.saveState();
          return true;
        }
      } catch (error) {
        console.log('Géolocalisation échouée ou refusée:', error.message);
        return false;
      }

      return false;
    },

    async init(forceRefresh = false) {
      if (state.isFetching && !forceRefresh) return;

      state.isFetching = true;
      UI.updateHeader();
      UI.showLoading();
      if (DOM.trainSearch) DOM.trainSearch.value = '';

      if (state.autoRefreshHandle) clearTimeout(state.autoRefreshHandle);

      try {
        if (state.allStations.length === 0) {
          const offlineStations = Offline.loadStations();
          if (offlineStations && offlineStations.length > 0) {
            state.allStations = offlineStations;
            Utils.buildStationsIndex();
          }
        }

        if (state.allStations.length === 0) {
          state.allStations = await API.getAllStations();
          Utils.buildStationsIndex();
        } else if (state.allStationsNormalized.length === 0) {
          Utils.buildStationsIndex();
        }

        state.disturbances = await API.getDisturbances();

        const data = await API.getStationBoard(state.station, state.mode);
        await UI.renderTrainsList(data);

        state.autoRefreshHandle = setTimeout(() => this.init(), CONFIG.AUTO_REFRESH);
      } catch (error) {
        console.error('Erreur initialisation:', error);
        const message = error.message && error.message.includes('HTTP 404')
          ? `Impossible de trouver la gare **${state.station}**. Vérifiez l'orthographe ou choisissez dans la liste.`
          : `Impossible de charger les horaires. Veuillez réessayer. (${error.message || 'Erreur inconnue'})`;
        UI.showError(message);
      } finally {
        state.isFetching = false;
      }
    },

    async start() {
      this.loadGlobalSearchCache();
      this.setupListeners();

      const initPromise = this.init();
      const geolocated = await this.tryGeolocation();

      if (geolocated) await this.init(true);
      else await initPromise;
    }
  };

  // ---------- DÉMARRAGE ----------
  App.start();

})();
