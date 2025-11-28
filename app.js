/* ============================================================
   NextTrain – app.js (v10)
   - Liveboard par gare
   - Itinéraires cliquables (gare → horaires)
   - Recherche globale par numéro de train
   - Recherche gare améliorée (tolérante + tri intelligent)
   - Indication "Train ici" + "Train parti"
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

  // ---------- STATIONS PAR LIGNE (Référence statique) ----------
  const STATIONS = {
    'Bruxelles': [
      'Bruxelles-Midi', 'Bruxelles-Central', 'Bruxelles-Nord', 
      'Bruxelles-Luxembourg', 'Bruxelles-Schuman', 'Bruxelles-Chapelle',
      'Bruxelles-Ouest', 'Etterbeek', 'Schaerbeek', 'Berchem-Sainte-Agathe'
    ],
    'Brabant Flamand': [
      'Leuven', 'Aarschot', 'Diest', 'Tienen', 'Landen', 'Herent',
      'Haacht', 'Rotselaar', 'Kessel-Lo', 'Heverlee', 'Oud-Heverlee',
      'Neerijse', 'Loonbeek', 'Wilsele'
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
      return date.toLocaleTimeString('fr-BE', {
        hour: '2-digit',
        minute: '2-digit'
      });
    },

    getDateString(date = new Date()) {
      const d = String(date.getDate()).padStart(2, '0');
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const y = String(date.getFullYear()).slice(-2);
      return `${d}${m}${y}`;
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
      return String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, '');
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

  // ---------- GESTION DU CACHE ----------
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
      state.trainDetailsCache[key] = {
        timestamp: Date.now(),
        data: data
      };
    }
  };

  // ---------- API ----------
  const API = {
    async fetchWithTimeout(url, options = {}) {
      const timeout = options.timeout || CONFIG.FETCH_TIMEOUT;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        return await response.json();
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
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
        return data.station || [];
      } catch (error) {
        console.warn('Erreur chargement stations:', error);
        return [];
      }
    },

    async getStationBoard(station, mode) {
      const arrdep = mode === 'arrival' ? 'ARR' : 'DEP';
      const url = `${CONFIG.API_BASE}/liveboard/?station=${encodeURIComponent(station)}&arrdep=${arrdep}&lang=${Utils.lang()}&format=json`;
      return await this.fetchWithTimeout(url);
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
    },

    async findTrainByNumber(rawNum) {
      const num = String(rawNum).replace(/\D/g, '');
      if (!num) return null;

      const prefixes = ['IC', 'P', 'S', 'L', 'TGV', 'THA', 'ICE', 'EXT', 'RB', 'EC'];
      const dateStr = Utils.getDateString();

      const candidates = [];
      prefixes.forEach(p => {
        candidates.push(`${p}${num}`);
        candidates.push(`BE.NMBS.${p}${num}`);
      });

      for (const id of candidates) {
        try {
          const details = await this.getVehicleDetails(id, dateStr);
          if (details && details.vehicle && details.vehicle.stops && details.vehicle.stops.stop) {
            return { vehicleId: id, dateStr, details };
          }
        } catch (e) {
          // on tente le suivant
        }
      }

      return null;
    }
  };

  // ---------- RENDU UI ----------
  const UI = {
    updateHeader() {
      DOM.stationNameText.textContent = state.station;
      DOM.tabDeparture.classList.toggle('active', state.mode === 'departure');
      DOM.tabArrival.classList.toggle('active', state.mode === 'arrival');
    },

    renderStationSelect(filter = '') {
      const select = DOM.stationSelect;
      if (!select) return;

      select.innerHTML = '';
      let optionsCount = 0;

      if (state.allStations.length > 0) {
        const cleanFilter = Utils.normalize(filter);

        let stations = state.allStations
          .filter(s => {
            const cleanName = Utils.normalize(s.standardname);
            return cleanFilter === '' || cleanName.includes(cleanFilter);
          })
          .sort((a, b) => {
            const fa = Utils.normalize(a.standardname);
            const fb = Utils.normalize(b.standardname);

            if (cleanFilter) {
              const aStarts = fa.startsWith(cleanFilter);
              const bStarts = fb.startsWith(cleanFilter);
              if (aStarts && !bStarts) return -1;
              if (!aStarts && bStarts) return 1;
            }

            return fa.localeCompare(fb);
          })
          .slice(0, 15);

        optionsCount = stations.length;

        const options = stations.map(station => 
          `<option value="${station.standardname}" ${station.standardname === state.station ? 'selected' : ''}>${station.standardname}</option>`
        ).join('');
        
        select.innerHTML = options;
      }

      if (filter) {
        select.style.display = 'block';
        
        if (optionsCount === 0) {
          select.innerHTML = '<option disabled>❌ Aucune gare trouvée</option>';
        }
      } else {
        select.style.display = 'none';
      }
    },

    renderOccupancy(occupancy) {
      if (!occupancy || !occupancy.name || occupancy.name === 'unknown') {
        return '';
      }

      const level = occupancy.name;
      const cssClass = level === 'high' ? 'occ-high' : 
                       level === 'medium' ? 'occ-medium' : '';
      const percentage = level === 'high' ? 95 : 
                         level === 'medium' ? 60 : 25;

      return `
        <span class="occupancy ${cssClass}" title="${level}">
          <span class="occ-bar">
            <span class="occ-fill" style="width:${percentage}%"></span>
          </span>
        </span>
      `;
    },

    renderDisturbanceBanner() {
      const relevant = state.disturbances.filter(d => {
        const text = `${d.title} ${d.description}`.toLowerCase();
        return text.includes(state.station.toLowerCase());
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
      const platform = train.platform || '—';
      const delayMin = Math.floor(train.delay / 60);
      const delayText = train.delay > 0 
        ? `<div class="delay delayed">+${delayMin} min</div>`
        : `<div class="delay on-time">À l'heure</div>`;
      
      const cancelled = train.canceled === '1' || 
                        train.canceled === 1 || 
                        train.canceled === true;
      
      const occupancy = this.renderOccupancy(train.occupancy);
      
      let mainStationName = null;
      const potentialSources = [
        train.direction?.name,
        train.stationinfo?.standardname,
        train.stationInfo?.name,
        train.name?.split(' ')[1]
      ].filter(n => n);
      
      for (const source of potentialSources) {
        const currentStationNormalized = Utils.normalize(state.station);
        const sourceNormalized = Utils.normalize(source);
        if (sourceNormalized !== currentStationNormalized) {
          mainStationName = source;
          break; 
        }
      }
      
      let routeText = 'Destination inconnue';

      if (mainStationName) {
        routeText = state.mode === 'departure'
          ? `Vers ${mainStationName}`
          : `Depuis ${mainStationName}`;
      } else {
        routeText = `Gare: ${state.station} (INFO API MANQUANTE ❌ )`; 
      }
      
      let number = '—';
      if (train.vehicle) {
        if (train.vehicle.shortname) {
          number = train.vehicle.shortname;
        } else if (typeof train.vehicle === 'string') {
          const parts = train.vehicle.split('.');
          if (parts.length > 0) {
            number = parts[parts.length - 1];
          }
        }
      }
      
      const dateStr = Utils.getDateString(new Date(train.time * 1000));

      return `
        <div class="train ${cancelled ? 'cancelled' : ''}" 
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
        <div class="details"></div>
      `;
    },

    // 🔥 ICI : Itinéraire + Train ici / Train parti
    renderTrainDetails(details, currentStation) {
      let html = '';

      if (details.vehicle && details.vehicle.stops) {
        const stopsData = details.vehicle.stops.stop;
        const stops = Array.isArray(stopsData) ? stopsData : [stopsData];

        const now = Utils.nowSeconds();
        let lastPassedIndex = -1;

        stops.forEach((stop, index) => {
          const stopTime = parseInt(stop.time);
          const stopDelay = parseInt(stop.delay || 0);
          const actualTime = stopTime + stopDelay;
          if (actualTime <= now) {
            lastPassedIndex = index;
          }
        });

        html += '<h4>Itinéraire</h4><div class="metro-line">';
        
        stops.forEach((stop, index) => {
          const isCurrent = Utils.normalize(stop.station) === Utils.normalize(currentStation || '');
          const isFirst = index === 0;
          const isLast = index === stops.length - 1;
          const isTrainHere = index === lastPassedIndex;
          const isPassed = index < lastPassedIndex;
          
          const delay = parseInt(stop.delay || 0);
          const delayMin = Math.floor(delay / 60);
          const delayClass = delay > 0 ? 'has-delay' : '';
          const delayText = delay > 0 ? ` <span class="stop-delay">+${delayMin}min</span>` : '';
          
          const isCanceled = stop.canceled === '1' || stop.canceled === 1;
          const cancelClass = isCanceled ? 'canceled' : '';
          const platform = stop.platform ? ` <span class="stop-platform">Voie ${stop.platform}</span>` : '';

          let statusHtml = '';
          if (isTrainHere) {
            statusHtml = ' <span class="train-here">Train ici</span>';
          } else if (isPassed) {
            statusHtml = ' <span class="train-passed">Train parti</span>';
          }
          
          html += `
            <div class="metro-stop ${isCurrent ? 'current' : ''} ${isFirst ? 'first' : ''} ${isLast ? 'last' : ''} ${delayClass} ${cancelClass} ${isTrainHere ? 'train-position' : ''} ${isPassed ? 'passed' : ''}">
              <div class="metro-dot">${isTrainHere ? '🚂' : ''}</div>
              <div class="metro-info">
                <div class="metro-station">
                  <span class="goto-station" data-station="${stop.station}">${stop.station}</span>
                  ${statusHtml}
                  ${isCanceled ? ' <span class="stop-canceled">Annulé</span>' : ''}
                  ${platform}
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

      // Composition
      if (details.composition) {
        const comp = details.composition.composition;
        
        if (comp && comp.segments && comp.segments.segment) {
          const segments = Array.isArray(comp.segments.segment) 
            ? comp.segments.segment 
            : [comp.segments.segment];
          
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
                
                const typeUpper = materialType.toUpperCase();
                let icon = '🚃';
                let label = 'Voiture';
                let cssClass = 'wagon';
                
                if (typeUpper.includes('HLE') || materialType.toLowerCase().includes('loco')) {
                  icon = '🚂';
                  label = 'Locomotive';
                  cssClass = 'loco';
                } else if (typeUpper.includes('HVP') || typeUpper.includes('HVR')) {
                  icon = '🎛️';
                  label = 'Voiture pilote';
                  cssClass = 'pilot';
                } else if (typeUpper.match(/^(M|I|B)\d+/)) {
                  icon = '🚃';
                  label = 'Voiture';
                  cssClass = 'wagon';
                } else if (typeUpper.includes('AM')) {
                  icon = '🚊';
                  label = 'Automotrice';
                  cssClass = 'emu';
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
          html += `<h4 style="margin-top:16px">Composition</h4>`;
          html += `<div class="info">ℹ️ La composition n'est pas disponible pour ce train</div>`;
        }
      } else {
        html += `<h4 style="margin-top:16px">Composition</h4>`;
        html += `<div class="info">ℹ️ Données de composition non disponibles</div>`;
      }

      return html;
    },

    async renderTrainsList(data) {
  const container = DOM.trainsList;
  if (!container) return;

  container.innerHTML = '';

  const key = state.mode === 'departure' ? 'departures' : 'arrivals';
  const rawTrains = data[key];
  
  if (!rawTrains) {
    const modeText = state.mode === 'departure' ? 'départ' : 'arrivée';
    container.innerHTML = `
      <div class="info">
        Aucun ${modeText} prévu pour la gare de ${state.station}.
      </div>
    `;
    return;
  }

  const trainsKey = state.mode === 'departure' ? 'departure' : 'arrival';
  const trains = rawTrains[trainsKey] || [];
  const trainsArray = Array.isArray(trains) ? trains : (trains ? [trains] : []);

  // 🔁 IMPORTANT : on appelle explicitement UI.*, plus "this"
  container.innerHTML += UI.renderDisturbanceBanner();

  if (trainsArray.length === 0) {
    const modeText = state.mode === 'departure' ? 'départ' : 'arrivée';
    container.innerHTML += `
      <div class="info">
        Aucun ${modeText} prévu pour la gare de ${state.station}.
      </div>
    `;
    return;
  }

  trainsArray.forEach(train => {
    container.innerHTML += UI.renderTrain(train);
  });
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
      DOM.trainsList.innerHTML = `
        <div class="error">⚠️ ${message}</div>
      `;
    }
  };

  // ---------- GESTION DES ÉVÉNEMENTS ----------
  const Events = {
    async handleTrainClick(event) {
      const trainEl = event.target.closest('.train');
      if (!trainEl) return;

      const vehicleId = trainEl.dataset.vehicle;
      const dateStr = trainEl.dataset.datestr;
      const detailsEl = trainEl.nextElementSibling;
      const isExpanded = trainEl.classList.contains('expanded');

      document.querySelectorAll('.train.expanded').forEach(el => {
        el.classList.remove('expanded');
        const d = el.nextElementSibling;
        if (d) d.innerHTML = '';
      });

      if (isExpanded) {
        state.expandedVehicle = null;
        return;
      }

      trainEl.classList.add('expanded');
      state.expandedVehicle = vehicleId;

      if (!detailsEl) return;
      detailsEl.innerHTML = `
        <div class="loading">
          <div class="spinner small"></div>
          Chargement des détails...
        </div>
      `;

      const details = await API.getVehicleDetails(vehicleId, dateStr);
      detailsEl.innerHTML = UI.renderTrainDetails(details, state.station);
    },

    handleStationSearch: Utils.debounce((event) => {
      UI.renderStationSelect(event.target.value);
    }, CONFIG.DEBOUNCE_DELAY),

    handleStationSelect(event) {
      state.station = event.target.value;
      if (DOM.stationSelect) DOM.stationSelect.style.display = 'none';
      if (DOM.stationSearch) DOM.stationSearch.value = '';
      App.saveState();
      App.init();
    },

    handleModeChange(mode) {
      state.mode = mode;
      App.saveState();
      App.init();
    },

    handleDocumentClick(event) {
      const isSelect = DOM.stationSelect && DOM.stationSelect.contains(event.target);
      const isSearch = DOM.stationSearch && DOM.stationSearch.contains(event.target);
      
      if (!isSelect && !isSearch && DOM.stationSelect) {
        DOM.stationSelect.style.display = 'none';
      }
    },

    async handleLocate() {
      if (!navigator.geolocation) {
        alert('La géolocalisation n\'est pas supportée par votre navigateur.');
        return;
      }

      DOM.locateBtn.disabled = true;
      DOM.locateBtn.textContent = '📍 Localisation...';

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

        let nearestStation = null;
        let minDistance = Infinity;

        state.allStations.forEach(station => {
          if (station.locationY && station.locationX) {
            const lat = parseFloat(station.locationY);
            const lon = parseFloat(station.locationX);
            const distance = Utils.getDistance(userLat, userLon, lat, lon);
            
            if (distance < minDistance) {
              minDistance = distance;
              nearestStation = station;
            }
          }
        });

        if (nearestStation) {
          state.station = nearestStation.standardname;
          App.saveState();
          App.init();
          
          DOM.stationNameText.textContent = `${nearestStation.standardname} (${minDistance.toFixed(1)} km)`;
          setTimeout(() => {
            DOM.stationNameText.textContent = nearestStation.standardname;
          }, 3000);
        } else {
          alert('Impossible de trouver une gare proche.');
        }

      } catch (error) {
        console.error('Erreur géolocalisation:', error);
        if (error.code === 1) {
          alert('Vous devez autoriser la géolocalisation pour utiliser cette fonctionnalité.');
        } else {
          alert('Erreur lors de la géolocalisation. Veuillez réessayer.');
        }
      } finally {
        DOM.locateBtn.disabled = false;
        DOM.locateBtn.textContent = '📍 Localiser';
      }
    },

    handleStationClickFromItinerary(event) {
      const el = event.target.closest('.goto-station');
      if (!el) return;

      const station = el.dataset.station;
      if (!station) return;

      console.log('🔀 Navigation vers la gare depuis l’itinéraire :', station);

      state.station = station;
      App.saveState();
      App.init(true);

      document.querySelectorAll('.train.expanded').forEach(train => {
        train.classList.remove('expanded');
        const details = train.nextElementSibling;
        if (details) details.innerHTML = '';
      });
    },

    async handleTrainGlobalSearchKey(event) {
      if (event.key !== 'Enter') return;
      if (!DOM.trainSearch) return;

      const raw = DOM.trainSearch.value || '';
      const num = raw.replace(/\D/g, '');
      if (!num) return;

      event.preventDefault();
      App.searchTrainGlobally(num);
    }
  };

  // ---------- APPLICATION ----------
  const App = {
    saveState() {
      localStorage.setItem('nt_mode', state.mode);
      localStorage.setItem('nt_station', state.station);
    },

    setupListeners() {
      if (DOM.stationSearch) {
        DOM.stationSearch.addEventListener('input', Events.handleStationSearch);
      }
      if (DOM.stationSelect) {
        DOM.stationSelect.addEventListener('change', Events.handleStationSelect);
      }
      if (DOM.tabDeparture) {
        DOM.tabDeparture.addEventListener('click', () => Events.handleModeChange('departure'));
      }
      if (DOM.tabArrival) {
        DOM.tabArrival.addEventListener('click', () => Events.handleModeChange('arrival'));
      }
      if (DOM.refreshBtn) {
        DOM.refreshBtn.addEventListener('click', () => this.init(true));
      }
      if (DOM.trainsList) {
        DOM.trainsList.addEventListener('click', Events.handleTrainClick);
      }
      if (DOM.locateBtn) {
        DOM.locateBtn.addEventListener('click', Events.handleLocate);
      }
      document.addEventListener('click', Events.handleDocumentClick);
      document.addEventListener('click', Events.handleStationClickFromItinerary);

      if (DOM.trainSearch) {
        DOM.trainSearch.addEventListener('keydown', Events.handleTrainGlobalSearchKey);
      }
    },

    async tryGeolocation() {
      const savedStation = localStorage.getItem('nt_station');
      if (savedStation) {
        console.log('Station déjà sauvegardée, pas de géolocalisation auto');
        return false;
      }

      if (!navigator.geolocation) {
        console.log('Géolocalisation non supportée');
        return false;
      }

      console.log('Première visite - tentative de géolocalisation...');

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

        if (state.allStations.length === 0) {
          console.log('Stations pas encore chargées');
          return false;
        }

        let nearestStation = null;
        let minDistance = Infinity;

        state.allStations.forEach(station => {
          if (station.locationY && station.locationX) {
            const lat = parseFloat(station.locationY);
            const lon = parseFloat(station.locationX);
            const distance = Utils.getDistance(userLat, userLon, lat, lon);
            
            if (distance < minDistance) {
              minDistance = distance;
              nearestStation = station;
            }
          }
        });

        if (nearestStation && minDistance < 50) {
          console.log(`Gare la plus proche: ${nearestStation.standardname} (${minDistance.toFixed(1)} km)`);
          state.station = nearestStation.standardname;
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

      if (state.autoRefreshHandle) {
        clearTimeout(state.autoRefreshHandle);
      }

      try {
        if (state.allStations.length === 0) {
          console.log('Chargement de toutes les gares SNCB...');
          state.allStations = await API.getAllStations();
          console.log(`${state.allStations.length} gares chargées`);
        }

        state.disturbances = await API.getDisturbances();
        
        const data = await API.getStationBoard(state.station, state.mode);
        await UI.renderTrainsList(data);

        state.autoRefreshHandle = setTimeout(
          () => this.init(), 
          CONFIG.AUTO_REFRESH
        );

      } catch (error) {
        console.error('Erreur initialisation:', error);
        
        const message = error.message && error.message.includes('HTTP 404')
          ? `Impossible de trouver la gare **${state.station}**. Vérifiez l'orthographe ou choisissez dans la liste.`
          : `Impossible de charger les horaires. Veuillez réessayer. (${error.message})`;
        
        UI.showError(message);
      } finally {
        state.isFetching = false;
      }
    },

    async searchTrainGlobally(num) {
      if (state.autoRefreshHandle) {
        clearTimeout(state.autoRefreshHandle);
        state.autoRefreshHandle = null;
      }

      UI.showLoading();

      try {
        const result = await API.findTrainByNumber(num);

        if (!result) {
          UI.showError(`Aucun train trouvé avec le numéro ${num}`);
          return;
        }

        const { vehicleId, details } = result;

        let origin = '';
        let destination = '';
        if (details.vehicle && details.vehicle.stops && details.vehicle.stops.stop) {
          const stopsData = details.vehicle.stops.stop;
          const stops = Array.isArray(stopsData) ? stopsData : [stopsData];
          if (stops.length > 0) {
            origin = stops[0].station || '';
            destination = stops[stops.length - 1].station || '';
          }
        }

        let shortId = vehicleId;
        if (vehicleId.includes('.')) {
          const parts = vehicleId.split('.');
          shortId = parts[parts.length - 1];
        }

        if (!DOM.trainsList) return;

        DOM.trainsList.innerHTML = `
          <div class="info">
            Résultat pour le train <strong>${shortId}</strong>
            ${origin && destination ? ` (${origin} → ${destination})` : ''}
          </div>
          <div class="train expanded global-train">
            <div class="left">
              <div class="train-number">${shortId}</div>
              ${origin && destination ? `<div class="route">${origin} → ${destination}</div>` : ''}
            </div>
          </div>
          <div class="details global-details">
            ${UI.renderTrainDetails(details, origin || state.station)}
          </div>
        `;

      } catch (error) {
        console.error('Erreur recherche train global:', error);
        UI.showError(`Erreur lors de la recherche du train ${num} (${error.message})`);
      }
    },

    async start() {
      this.setupListeners();
      
      const initPromise = this.init();
      const geolocated = await this.tryGeolocation();
      
      if (geolocated) {
        await this.init(true);
      } else {
        await initPromise;
      }
    }
  };

  // ---------- DÉMARRAGE ----------
  App.start();

})();

/* ============================================================
   Service Worker (PWA + hot update)
   ============================================================ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then(reg => {
        console.log('Service Worker enregistré');
        
        reg.addEventListener('updatefound', () => {
          const installingWorker = reg.installing;
          if (!installingWorker) return;

          installingWorker.addEventListener('statechange', () => {
            if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
              installingWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch(err => console.log('Erreur Service Worker:', err));
  });
  
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data && event.data.type === 'CONTROLLER_CHANGE') {
      console.log('Nouveau Service Worker activé. Rechargement forcé.');
      window.location.reload();
    }

    if (event.data && event.data.type === 'UPDATE_READY') {
      console.log('🔥 Nouvelle version disponible → rechargement');
      window.location.reload();
    }
  });
}
