/* ============================================================
   NextTrain – app.js (Version complête avec 4 trains minimum)
   ============================================================ */

(function () {
  // ---------- CONFIGURATION ----------
  const CONFIG = {
    API_BASE: 'https://api.irail.be',
    CACHE_TTL: 5 * 60 * 1000,
    AUTO_REFRESH: 60000,
    DEBOUNCE_DELAY: 150,
    FETCH_TIMEOUT: 7000,
    MIN_TRAINS: 4
  };

  // ---------- ÉTAT GLOBAL ----------
  const state = {
    mode: localStorage.getItem('nt_mode') || 'departure',
    station: localStorage.getItem('nt_station') || 'Libramont',
    allStations: [],
    disturbances: [],
    trainDetailsCache: {},
    autoRefreshHandle: null,
    expandedVehicle: null,
    isFetching: false
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

    // ddmmyy pour l’API iRail
    getDateString(date = new Date()) {
      const d = String(date.getDate()).padStart(2, '0');
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const y = String(date.getFullYear()).slice(-2);
      return `${d}${m}${y}`;
    },

    debounce(fn, delay) {
      let t;
      return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), delay);
      };
    },

    cacheKey(vehicleId, dateStr) {
      return `${vehicleId}_${dateStr}`;
    },

    // Haversine pour géoloc
    getDistance(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) *
          Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    }
  };

  // ---------- RÉFÉRENCES DOM ----------
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
        data
      };
    }
  };

  // ---------- API ----------
  const API = {
    async fetchWithTimeout(url, options = {}) {
      const timeout = options.timeout || CONFIG.FETCH_TIMEOUT;
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);

      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return await res.json();
      } catch (e) {
        clearTimeout(id);
        throw e;
      }
    },

    async getAllStations() {
      try {
        const url = `${CONFIG.API_BASE}/stations/?format=json&lang=${Utils.lang()}`;
        const data = await this.fetchWithTimeout(url, { timeout: 10000 });
        return data.station || [];
      } catch (e) {
        console.warn('Erreur chargement stations:', e);
        return [];
      }
    },

    async getDisturbances() {
      try {
        const url = `${CONFIG.API_BASE}/disturbances/?format=json&lang=${Utils.lang()}`;
        const data = await this.fetchWithTimeout(url, { timeout: 5000 });
        return data.disturbance || [];
      } catch (e) {
        console.warn('Erreur chargement perturbations:', e);
        return [];
      }
    },

    async getStationBoard(station, mode, opts = {}) {
      const arrdep = mode === 'arrival' ? 'arrival' : 'departure';

      const params = new URLSearchParams({
        station,
        arrdep,
        lang: Utils.lang(),
        format: 'json'
      });

      if (opts.date) params.set('date', opts.date); // ddmmyy
      if (opts.time) params.set('time', opts.time); // hhmm

      const url = `${CONFIG.API_BASE}/liveboard/?${params.toString()}`;
      return await this.fetchWithTimeout(url);
    },

    async getVehicleDetails(vehicleId, dateStr) {
      const key = Utils.cacheKey(vehicleId, dateStr);
      const cached = Cache.get(key);
      if (cached) return cached;

      try {
        const [vehicle, composition] = await Promise.all([
          this.fetchWithTimeout(
            `${CONFIG.API_BASE}/vehicle/?id=${encodeURIComponent(
              vehicleId
            )}&format=json&lang=${Utils.lang()}&date=${dateStr}`
          ).catch(() => null),
          this.fetchWithTimeout(
            `${CONFIG.API_BASE}/composition/?id=${encodeURIComponent(
              vehicleId
            )}&format=json&date=${dateStr}`
          ).catch(() => null)
        ]);

        const details = { vehicle, composition };
        Cache.set(key, details);
        return details;
      } catch (e) {
        console.error('Erreur détails train:', e);
        return { vehicle: null, composition: null };
      }
    }
  };

  // Helper pour extraire les trains d’un liveboard
  function extractTrainsFromLiveboard(data, mode) {
    if (!data) return [];
    const key = mode === 'arrival' ? 'arrivals' : 'departures';
    const block = data[key];
    if (!block) return [];

    const trainsKey = mode === 'arrival' ? 'arrival' : 'departure';
    const trains = block[trainsKey];
    if (!trains) return [];
    return Array.isArray(trains) ? trains : [trains];
  }

  // ---------- UI ----------
  const UI = {
    updateHeader() {
      DOM.stationNameText.textContent = state.station;
      DOM.tabDeparture.classList.toggle('active', state.mode === 'departure');
      DOM.tabArrival.classList.toggle('active', state.mode === 'arrival');
    },

    renderStationSelect(filter = '') {
      const select = DOM.stationSelect;
      select.innerHTML = '';
      let count = 0;

      if (state.allStations.length > 0) {
        const norm = (str) =>
          str
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');

        const f = norm(filter);

        const stations = state.allStations
          .filter((s) => {
            if (!f) return true;
            const name = norm(s.standardname || s.name || '');
            return name.includes(f);
          })
          .sort((a, b) =>
            (a.standardname || a.name).localeCompare(
              b.standardname || b.name
            )
          )
          .slice(0, 50);

        count = stations.length;
        const options = stations
          .map(
            (s) =>
              `<option value="${s.standardname}" ${
                s.standardname === state.station ? 'selected' : ''
              }>${s.standardname}</option>`
          )
          .join('');

        select.innerHTML = options;
      }

      if (filter) {
        select.style.display = 'block';
        if (count === 0) {
          select.innerHTML = '<option disabled>❌ Aucune gare trouvée</option>';
        } else if (count === 50) {
          select.innerHTML +=
            '<option disabled>… (affichage limité à 50 résultats)</option>';
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
      const cssClass =
        level === 'high' ? 'occ-high' : level === 'medium' ? 'occ-medium' : '';
      const percentage =
        level === 'high' ? 95 : level === 'medium' ? 60 : 25;

      return `
        <span class="occupancy ${cssClass}" title="${level}">
          <span class="occ-bar">
            <span class="occ-fill" style="width:${percentage}%"></span>
          </span>
        </span>
      `;
    },

    renderDisturbanceBanner() {
      const relevant = state.disturbances
        .filter((d) => {
          const text = `${d.title} ${d.description}`.toLowerCase();
          return text.includes(state.station.toLowerCase());
        })
        .slice(0, 3);

      if (relevant.length === 0) return '';

      return `
        <div class="banner">
          <strong>⚠️ Perturbations</strong>
          <div style="margin-top:6px">
            ${relevant.map((d) => d.title).join('<br>')}
          </div>
        </div>
      `;
    },

    renderTrain(train) {
      const time = Utils.formatTime(train.time);
      const platform = train.platform || '—';
      const delayMin = Math.floor((train.delay || 0) / 60);
      const delayText =
        (train.delay || 0) > 0
          ? `<div class="delay delayed">+${delayMin} min</div>`
          : `<div class="delay on-time">À l'heure</div>`;

      const cancelled =
        train.canceled === '1' ||
        train.canceled === 1 ||
        train.canceled === true;

      const occupancy = this.renderOccupancy(train.occupancy);

      // Nom de terminus / origine ultra robuste
      let mainStationName = null;
      const potential = [
        train.direction && train.direction.name,
        train.stationinfo && train.stationinfo.standardname,
        train.stationInfo && train.stationInfo.name,
        train.name && train.name.split(' ')[1]
      ].filter(Boolean);

      const normalize = (str) =>
        str
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');

      for (const src of potential) {
        if (normalize(src) !== normalize(state.station)) {
          mainStationName = src;
          break;
        }
      }

      let routeText = 'Destination inconnue';
      if (mainStationName) {
        routeText =
          state.mode === 'departure'
            ? `Vers ${mainStationName}`
            : `Depuis ${mainStationName}`;
      }

      // Numéro court du train
      let number = '—';
      if (train.vehicleinfo && train.vehicleinfo.shortname) {
        number = train.vehicleinfo.shortname;
      } else if (typeof train.vehicle === 'string') {
        const parts = train.vehicle.split('.');
        number = parts[parts.length - 1] || train.vehicle;
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

    renderTrainDetails(details, currentStation) {
      let html = '';

      // -------- Itinéraire (vue métro) --------
      if (details.vehicle && details.vehicle.stops) {
        const rawStops = details.vehicle.stops.stop;
        const stops = Array.isArray(rawStops) ? rawStops : [rawStops];

        const now = Utils.nowSeconds();

        // Index de la dernière gare déjà passée (avec retard)
        let lastPassedIndex = -1;
        stops.forEach((stop, i) => {
          const stopTime = parseInt(stop.time, 10);
          const delay = parseInt(stop.delay || 0, 10);
          const actualTime = stopTime + delay;
          if (actualTime <= now) {
            lastPassedIndex = i;
          }
        });

        html += '<h4>Itinéraire</h4><div class="metro-line">';

        stops.forEach((stop, i) => {
          const isCurrent =
            stop.station.toLowerCase() === currentStation.toLowerCase();
          const isFirst = i === 0;
          const isLast = i === stops.length - 1;

          const stopTime = parseInt(stop.time, 10);
          const delay = parseInt(stop.delay || 0, 10);
          const actualTime = stopTime + delay;

          const isTrainHere = i === lastPassedIndex;
          const isPassed = i < lastPassedIndex;
          const isCanceled = stop.canceled === '1' || stop.canceled === 1;

          const delayMin = Math.floor(delay / 60);
          const delayClass = delay > 0 ? 'has-delay' : '';
          const delayText =
            delay > 0
              ? ` <span class="stop-delay">+${delayMin}min</span>`
              : '';

          const cancelClass = isCanceled ? 'canceled' : '';
          const platform = stop.platform
            ? ` <span class="stop-platform">Voie ${stop.platform}</span>`
            : '';

          // Badge "Train ici" ou "Parti il y a X min"
          let statusBadge = '';
          if (isTrainHere && !isCanceled) {
            statusBadge = ' <span class="train-here">Train ici</span>';
          } else if (i === lastPassedIndex && !isTrainHere && !isCanceled && lastPassedIndex !== -1) {
            // Dernière gare quittée
            const minutesAgo = Math.max(
              0,
              Math.floor((now - actualTime) / 60)
            );
            if (minutesAgo === 0) {
              statusBadge =
                ' <span class="train-here">Vient de quitter</span>';
            } else {
              statusBadge = ` <span class="train-here">Parti il y a ${minutesAgo} min</span>`;
            }
          }

          html += `
            <div class="metro-stop ${isCurrent ? 'current' : ''} ${
            isFirst ? 'first' : ''
          } ${isLast ? 'last' : ''} ${delayClass} ${cancelClass} ${
            isTrainHere ? 'train-position' : ''
          } ${isPassed ? 'passed' : ''}">
              <div class="metro-dot">${isTrainHere ? '🚂' : ''}</div>
              <div class="metro-info">
                <div class="metro-station" data-station-name="${
                  stop.station
                }">
                  ${stop.station}${
            isCanceled
              ? ' <span class="stop-canceled">Annulé</span>'
              : ''
          }${statusBadge}${platform}
                </div>
                <div class="metro-time">${Utils.formatTime(
                  stop.time
                )}${delayText}</div>
              </div>
            </div>
          `;
        });

        html += '</div>';
      } else {
        html +=
          '<div class="info" style="margin:16px 0">ℹ️ Les détails des arrêts ne sont pas disponibles pour ce train.</div>';
      }

      // -------- Composition --------
      if (details.composition && details.composition.composition) {
        const comp = details.composition.composition;
        const segRaw = comp.segments && comp.segments.segment;
        const segments = Array.isArray(segRaw) ? segRaw : segRaw ? [segRaw] : [];

        if (segments.length > 0) {
          html += '<h4 style="margin-top:16px">Composition</h4>';
          html += '<div class="train-composition">';

          const seenUnits = new Set();

          segments.forEach((seg) => {
            if (!seg.composition || !seg.composition.units) return;

            const unitsRaw = seg.composition.units.unit;
            const units = Array.isArray(unitsRaw)
              ? unitsRaw
              : unitsRaw
              ? [unitsRaw]
              : [];

            units.forEach((unit) => {
              const materialType =
                (unit.materialType && unit.materialType.parent_type) ||
                unit.materialType ||
                '?';
              const unitId = unit.id || `${materialType}_${Math.random()}`;

              if (seenUnits.has(unitId)) return;
              seenUnits.add(unitId);

              const typeUpper = String(materialType).toUpperCase();
              let icon = '🚃';
              let label = 'Voiture';
              let cssClass = 'wagon';

              if (
                typeUpper.includes('HLE') ||
                String(materialType).toLowerCase().includes('loco')
              ) {
                icon = '🚂';
                label = 'Locomotive';
                cssClass = 'loco';
              } else if (
                typeUpper.includes('HVP') ||
                typeUpper.includes('HVR')
              ) {
                icon = '🎛️';
                label = 'Voiture pilote';
                cssClass = 'pilot';
              } else if (/^(M|I|B)\d+/.test(typeUpper)) {
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
          });

          html += '</div>';
          html +=
            '<p style="margin-top:8px;font-size:11px;color:#64748b;text-align:center">← Sens de marche (tête du train à gauche)</p>';
        } else {
          html +=
            '<h4 style="margin-top:16px">Composition</h4><div class="info">ℹ️ La composition n\'est pas disponible pour ce train.</div>';
        }
      } else {
        html +=
          '<h4 style="margin-top:16px">Composition</h4><div class="info">ℹ️ Données de composition non disponibles.</div>';
      }

      return html;
    },

    async renderTrainsList(data) {
      const container = DOM.trainsList;
      container.innerHTML = '';

      const key = state.mode === 'arrival' ? 'arrivals' : 'departures';
      const trainsKey = state.mode === 'arrival' ? 'arrival' : 'departure';
      const rawBlock = data[key];

      if (!rawBlock) {
        const modeText = state.mode === 'departure' ? 'départ' : 'arrivée';
        container.innerHTML = `
          <div class="info">Aucun ${modeText} prévu pour la gare de ${state.station}.</div>
        `;
        return;
      }

      const rawTrains = rawBlock[trainsKey] || [];
      const trains = Array.isArray(rawTrains)
        ? rawTrains
        : rawTrains
        ? [rawTrains]
        : [];

      // Bannière perturbations
      container.innerHTML += this.renderDisturbanceBanner();

      if (trains.length === 0) {
        const modeText = state.mode === 'departure' ? 'départ' : 'arrivée';
        container.innerHTML += `
          <div class="info">Aucun ${modeText} prévu pour la gare de ${state.station}.</div>
        `;
        return;
      }

      trains.forEach((t) => {
        container.innerHTML += this.renderTrain(t);
      });
    },

    showLoading() {
      DOM.trainsList.innerHTML = `
        <div class="loading">
          <div class="spinner"></div>
          <div style="margin-top:10px">Chargement des horaires...</div>
        </div>
      `;
    },

    showError(message) {
      DOM.trainsList.innerHTML = `
        <div class="error">⚠️ ${message}</div>
      `;
    }
  };

  // ---------- EVENTS ----------
  const Events = {
    // Gestion des clics sur la liste (train + gares de l’itinéraire)
    async handleTrainsListClick(event) {
      // 1) Clic sur une gare dans l’itinéraire
      const stationEl = event.target.closest('[data-station-name]');
      if (stationEl) {
        const newStation = stationEl.dataset.stationName;
        if (newStation && newStation !== state.station) {
          state.station = newStation;
          App.saveState();
          await App.init(true);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        return;
      }

      // 2) Clic sur une carte train (pour ouvrir/fermer les détails)
      const trainEl = event.target.closest('.train');
      if (!trainEl) return;

      const vehicleId = trainEl.dataset.vehicle;
      const dateStr = trainEl.dataset.datestr;
      const detailsEl = trainEl.nextElementSibling;
      const isExpanded = trainEl.classList.contains('expanded');

      // Fermer tous les autres
      document.querySelectorAll('.train.expanded').forEach((el) => {
        el.classList.remove('expanded');
        const d = el.nextElementSibling;
        if (d) d.innerHTML = '';
      });

      if (isExpanded) {
        // On ferme celui-ci
        trainEl.classList.remove('expanded');
        detailsEl.innerHTML = '';
        state.expandedVehicle = null;
        return;
      }

      trainEl.classList.add('expanded');
      state.expandedVehicle = vehicleId;
      detailsEl.innerHTML = `
        <div class="loading">
          <div class="spinner small"></div>
          Chargement des détails...
        </div>
      `;

      const details = await API.getVehicleDetails(vehicleId, dateStr);
      detailsEl.innerHTML = UI.renderTrainDetails(details, state.station);
    },

    handleStationSearch: Utils.debounce((e) => {
      UI.renderStationSelect(e.target.value);
    }, CONFIG.DEBOUNCE_DELAY),

    handleStationSelect(e) {
      state.station = e.target.value;
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

    handleDocumentClick(e) {
      const isSelect = DOM.stationSelect.contains(e.target);
      const isSearch = DOM.stationSearch.contains(e.target);
      if (!isSelect && !isSearch) {
        DOM.stationSelect.style.display = 'none';
      }
    },

    async handleLocate() {
      if (!navigator.geolocation) {
        alert("La géolocalisation n'est pas supportée par ce navigateur.");
        return;
      }

      DOM.locateBtn.disabled = true;
      DOM.locateBtn.textContent = '📍 Localisation…';

      try {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
          });
        });

        const { latitude, longitude } = position.coords;

        if (!state.allStations.length) {
          alert('Chargement des gares en cours, veuillez réessayer…');
          return;
        }

        let nearest = null;
        let minDist = Infinity;

        state.allStations.forEach((s) => {
          if (s.locationY && s.locationX) {
            const d = Utils.getDistance(
              latitude,
              longitude,
              parseFloat(s.locationY),
              parseFloat(s.locationX)
            );
            if (d < minDist) {
              minDist = d;
              nearest = s;
            }
          }
        });

        if (nearest) {
          state.station = nearest.standardname;
          App.saveState();
          await App.init(true);

          DOM.stationNameText.textContent = `${nearest.standardname} (${minDist.toFixed(
            1
          )} km)`;
          setTimeout(() => {
            DOM.stationNameText.textContent = nearest.standardname;
          }, 3000);
        } else {
          alert('Impossible de trouver une gare proche.');
        }
      } catch (e) {
        console.error('Erreur géolocalisation:', e);
        if (e.code === 1) {
          alert('Vous devez autoriser la géolocalisation pour utiliser cette fonction.');
        } else {
          alert('Erreur lors de la géolocalisation. Veuillez réessayer.');
        }
      } finally {
        DOM.locateBtn.disabled = false;
        DOM.locateBtn.textContent = '📍 Localiser';
      }
    }
  };

  // ---------- APP ----------
  const App = {
    saveState() {
      localStorage.setItem('nt_mode', state.mode);
      localStorage.setItem('nt_station', state.station);
    },

    setupListeners() {
      DOM.stationSearch.addEventListener('input', Events.handleStationSearch);
      DOM.stationSelect.addEventListener('change', Events.handleStationSelect);

      DOM.tabDeparture.addEventListener('click', () =>
        Events.handleModeChange('departure')
      );
      DOM.tabArrival.addEventListener('click', () =>
        Events.handleModeChange('arrival')
      );

      DOM.refreshBtn.addEventListener('click', () => this.init(true));
      DOM.trainsList.addEventListener('click', Events.handleTrainsListClick);
      DOM.locateBtn.addEventListener('click', Events.handleLocate);
      document.addEventListener('click', Events.handleDocumentClick);
    },

    async tryGeolocationOnFirstVisit() {
      const saved = localStorage.getItem('nt_station');
      if (saved) return false;
      if (!navigator.geolocation) return false;

      try {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: false,
            timeout: 5000,
            maximumAge: 60000
          });
        });

        const { latitude, longitude } = position.coords;

        // attendre les stations
        let attempts = 0;
        while (!state.allStations.length && attempts < 20) {
          await new Promise((r) => setTimeout(r, 200));
          attempts++;
        }
        if (!state.allStations.length) return false;

        let nearest = null;
        let minDist = Infinity;
        state.allStations.forEach((s) => {
          if (s.locationY && s.locationX) {
            const d = Utils.getDistance(
              latitude,
              longitude,
              parseFloat(s.locationY),
              parseFloat(s.locationX)
            );
            if (d < minDist) {
              minDist = d;
              nearest = s;
            }
          }
        });

        if (nearest && minDist < 50) {
          state.station = nearest.standardname;
          this.saveState();
          return true;
        }
      } catch (e) {
        console.log('Géolocalisation auto refusée/échouée:', e.message);
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
        // Charger stations
        if (!state.allStations.length) {
          console.log('Chargement de toutes les gares SNCB…');
          state.allStations = await API.getAllStations();
          console.log(`${state.allStations.length} gares chargées`);
        }

        // Perturbations
        state.disturbances = await API.getDisturbances();

        // 1) Liveboard du jour (par défaut maintenant)
        const todayData = await API.getStationBoard(
          state.station,
          state.mode
        );
        let trainsToday = extractTrainsFromLiveboard(todayData, state.mode);

        let mergedTrains = trainsToday.slice();
        let finalData = todayData;

        // 2) Si moins de MIN_TRAINS, on complète avec les premiers trains du lendemain
        if (mergedTrains.length < CONFIG.MIN_TRAINS) {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const dateTomorrow = Utils.getDateString(tomorrow);

          const tomorrowData = await API.getStationBoard(
            state.station,
            state.mode,
            { date: dateTomorrow, time: '0000' }
          );

          const trainsTomorrow = extractTrainsFromLiveboard(
            tomorrowData,
            state.mode
          );
          mergedTrains = mergedTrains.concat(trainsTomorrow);

          // On reconstruit un objet "fake" pour l’UI avec les trains fusionnés
          if (state.mode === 'departure') {
            finalData = {
              ...todayData,
              departures: {
                ...(todayData.departures || {}),
                departure: mergedTrains
              }
            };
          } else {
            finalData = {
              ...todayData,
              arrivals: {
                ...(todayData.arrivals || {}),
                arrival: mergedTrains
              }
            };
          }
        }

        await UI.renderTrainsList(finalData);

        // Auto-refresh
        state.autoRefreshHandle = setTimeout(
          () => this.init(),
          CONFIG.AUTO_REFRESH
        );
      } catch (e) {
        console.error('Erreur initialisation:', e);
        const msg = e.message.includes('HTTP 404')
          ? `Impossible de trouver la gare **${state.station}**. Vérifiez l'orthographe ou choisissez dans la liste.`
          : `Impossible de charger les horaires. Veuillez réessayer. (${e.message})`;
        UI.showError(msg);
      } finally {
        state.isFetching = false;
      }
    },

    async start() {
      this.setupListeners();
      const initPromise = this.init();
      const geolocated = await this.tryGeolocationOnFirstVisit();
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

// ---------- SERVICE WORKER ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then((reg) => {
        console.log('Service Worker enregistré');

        // Hot update : on force SKIP_WAITING côté SW
        reg.addEventListener('updatefound', () => {
          const installingWorker = reg.installing;
          if (!installingWorker) return;
          installingWorker.addEventListener('statechange', () => {
            if (
              installingWorker.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              installingWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch((err) =>
        console.log('Erreur lors de l’enregistrement du Service Worker:', err)
      );
  });

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'CONTROLLER_CHANGE') {
      console.log('Nouveau Service Worker activé. Rechargement forcé.');
      window.location.reload();
    }
  });
}
