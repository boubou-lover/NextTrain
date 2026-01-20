/* ============================================================
   NextTrain – app.js (Version stable + recherche Android + recherche train globale)
   - Recherche gare : Enter / loupe Android / change (fallback)
   - Liste trains : affiche "Vers ..." / "Depuis ..."
   - Recherche train globale : tape uniquement les chiffres (ex: 2120) puis Enter
   - Clic sur une gare dans l’itinéraire => ouvre le liveboard de cette gare
   ============================================================ */

(function () {
  // ---------- CONFIGURATION ----------
  const CONFIG = {
    API_BASE: "https://api.irail.be",
    CACHE_TTL: 5 * 60 * 1000,
    AUTO_REFRESH: 60 * 1000,
    DEBOUNCE_DELAY: 150,
    FETCH_TIMEOUT: 7000,
    OFFLINE_STATIONS_TTL: 7 * 24 * 60 * 60 * 1000,
    OFFLINE_LIVEBOARD_TTL: 10 * 60 * 1000,

    // Global train search cache
    GLOBAL_SEARCH_CACHE_TTL: 30 * 60 * 1000,
    GLOBAL_SEARCH_NEGATIVE_TTL: 2 * 60 * 1000,
    GLOBAL_SEARCH_CONCURRENCY: 6
  };

  // ---------- ÉTAT GLOBAL ----------
  const state = {
    mode: localStorage.getItem("nt_mode") || "departure",
    station: localStorage.getItem("nt_station") || "Libramont",
    allStations: [],
    allStationsNormalized: [],
    disturbances: [],
    expandedVehicle: null,
    trainDetailsCache: {},
    autoRefreshHandle: null,
    isFetching: false,

    // global search cache in-memory
    globalSearchCache: new Map() // key -> {ts, ok, payload}
  };

  // ---------- UTILITAIRES ----------
  const Utils = {
    lang() {
      const nav = navigator.language || "fr-BE";
      return nav.startsWith("fr") ? "fr" : "en";
    },

    nowSeconds() {
      return Math.floor(Date.now() / 1000);
    },

    formatTime(timestampSec) {
      const date = new Date(Number(timestampSec) * 1000);
      return date.toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit" });
    },

    // ddmmyy (API iRail)
    toApiDate(date = new Date()) {
      const d = String(date.getDate()).padStart(2, "0");
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const y = String(date.getFullYear()).slice(-2);
      return `${d}${m}${y}`;
    },

    // JJ/MM/AAAA (affichage)
    toFRDate(date = new Date()) {
      const d = String(date.getDate()).padStart(2, "0");
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const y = String(date.getFullYear());
      return `${d}/${m}/${y}`;
    },

    toHHMM(date = new Date()) {
      const h = String(date.getHours()).padStart(2, "0");
      const m = String(date.getMinutes()).padStart(2, "0");
      return `${h}${m}`;
    },

    debounce(fn, delay) {
      let t;
      return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), delay);
      };
    },

    normalize(str) {
      return (str || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "");
    },

    cacheKey(vehicleId, apiDate) {
      return `${vehicleId}__${apiDate}`;
    },

    buildStationsIndex() {
      state.allStationsNormalized = state.allStations.map((s) => ({
        raw: s,
        norm: Utils.normalize(s.standardname || s.name || "")
      }));
    },

    // Haversine
    distanceKm(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    }
  };

  // ---------- DOM ----------
  const DOM = {
    stationNameText: document.getElementById("stationNameText"),
    stationSelect: document.getElementById("stationSelect"),
    stationSearch: document.getElementById("stationSearch"),
    trainSearch: document.getElementById("trainSearch"),
    tabDeparture: document.getElementById("tabDeparture"),
    tabArrival: document.getElementById("tabArrival"),
    trainsList: document.getElementById("trainsList"),
    locateBtn: document.getElementById("locateBtn"),
    refreshBtn: document.getElementById("refreshBtn")
  };

  // ---------- CACHE mémoire (détails train) ----------
  const Cache = {
    get(key) {
      const c = state.trainDetailsCache[key];
      if (!c) return null;
      if (Date.now() - c.ts > CONFIG.CACHE_TTL) {
        delete state.trainDetailsCache[key];
        return null;
      }
      return c.data;
    },
    set(key, data) {
      state.trainDetailsCache[key] = { ts: Date.now(), data };
    }
  };

  // ---------- OFFLINE (localStorage) ----------
  const Offline = {
    saveStations(stations) {
      try {
        localStorage.setItem("nt_allStations", JSON.stringify({ ts: Date.now(), stations }));
      } catch {}
    },
    loadStations() {
      try {
        const raw = localStorage.getItem("nt_allStations");
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || !obj.ts) return null;
        if (Date.now() - obj.ts > CONFIG.OFFLINE_STATIONS_TTL) return null;
        return obj.stations || null;
      } catch {
        return null;
      }
    },

    liveboardKey(station, mode) {
      return `nt_liveboard_${station}_${mode}`;
    },
    saveLiveboard(station, mode, data) {
      try {
        localStorage.setItem(this.liveboardKey(station, mode), JSON.stringify({ ts: Date.now(), data }));
      } catch {}
    },
    loadLiveboard(station, mode) {
      try {
        const raw = localStorage.getItem(this.liveboardKey(station, mode));
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || !obj.ts) return null;
        if (Date.now() - obj.ts > CONFIG.OFFLINE_LIVEBOARD_TTL) return null;
        return obj.data || null;
      } catch {
        return null;
      }
    }
  };

  // ---------- API ----------
  const API = {
    async fetchWithTimeout(url, timeout = CONFIG.FETCH_TIMEOUT) {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        clearTimeout(id);
        throw e;
      }
    },

    async getAllStations() {
      try {
        const url = `${CONFIG.API_BASE}/stations/?format=json&lang=${Utils.lang()}`;
        const data = await this.fetchWithTimeout(url, 10000);
        const stations = data.station || [];
        Offline.saveStations(stations);
        return stations;
      } catch (e) {
        const offline = Offline.loadStations();
        return offline || [];
      }
    },

    async getDisturbances() {
      try {
        const url = `${CONFIG.API_BASE}/disturbances/?format=json&lang=${Utils.lang()}`;
        const data = await this.fetchWithTimeout(url, 5000);
        return data.disturbance || [];
      } catch {
        return [];
      }
    },

    async getStationBoard(station, mode) {
      const arrdep = mode === "arrival" ? "ARR" : "DEP";
      const url = `${CONFIG.API_BASE}/liveboard/?station=${encodeURIComponent(station)}&arrdep=${arrdep}&lang=${Utils.lang()}&format=json`;
      try {
        const data = await this.fetchWithTimeout(url);
        Offline.saveLiveboard(station, mode, data);
        return data;
      } catch (e) {
        const offline = Offline.loadLiveboard(station, mode);
        if (offline) return offline;
        throw e;
      }
    },

    async getVehicleOnly(vehicleId, apiDate) {
      const url = `${CONFIG.API_BASE}/vehicle/?id=${encodeURIComponent(vehicleId)}&format=json&lang=${Utils.lang()}&date=${apiDate}`;
      return await this.fetchWithTimeout(url, 7000);
    },

    async getVehicleDetails(vehicleId, apiDate) {
      const key = Utils.cacheKey(vehicleId, apiDate);
      const cached = Cache.get(key);
      if (cached) return cached;

      const vehicleUrl = `${CONFIG.API_BASE}/vehicle/?id=${encodeURIComponent(vehicleId)}&format=json&lang=${Utils.lang()}&date=${apiDate}`;
      const compUrl = `${CONFIG.API_BASE}/composition/?id=${encodeURIComponent(vehicleId)}&format=json&date=${apiDate}`;

      const [vehicle, composition] = await Promise.all([
        this.fetchWithTimeout(vehicleUrl).catch(() => null),
        this.fetchWithTimeout(compUrl).catch(() => null)
      ]);

      const details = { vehicle, composition };
      Cache.set(key, details);
      return details;
    }
  };

  // ---------- UI ----------
  const UI = {
    updateHeader() {
      if (DOM.stationNameText) DOM.stationNameText.textContent = state.station;
      if (DOM.tabDeparture) DOM.tabDeparture.classList.toggle("active", state.mode === "departure");
      if (DOM.tabArrival) DOM.tabArrival.classList.toggle("active", state.mode === "arrival");
    },

    showLoading(label = "Chargement des horaires…") {
      if (!DOM.trainsList) return;
      DOM.trainsList.innerHTML = `
        <div class="loading">
          <div class="spinner"></div>
          <div style="margin-top:10px">${label}</div>
        </div>
      `;
    },

    showError(message) {
      if (!DOM.trainsList) return;
      DOM.trainsList.innerHTML = `<div class="error">⚠️ ${message}</div>`;
    },

    renderStationSelect(filter = "") {
      const select = DOM.stationSelect;
      if (!select) return;
      select.innerHTML = "";

      const q = Utils.normalize(filter);
      let list = state.allStationsNormalized;

      if (q) {
        const starts = [];
        const contains = [];
        for (const s of list) {
          if (s.norm.startsWith(q)) starts.push(s.raw);
          else if (s.norm.includes(q)) contains.push(s.raw);
        }
        list = [...starts, ...contains].map((raw) => ({ raw, norm: "" }));
      }

      const stations = (q ? list.map((x) => x.raw) : list.map((x) => x.raw))
        .slice(0, 60)
        .sort((a, b) => (a.standardname || "").localeCompare(b.standardname || ""));

      if (!stations.length && filter) {
        select.innerHTML = `<option disabled>❌ Aucune gare trouvée</option>`;
      } else {
        select.innerHTML = stations
          .map((s) => `<option value="${s.standardname}" ${s.standardname === state.station ? "selected" : ""}>${s.standardname}</option>`)
          .join("");
        if (stations.length === 60) select.innerHTML += `<option disabled>… (limité à 60)</option>`;
      }

      select.style.display = filter ? "block" : "none";
    },

    renderOccupancy(occupancy) {
      if (!occupancy || !occupancy.name || occupancy.name === "unknown") return "";
      const level = occupancy.name;
      const css = level === "high" ? "occ-high" : level === "medium" ? "occ-medium" : "";
      const pct = level === "high" ? 95 : level === "medium" ? 60 : 25;
      return `
        <span class="occupancy ${css}" title="${level}">
          <span class="occ-bar"><span class="occ-fill" style="width:${pct}%"></span></span>
        </span>
      `;
    },

    // Robust destination/origin text
    computeRouteText(train) {
      const dir = train && train.direction && train.direction.name ? String(train.direction.name) : "";
      if (dir) {
        return state.mode === "departure" ? `Vers ${dir}` : `Depuis ${dir}`;
      }

      // Fallbacks (varie selon iRail)
      const candidates = [
        train?.stationinfo?.standardname,
        train?.stationInfo?.name,
        train?.station,
        train?.name
      ].filter(Boolean).map(String);

      const currentNorm = Utils.normalize(state.station);
      for (const c of candidates) {
        const n = Utils.normalize(c);
        if (n && n !== currentNorm) {
          return state.mode === "departure" ? `Vers ${c}` : `Depuis ${c}`;
        }
      }

      return state.mode === "departure" ? "Vers destination inconnue" : "Depuis origine inconnue";
    },

    extractTrainNumber(train) {
  // Source la plus fiable : train.vehicle (ex: "BE.NMBS.IC2120")
  if (typeof train?.vehicle === "string") {
    const id = train.vehicle.split(".").pop(); // IC2120

    const match = id.match(/^([A-Z]+)(\d+)$/);
    if (match) {
      const [, type, num] = match;
      return `${type} ${num}`; // IC 2120
    }

    return id;
  }

  // Fallback (au cas très rare où vehicle n'existe pas)
  if (train?.vehicleinfo?.shortname) {
    return String(train.vehicleinfo.shortname);
  }

  return "—";
},

    renderTrain(train) {
      const time = Utils.formatTime(train.time);
      const apiDate = Utils.toApiDate(new Date(Number(train.time) * 1000)); // ddmmyy for API details
      const displayDate = Utils.toFRDate(new Date(Number(train.time) * 1000)); // JJ/MM/AAAA
      const number = UI.extractTrainNumber(train);
      const routeText = UI.computeRouteText(train);

      const platform = train.platform || "—";
      const delaySec = parseInt(train.delay || 0, 10);
      const delayMin = Math.floor(delaySec / 60);
      const delayText = delaySec > 0 ? `<div class="delay delayed">+${delayMin} min</div>` : `<div class="delay on-time">À l'heure</div>`;
      const cancelled = train.canceled === "1" || train.canceled === 1 || train.canceled === true;
      const occupancy = UI.renderOccupancy(train.occupancy);

      return `
        <div class="train ${cancelled ? "cancelled" : ""}" data-vehicle="${train.vehicle}" data-datestr="${apiDate}">
          <div class="left">
            <div class="train-number">${number} ${occupancy}</div>
            <div class="route">${routeText}</div>
            <div class="platform">Voie: ${platform}</div>
          </div>
          <div style="text-align:right">
            <div class="time">${time}</div>
            <div class="date">${displayDate}</div>
            ${delayText}
          </div>
        </div>
        <div class="details"></div>
      `;
    },

    renderDisturbanceBanner() {
      const rel = (state.disturbances || [])
        .filter((d) => `${d.title || ""} ${d.description || ""}`.toLowerCase().includes((state.station || "").toLowerCase()))
        .slice(0, 3);

      if (!rel.length) return "";
      return `
        <div class="banner">
          <strong>⚠️ Perturbations</strong>
          <div style="margin-top:6px">${rel.map((d) => d.title).join("<br>")}</div>
        </div>
      `;
    },

    renderTrainDetails(details, currentStation) {
      let html = "";

      const vehicle = details && details.vehicle;
      const stopsData = vehicle && vehicle.stops && vehicle.stops.stop;

      if (stopsData) {
        const stops = Array.isArray(stopsData) ? stopsData : [stopsData];
        const now = Utils.nowSeconds();

        let lastPassedIndex = -1;
        stops.forEach((stop, i) => {
          const t = parseInt(stop.time, 10);
          const d = parseInt(stop.delay || 0, 10);
          if (t + d <= now) lastPassedIndex = i;
        });

        html += `<h4>Itinéraire</h4><div class="metro-line">`;

        stops.forEach((stop, i) => {
          const isCurrent = Utils.normalize(stop.station) === Utils.normalize(currentStation);
          const isTrainHere = i === lastPassedIndex;
          const isPassed = i < lastPassedIndex;
          const isCanceled = stop.canceled === "1" || stop.canceled === 1;

          const delay = parseInt(stop.delay || 0, 10);
          const delayMin = Math.floor(delay / 60);
          const delayText = delay > 0 ? ` <span class="stop-delay">+${delayMin}min</span>` : "";
          const platform = stop.platform ? ` <span class="stop-platform">Voie ${stop.platform}</span>` : "";

          let badge = "";
          if (!isCanceled && isTrainHere) badge = ` <span class="train-here">Train ici</span>`;

          html += `
            <div class="metro-stop ${isCurrent ? "current" : ""} ${isTrainHere ? "train-position" : ""} ${isPassed ? "passed" : ""} ${isCanceled ? "canceled" : ""}">
              <div class="metro-dot">${isTrainHere ? "🚂" : ""}</div>
              <div class="metro-info">
                <div class="metro-station">
                  <a href="#" class="goto-station" data-station="${stop.station}">${stop.station}</a>
                  ${isCanceled ? ' <span class="stop-canceled">Annulé</span>' : ""}${badge}${platform}
                </div>
                <div class="metro-time">${Utils.formatTime(stop.time)}${delayText}</div>
              </div>
            </div>
          `;
        });

        html += `</div>`;
      } else {
        html += `<div class="info" style="margin:16px 0">ℹ️ Les détails des arrêts ne sont pas disponibles pour ce train.</div>`;
      }

      // composition (optionnel)
      const comp = details && details.composition && details.composition.composition;
      const segRaw = comp && comp.segments && comp.segments.segment;
      const segments = Array.isArray(segRaw) ? segRaw : segRaw ? [segRaw] : [];

      html += `<h4 style="margin-top:16px">Composition</h4>`;
      if (!segments.length) {
        html += `<div class="info">ℹ️ Données de composition non disponibles</div>`;
        return html;
      }

      html += `<div class="train-composition">`;
      const seen = new Set();

      segments.forEach((seg) => {
        const unitsRaw = seg?.composition?.units?.unit;
        const units = Array.isArray(unitsRaw) ? unitsRaw : unitsRaw ? [unitsRaw] : [];
        units.forEach((u) => {
          const material = (u.materialType && u.materialType.parent_type) || u.materialType || "?";
          const id = u.id || `${material}_${Math.random()}`;
          if (seen.has(id)) return;
          seen.add(id);

          const type = String(material).toUpperCase();
          let icon = "🚃";
          let label = "Voiture";
          let css = "wagon";
          if (type.includes("HLE") || String(material).toLowerCase().includes("loco")) { icon = "🚂"; label = "Locomotive"; css = "loco"; }
          else if (type.includes("HVP") || type.includes("HVR")) { icon = "🎛️"; label = "Voiture pilote"; css = "pilot"; }
          else if (type.includes("AM")) { icon = "🚊"; label = "Automotrice"; css = "emu"; }

          html += `
            <div class="train-unit ${css}" title="${label}">
              <div class="unit-icon">${icon}</div>
              <div class="unit-type">${material}</div>
            </div>
          `;
        });
      });

      html += `</div><p style="margin-top:8px;font-size:11px;color:#64748b;text-align:center">← Sens de marche (tête du train à gauche)</p>`;
      return html;
    },

    async renderTrainsList(data) {
      const container = DOM.trainsList;
      if (!container) return;
      container.innerHTML = "";

      container.innerHTML += UI.renderDisturbanceBanner();

      const key = state.mode === "departure" ? "departures" : "arrivals";
      const trainsKey = state.mode === "departure" ? "departure" : "arrival";
      const block = data && data[key];
      const raw = block && block[trainsKey];

      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      if (!list.length) {
        const modeText = state.mode === "departure" ? "départ" : "arrivée";
        container.innerHTML += `<div class="info">Aucun ${modeText} prévu pour la gare de ${state.station}.</div>`;
        return;
      }

      list.forEach((t) => {
        container.innerHTML += UI.renderTrain(t);
      });
    }
  };

  // ---------- EVENTS ----------
  const Events = {
    // click delegation (train list + itinerary stations)
    async handleTrainsListClick(event) {
      const goto = event.target.closest(".goto-station");
      if (goto) {
        event.preventDefault();
        const stationName = goto.dataset.station;
        if (stationName) {
          state.station = stationName;
          App.saveState();
          await App.init(true);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
        return;
      }

      const trainEl = event.target.closest(".train");
      if (!trainEl) return;

      const vehicleId = trainEl.dataset.vehicle;
      const apiDate = trainEl.dataset.datestr;
      const detailsEl = trainEl.nextElementSibling;
      const isExpanded = trainEl.classList.contains("expanded");

      document.querySelectorAll(".train.expanded").forEach((el) => {
        el.classList.remove("expanded");
        const d = el.nextElementSibling;
        if (d) d.innerHTML = "";
      });

      if (isExpanded) {
        state.expandedVehicle = null;
        return;
      }

      trainEl.classList.add("expanded");
      state.expandedVehicle = vehicleId;

      if (detailsEl) {
        detailsEl.innerHTML = `
          <div class="loading">
            <div class="spinner small"></div>
            Chargement des détails...
          </div>
        `;
      }

      const details = await API.getVehicleDetails(vehicleId, apiDate);
      if (detailsEl) detailsEl.innerHTML = UI.renderTrainDetails(details, state.station);
    },

    handleStationSearch: Utils.debounce((e) => {
      UI.renderStationSelect(e.target.value);
    }, CONFIG.DEBOUNCE_DELAY),

    // Enter/search/change on mobile => choose first match and load
    submitStationSearch() {
      const select = DOM.stationSelect;
      if (!select) return;
      if (select.style.display === "none") return;

      let opt = select.options[select.selectedIndex];
      if (!opt || opt.disabled) {
        opt = Array.from(select.options).find((o) => !o.disabled);
      }
      if (!opt || opt.disabled) return;

      state.station = opt.value;
      App.saveState();

      if (DOM.stationSearch) DOM.stationSearch.value = "";
      select.style.display = "none";
      App.init(true);
    },

    handleStationSelect(e) {
      const value = e.target.value;
      if (!value) return;
      state.station = value;
      App.saveState();
      if (DOM.stationSearch) DOM.stationSearch.value = "";
      if (DOM.stationSelect) DOM.stationSelect.style.display = "none";
      App.init(true);
    },

    handleModeChange(mode) {
      state.mode = mode;
      App.saveState();
      App.init(true);
    },

    handleDocumentClick(e) {
      const isSelect = DOM.stationSelect && DOM.stationSelect.contains(e.target);
      const isSearch = DOM.stationSearch && DOM.stationSearch.contains(e.target);
      if (!isSelect && !isSearch && DOM.stationSelect) DOM.stationSelect.style.display = "none";
    },

    // Global train search triggers
    handleTrainSearchInput(e) {
      const v = e?.target?.value || "";
      if (!v.trim()) App.init(true);
    },

    async handleTrainSearchSubmit(e) {
      if (e && e.preventDefault) e.preventDefault();
      const raw = DOM.trainSearch ? DOM.trainSearch.value.trim() : "";
      const digits = raw.replace(/\D/g, "");
      if (!digits) return;
      await App.searchTrainGlobal(digits);
    },

    async handleLocate() {
      if (!navigator.geolocation) {
        alert("La géolocalisation n'est pas supportée par votre navigateur.");
        return;
      }

      if (DOM.locateBtn) {
        DOM.locateBtn.disabled = true;
        DOM.locateBtn.textContent = "📍 Localisation…";
      }

      try {
        const pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
          });
        });

        const { latitude, longitude } = pos.coords;

        if (!state.allStations.length) {
          alert("Chargement des gares en cours, veuillez réessayer…");
          return;
        }

        let nearest = null;
        let best = Infinity;
        state.allStations.forEach((s) => {
          if (!s.locationY || !s.locationX) return;
          const d = Utils.distanceKm(latitude, longitude, parseFloat(s.locationY), parseFloat(s.locationX));
          if (d < best) { best = d; nearest = s; }
        });

        if (!nearest || best > 15) {
          alert("Aucune gare pertinente trouvée à proximité.");
          return;
        }

        state.station = nearest.standardname;
        App.saveState();
        await App.init(true);

        if (DOM.stationNameText) {
          DOM.stationNameText.textContent = `${nearest.standardname} (${best.toFixed(1)} km)`;
          setTimeout(() => { DOM.stationNameText.textContent = nearest.standardname; }, 3000);
        }
      } catch (err) {
        console.error("Erreur géolocalisation:", err);
        alert("Erreur lors de la géolocalisation. Veuillez réessayer.");
      } finally {
        if (DOM.locateBtn) {
          DOM.locateBtn.disabled = false;
          DOM.locateBtn.textContent = "📍 Localiser";
        }
      }
    }
  };

  // ---------- APP ----------
  const App = {
    saveState() {
      localStorage.setItem("nt_mode", state.mode);
      localStorage.setItem("nt_station", state.station);
    },

    setupListeners() {
      // Station search
      if (DOM.stationSearch) {
        DOM.stationSearch.addEventListener("input", Events.handleStationSearch);

        // Android/iOS "Enter" / "Go"
        DOM.stationSearch.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            Events.submitStationSearch();
          }
        });

        // Event "search" for input[type=search] on some browsers
        DOM.stationSearch.addEventListener("search", (e) => {
          e.preventDefault?.();
          Events.submitStationSearch();
        });

        // Fallback (blur/validation)
        DOM.stationSearch.addEventListener("change", () => {
          Events.submitStationSearch();
        });
      }

      if (DOM.stationSelect) {
        DOM.stationSelect.addEventListener("change", Events.handleStationSelect);
      }

      // Mode tabs
      if (DOM.tabDeparture) DOM.tabDeparture.addEventListener("click", () => Events.handleModeChange("departure"));
      if (DOM.tabArrival) DOM.tabArrival.addEventListener("click", () => Events.handleModeChange("arrival"));

      // Refresh
      if (DOM.refreshBtn) DOM.refreshBtn.addEventListener("click", () => this.init(true));

      // Train list click
      if (DOM.trainsList) DOM.trainsList.addEventListener("click", Events.handleTrainsListClick);

      // Locate
      if (DOM.locateBtn) DOM.locateBtn.addEventListener("click", Events.handleLocate);

      // Close select when click outside
      document.addEventListener("click", Events.handleDocumentClick);

      // Train global search
      if (DOM.trainSearch) {
        DOM.trainSearch.addEventListener("input", Events.handleTrainSearchInput);
        DOM.trainSearch.addEventListener("keydown", (e) => {
          if (e.key === "Enter") Events.handleTrainSearchSubmit(e);
        });
        DOM.trainSearch.addEventListener("search", (e) => Events.handleTrainSearchSubmit(e));
        DOM.trainSearch.addEventListener("change", (e) => Events.handleTrainSearchSubmit(e));
      }
    },

    buildVehicleIdCandidates(digits) {
      const prefixes = ["IC", "L", "P", "S", "IR", "EC", "ICE", "TGV", "THA", "EUROSTAR", "EXT"];
      const extra = ["ICT", "ICD", "R", "RE", "RB"];
      const all = [...prefixes, ...extra];

      const uniq = new Set();
      all.forEach((p) => uniq.add(`BE.NMBS.${p}${digits}`));
      all.forEach((p) => uniq.add(`${p}${digits}`));
      return Array.from(uniq);
    },

    globalCacheKey(digits, apiDate) {
      return `${digits}__${apiDate}`;
    },

    getGlobalCache(key) {
      const entry = state.globalSearchCache.get(key);
      if (!entry) return null;

      const ttl = entry.ok ? CONFIG.GLOBAL_SEARCH_CACHE_TTL : CONFIG.GLOBAL_SEARCH_NEGATIVE_TTL;
      if (Date.now() - entry.ts > ttl) {
        state.globalSearchCache.delete(key);
        return null;
      }
      return entry;
    },

    setGlobalCache(key, ok, payload) {
      state.globalSearchCache.set(key, { ts: Date.now(), ok, payload });
    },

    async searchTrainGlobal(digits) {
      UI.showLoading(`Recherche du train ${digits}…`);

      // Today, yesterday, tomorrow
      const now = new Date();
      const days = [
        new Date(now),
        new Date(now.getTime() - 24 * 60 * 60 * 1000),
        new Date(now.getTime() + 24 * 60 * 60 * 1000)
      ];

      const candidates = this.buildVehicleIdCandidates(digits);
      let found = null;

      // Helper: run tasks with limited concurrency
      async function runWithConcurrency(items, limit, worker) {
        const results = [];
        let idx = 0;
        let stop = false;

        const runners = new Array(limit).fill(0).map(async () => {
          while (!stop) {
            const my = idx++;
            if (my >= items.length) return;
            try {
              const r = await worker(items[my], my);
              if (r) {
                results.push(r);
                stop = true;
                return;
              }
            } catch {}
          }
        });

        await Promise.all(runners);
        return results[0] || null;
      }

      for (const day of days) {
        const apiDate = Utils.toApiDate(day);

        // Check cache first
        const cacheKey = this.globalCacheKey(digits, apiDate);
        const cached = this.getGlobalCache(cacheKey);
        if (cached && cached.ok) {
          found = cached.payload;
          break;
        } else if (cached && !cached.ok) {
          continue;
        }

        const payload = await runWithConcurrency(
          candidates,
          CONFIG.GLOBAL_SEARCH_CONCURRENCY,
          async (vehicleId) => {
            try {
              const v = await API.getVehicleOnly(vehicleId, apiDate);
              if (v && v.stops && v.stops.stop) {
                return { vehicleId, apiDate };
              }
              return null;
            } catch {
              return null;
            }
          }
        );

        if (payload) {
          this.setGlobalCache(cacheKey, true, payload);
          found = payload;
          break;
        } else {
          this.setGlobalCache(cacheKey, false, null);
        }
      }

      if (!found) {
        UI.showError(`Aucun train trouvé avec le numéro <strong>${digits}</strong> (aujourd'hui/hier/demain).`);
        return;
      }

      const details = await API.getVehicleDetails(found.vehicleId, found.apiDate);
      const label = found.vehicleId.split(".").pop() || found.vehicleId;

      const displayDate = (() => {
        // found.apiDate is ddmmyy
        const d = found.apiDate.slice(0, 2);
        const m = found.apiDate.slice(2, 4);
        const y = "20" + found.apiDate.slice(4, 6);
        return `${d}/${m}/${y}`;
      })();

      if (!DOM.trainsList) return;

      DOM.trainsList.innerHTML = `
        <div class="banner" style="margin-bottom:10px">
          <strong>🔎 Résultat</strong><br>
          Train <strong>${digits}</strong> — ${label}<br>
          <span style="font-size:12px;color:#64748b">Date: ${displayDate}</span>
        </div>

        <div class="train expanded" data-vehicle="${found.vehicleId}" data-datestr="${found.apiDate}">
          <div class="left">
            <div class="train-number">${label}</div>
            <div class="route">Recherche globale</div>
            <div class="platform">—</div>
          </div>
          <div style="text-align:right">
            <div class="time">—</div>
            <div class="date">${displayDate}</div>
            <div class="delay on-time">Détails</div>
          </div>
        </div>
        <div class="details">${UI.renderTrainDetails(details, state.station)}</div>
      `;

      window.scrollTo({ top: 0, behavior: "smooth" });
    },

    async init(forceRefresh = false) {
      if (state.isFetching && !forceRefresh) return;
      state.isFetching = true;

      UI.updateHeader();
      UI.showLoading();

      if (DOM.trainSearch) DOM.trainSearch.value = "";
      if (state.autoRefreshHandle) clearTimeout(state.autoRefreshHandle);

      try {
        if (!state.allStations.length) {
          const offline = Offline.loadStations();
          if (offline && offline.length) state.allStations = offline;
        }
        if (!state.allStations.length) {
          state.allStations = await API.getAllStations();
        }
        if (!state.allStationsNormalized.length) Utils.buildStationsIndex();

        state.disturbances = await API.getDisturbances();

        const data = await API.getStationBoard(state.station, state.mode);
        await UI.renderTrainsList(data);

        state.autoRefreshHandle = setTimeout(() => this.init(), CONFIG.AUTO_REFRESH);
      } catch (e) {
        console.error("Erreur init:", e);
        const msg = (e.message || "").includes("HTTP 404")
          ? `Impossible de trouver la gare <strong>${state.station}</strong>.`
          : `Impossible de charger les horaires. (${e.message || "Erreur inconnue"})`;
        UI.showError(msg);
      } finally {
        state.isFetching = false;
      }
    },

    async start() {
      this.setupListeners();
      await this.init();
    }
  };

  // ---------- START ----------
  App.start();
})();
