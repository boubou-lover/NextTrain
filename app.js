/* ============================================================
   NextTrain – app.js
   (Numéro de version : voir version.json à la racine du projet)
   - Recherche gare : Enter / loupe Android / change (fallback)
   - Liste trains : affiche "Vers ..." / "Depuis ..."
   - Recherche train globale : OPTIMISÉE pour performance et fiabilité
   - Clic sur une gare dans l'itinéraire => ouvre le liveboard de cette gare
   ============================================================ */

(function () {
  // ---------- CONFIGURATION ----------
  const CONFIG = {
    API_BASE: "https://api.irail.be",
    CACHE_TTL: 5 * 60 * 1000,
    AUTO_REFRESH: 60 * 1000,
    RELATIVE_TIME_TICK: 15 * 1000, // rafraîchit "dans X min" sans re-fetcher les données
    DEBOUNCE_DELAY: 150,
    FETCH_TIMEOUT: 15000, // Augmenté à 15s
    OFFLINE_STATIONS_TTL: 7 * 24 * 60 * 60 * 1000,
    OFFLINE_LIVEBOARD_TTL: 10 * 60 * 1000,

    // Global train search cache - OPTIMISÉ
    GLOBAL_SEARCH_CACHE_TTL: 30 * 60 * 1000,
    GLOBAL_SEARCH_NEGATIVE_TTL: 5 * 60 * 1000,
    GLOBAL_SEARCH_CONCURRENCY: 4 // Réduit pour éviter de surcharger l'API
  };

  // ---------- ÉTAT GLOBAL ----------
  const state = {
    mode: localStorage.getItem("nt_mode") || "departure",
    station: localStorage.getItem("nt_station") || "Libramont",
    favorites: (() => {
      try {
        const raw = JSON.parse(localStorage.getItem("nt_favorites") || "[]");
        return Array.isArray(raw) ? raw : [];
      } catch {
        return [];
      }
    })(),
    allStations: [],
    allStationsNormalized: [],
    disturbances: [],
    expandedVehicle: null,
    expandedApiDate: null,
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

    // Calcule "dans X min" à partir de l'heure réelle de passage (heure prévue + retard).
    // Retourne { text, cls } pour l'affichage ET pour la mise à jour "live" périodique.
    formatRelative(realTimestampSec) {
      const now = Utils.nowSeconds();
      const diff = Number(realTimestampSec) - now;

      if (diff <= -30) return { text: "Parti", cls: "relative-past" };
      if (diff < 60) return { text: "Imminent", cls: "relative-now" };

      const mins = Math.round(diff / 60);
      if (mins < 60) return { text: `dans ${mins} min`, cls: mins <= 3 ? "relative-soon" : "relative-normal" };

      const hours = Math.floor(mins / 60);
      const remMins = mins % 60;
      const hoursText = remMins > 0 ? `dans ${hours}h${String(remMins).padStart(2, "0")}` : `dans ${hours}h`;
      return { text: hoursText, cls: "relative-normal" };
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
    .replace(/[\u0300-\u036f]/g, "");
},

    // Découpe un nom de gare en mots significatifs pour un matching plus robuste
    // que la simple recherche de sous-chaîne (ex: "Bruxelles-Midi" → ["bruxelles","midi"]).
    // Les mots de moins de 3 lettres sont ignorés (de, la, du...).
    stationNameParts(station) {
      return Utils.normalize(station)
        .split(/[\s\-/']+/)
        .filter((w) => w.length >= 3);
    },

    // Vrai si un mot apparaît dans le texte avec des frontières de mot
    // (évite qu'un nom court ne matche à l'intérieur d'un mot plus long sans rapport).
    containsWord(normalizedText, word) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(normalizedText);
    },

    // N'autorise que http(s) pour éviter tout lien javascript:/data: dans un attribut href
    isSafeHttpUrl(url) {
      try {
        const u = new URL(url);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    },

    // Échappement HTML - évite l'injection de balises via des données API/utilisateur
    escapeHtml(str) {
      return String(str ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[c]));
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
    refreshBtn: document.getElementById("refreshBtn"),
    favBtn: document.getElementById("favBtn"),
    favoritesBar: document.getElementById("favoritesBar"),
    appVersion: document.getElementById("appVersion")
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
        if (e.name === 'AbortError') {
          throw new Error(`Délai d'attente dépassé (${timeout/1000}s)`);
        }
        throw e;
      }
    },

    async getAllStations() {
      try {
        const url = `${CONFIG.API_BASE}/stations/?format=json&lang=${Utils.lang()}`;
        const data = await this.fetchWithTimeout(url, 15000);
        const stations = data.station || [];
        Offline.saveStations(stations);
        return stations;
      } catch (e) {
        console.warn("Erreur getAllStations:", e.message);
        const offline = Offline.loadStations();
        return offline || [];
      }
    },

    async getDisturbances() {
      try {
        const url = `${CONFIG.API_BASE}/disturbances/?format=json&lang=${Utils.lang()}`;
        const data = await this.fetchWithTimeout(url, 8000);
        return data.disturbance || [];
      } catch (e) {
        console.warn("Erreur getDisturbances:", e.message);
        return [];
      }
    },

    async getStationBoard(station, mode) {
      const arrdep = mode === "arrival" ? "ARR" : "DEP";
      const url = `${CONFIG.API_BASE}/liveboard/?station=${encodeURIComponent(station)}&arrdep=${arrdep}&lang=${Utils.lang()}&format=json`;
      try {
        const data = await this.fetchWithTimeout(url, 15000);
        Offline.saveLiveboard(station, mode, data);
        return data;
      } catch (e) {
        console.warn("Erreur getStationBoard:", e.message);
        const offline = Offline.loadLiveboard(station, mode);
        if (offline) {
          console.log("Utilisation des données hors ligne");
          return offline;
        }
        throw e;
      }
    },

    async getVehicleOnly(vehicleId, apiDate) {
      const url = `${CONFIG.API_BASE}/vehicle/?id=${encodeURIComponent(vehicleId)}&format=json&lang=${Utils.lang()}&date=${apiDate}`;
      return await this.fetchWithTimeout(url, 10000);
    },

    async getVehicleDetails(vehicleId, apiDate) {
      const key = Utils.cacheKey(vehicleId, apiDate);
      const cached = Cache.get(key);
      if (cached) return cached;

      const vehicleUrl = `${CONFIG.API_BASE}/vehicle/?id=${encodeURIComponent(vehicleId)}&format=json&lang=${Utils.lang()}&date=${apiDate}`;
      const compUrl = `${CONFIG.API_BASE}/composition/?id=${encodeURIComponent(vehicleId)}&format=json&date=${apiDate}`;

      const [vehicle, composition] = await Promise.all([
        this.fetchWithTimeout(vehicleUrl, 15000).catch(() => null),
        this.fetchWithTimeout(compUrl, 15000).catch(() => null)
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

      if (DOM.favBtn) {
        const isFav = App.isFavorite(state.station);
        DOM.favBtn.classList.toggle("active", isFav);
        DOM.favBtn.textContent = isFav ? "★" : "☆";
        DOM.favBtn.title = isFav ? "Retirer des favoris" : "Ajouter aux favoris";
      }
    },

    // Met à jour les compteurs "dans X min" affichés à l'écran, sans recharger les données.
    // Appelé toutes les CONFIG.RELATIVE_TIME_TICK ms tant que la page est visible.
    tickRelativeTimes() {
      document.querySelectorAll(".relative-time[data-realtime]").forEach((el) => {
        const real = Number(el.dataset.realtime);
        if (!real) return;
        const { text, cls } = Utils.formatRelative(real);
        el.textContent = text;
        el.className = `relative-time ${cls}`;
      });
    },

    renderFavorites() {
      if (!DOM.favoritesBar) return;
      if (!state.favorites.length) {
        DOM.favoritesBar.innerHTML = "";
        return;
      }
      DOM.favoritesBar.innerHTML = state.favorites
        .map((f) => {
          const isActive = Utils.normalize(f) === Utils.normalize(state.station);
          return `
            <span class="fav-chip ${isActive ? "active-station" : ""}" data-station="${Utils.escapeHtml(f)}">
              <span class="fav-goto">⭐ ${Utils.escapeHtml(f)}</span>
              <span class="fav-remove" data-remove-fav="${Utils.escapeHtml(f)}" title="Retirer des favoris">✕</span>
            </span>
          `;
        })
        .join("");
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
          .map((s) => `<option value="${Utils.escapeHtml(s.standardname)}" ${s.standardname === state.station ? "selected" : ""}>${Utils.escapeHtml(s.standardname)}</option>`)
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
      // 1️⃣ Source la plus fiable : vehicleinfo.category + number
      const category = train?.vehicleinfo?.category;
      const number = train?.vehicleinfo?.number;

      if (category && number) {
        return `${category} ${number}`;
      }

      // 2️⃣ Fallback : parser train.vehicle
      if (typeof train?.vehicle === "string") {
        const raw = train.vehicle.split(".").pop(); // ex: THA2115
        const match = raw.match(/^([A-Z]+)(\d+)$/);
        if (!match) return raw;

        let [, type, num] = match;

        // Normalisation minimale
        if (type === "ICT") type = "IC";

        return `${type} ${num}`;
      }

      // 3️⃣ Dernier recours
      return train?.vehicleinfo?.shortname ?? "—";
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

      const realTimestamp = Number(train.time) + delaySec;
      const relative = Utils.formatRelative(realTimestamp);
      const relativeHtml = cancelled
        ? ""
        : `<span class="relative-time ${relative.cls}" data-realtime="${realTimestamp}">${relative.text}</span>`;

      return `
        <div class="train ${cancelled ? "cancelled" : ""}" data-vehicle="${Utils.escapeHtml(train.vehicle)}" data-datestr="${apiDate}">
          <div class="left">
            <div class="train-number">${Utils.escapeHtml(number)} ${occupancy}</div>
            <div class="route">${Utils.escapeHtml(routeText)}</div>
            <div class="platform">Voie: ${Utils.escapeHtml(platform)}</div>
          </div>
          <div style="text-align:right">
            <div class="time">${time}</div>
            ${relativeHtml}
            <div class="date">${displayDate}</div>
            ${delayText}
          </div>
        </div>
        <div class="details"></div>
      `;
    },

    renderDisturbanceBanner() {
      const all = state.disturbances || [];
      if (!all.length) return "";

      // Matching robuste : tous les mots significatifs du nom de gare doivent apparaître,
      // en tant que mots entiers (pas de sous-chaîne partielle), dans le titre+description.
      const parts = Utils.stationNameParts(state.station);
      const matches = (d) => {
        if (!parts.length) return false;
        const text = Utils.normalize(`${d.title || ""} ${d.description || ""}`);
        return parts.every((p) => Utils.containsWord(text, p));
      };

      const byRecency = (a, b) => (parseInt(b.timestamp || 0, 10) - parseInt(a.timestamp || 0, 10));

      const rel = all.filter(matches).sort(byRecency).slice(0, 3);

      const renderItem = (d) => {
        const isPlanned = (d.type || "").toLowerCase() === "planned";
        const icon = isPlanned ? "🚧" : "⚠️";
        const label = isPlanned ? "Travaux prévus" : "Perturbation";
        const link = d.link && Utils.isSafeHttpUrl(d.link)
          ? ` <a href="${Utils.escapeHtml(d.link)}" target="_blank" rel="noopener noreferrer" class="disturbance-link">Plus d'infos →</a>`
          : "";
        return `
          <div class="disturbance-item ${isPlanned ? "planned" : ""}">
            <span class="disturbance-badge">${icon} ${label}</span>
            <div class="disturbance-title">${Utils.escapeHtml(d.title)}</div>
            ${link}
          </div>
        `;
      };

      if (rel.length) {
        return `
          <div class="banner">
            <strong>⚠️ Perturbations — ${Utils.escapeHtml(state.station)}</strong>
            <div style="margin-top:8px">${rel.map(renderItem).join("")}</div>
          </div>
        `;
      }

      // Aucune perturbation ne mentionne explicitement cette gare : on ne pollue pas
      // l'écran avec des perturbations sans rapport, mais on les rend accessibles
      // en un clic — utile car la NMBS utilise parfois des noms abrégés
      // ("Brux.-Midi" au lieu de "Bruxelles-Midi") que le matching peut manquer.
      const others = [...all].sort(byRecency).slice(0, 5);
      return `
        <details class="banner disturbance-fallback">
          <summary>ℹ️ Aucune perturbation connue pour ${Utils.escapeHtml(state.station)} — voir les ${others.length} perturbations en cours en Belgique</summary>
          <div style="margin-top:8px">${others.map(renderItem).join("")}</div>
        </details>
      `;
    },

    renderTrainDetails(details, currentStation) {
      let html = "";

      const vehicle = details && details.vehicle;
      const stopsData = vehicle && vehicle.stops && vehicle.stops.stop;

      if (stopsData) {
        const stops = Array.isArray(stopsData) ? stopsData : [stopsData];
        const now = Utils.nowSeconds();
        const lastIdx = stops.length - 1;

        // Détermine si le train a quitté un arrêt donné.
        // On utilise le champ temps réel "left" fourni par iRail quand il existe
        // (bien plus fiable qu'un simple calcul horaire), avec repli sur heure+retard
        // si l'API ne le fournit pas. Pour le terminus (qui n'a pas de "left"),
        // on se base sur l'heure d'arrivée prévue + retard.
        const hasLeftStop = (stop, i) => {
          const scheduledPlusDelay = parseInt(stop.time, 10) + parseInt(stop.delay || 0, 10);
          if (i === lastIdx) return scheduledPlusDelay <= now;
          if (stop.left === "1" || stop.left === 1 || stop.left === true) return true;
          if (stop.left === "0" || stop.left === 0 || stop.left === false) return false;
          return scheduledPlusDelay <= now; // champ "left" absent → repli horaire
        };

        let lastLeftIndex = -1;
        stops.forEach((stop, i) => { if (hasLeftStop(stop, i)) lastLeftIndex = i; });

        const arrivedAtTerminus = lastLeftIndex === lastIdx;
        const waitingAtOrigin = lastLeftIndex === -1;
        // Index de l'arrêt que le train vient de quitter, s'il est en route vers le suivant
        const inTransitAfterIndex = (!arrivedAtTerminus && !waitingAtOrigin) ? lastLeftIndex : -1;

        html += `<h4>Itinéraire</h4><div class="metro-line">`;

        stops.forEach((stop, i) => {
          const isCurrentStation = Utils.normalize(stop.station) === Utils.normalize(currentStation);
          // "Passé" = arrêt déjà quitté par le train (hors terminus, géré séparément ci-dessous)
          const isPassed = i <= lastLeftIndex && i !== lastIdx;
          const isCanceled = stop.canceled === "1" || stop.canceled === 1;

          const isWaitingHere = waitingAtOrigin && i === 0;
          const isArrivedHere = arrivedAtTerminus && i === lastIdx;
          const isNextStop = inTransitAfterIndex >= 0 && i === inTransitAfterIndex + 1;
          const isTrainPosition = isWaitingHere || isArrivedHere;

          const delay = parseInt(stop.delay || 0, 10);
          const delayMin = Math.floor(delay / 60);
          const delayText = delay > 0 ? ` <span class="stop-delay">+${delayMin}min</span>` : "";
          const platform = stop.platform ? ` <span class="stop-platform">Voie ${Utils.escapeHtml(stop.platform)}</span>` : "";

          let badge = "";
          if (!isCanceled && isWaitingHere) badge += ` <span class="train-here">🚉 En gare</span>`;
          if (!isCanceled && isArrivedHere) badge += ` <span class="train-here">✅ Arrivé</span>`;
          if (!isCanceled && isNextStop) badge += ` <span class="next-stop-badge">Prochain arrêt</span>`;

          html += `
            <div class="metro-stop ${i === 0 ? "first" : ""} ${i === lastIdx ? "last" : ""} ${isCurrentStation ? "current" : ""} ${isTrainPosition ? "train-position" : ""} ${isPassed ? "passed" : ""} ${isCanceled ? "canceled" : ""} ${isNextStop ? "next-stop" : ""}">
              <div class="metro-dot">${isTrainPosition ? "🚂" : ""}</div>
              <div class="metro-info">
                <div class="metro-station">
                  <a href="#" class="goto-station" data-station="${Utils.escapeHtml(stop.station)}">${Utils.escapeHtml(stop.station)}</a>
                  ${isCanceled ? ' <span class="stop-canceled">Annulé</span>' : ""}${badge}${platform}
                </div>
                <div class="metro-time">${Utils.formatTime(stop.time)}${delayText}</div>
              </div>
            </div>
          `;

          // Le train est entre deux gares : on l'affiche sur la ligne, entre les deux arrêts,
          // plutôt que de le "coller" artificiellement à la gare qu'il vient de quitter.
          if (!isCanceled && inTransitAfterIndex === i && stops[i + 1]) {
            html += `
              <div class="metro-transit">
                <div class="metro-transit-icon">🚂</div>
                <div class="metro-transit-text">En route vers <strong>${Utils.escapeHtml(stops[i + 1].station)}</strong></div>
              </div>
            `;
          }
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
        container.innerHTML += `<div class="info">Aucun ${modeText} prévu pour la gare de ${Utils.escapeHtml(state.station)}.</div>`;
        return;
      }

      container.innerHTML += list.map((t) => UI.renderTrain(t)).join("");

      await UI.restoreExpandedState();
    },

    // Ré-ouvre automatiquement la fiche du train qui était consultée avant un refresh
    // (auto-refresh, changement de gare via clic sur un arrêt, etc.)
    async restoreExpandedState() {
      const vehicleId = state.expandedVehicle;
      const apiDate = state.expandedApiDate;
      if (!vehicleId || !apiDate) return;

      const trainEl = DOM.trainsList
        ? Array.from(DOM.trainsList.querySelectorAll(".train")).find(
            (el) => el.dataset.vehicle === vehicleId && el.dataset.datestr === apiDate
          )
        : null;
      if (!trainEl) return; // le train n'est plus dans la liste courante (parti/pas encore listé)

      trainEl.classList.add("expanded");
      const detailsEl = trainEl.nextElementSibling;
      if (!detailsEl) return;

      // Sert d'abord depuis le cache pour éviter tout flash de chargement à chaque refresh
      const cached = Cache.get(Utils.cacheKey(vehicleId, apiDate));
      if (cached) {
        detailsEl.innerHTML = UI.renderTrainDetails(cached, state.station);
        return;
      }

      detailsEl.innerHTML = `
        <div class="loading">
          <div class="spinner small"></div>
          Chargement des détails...
        </div>
      `;
      const details = await API.getVehicleDetails(vehicleId, apiDate);
      detailsEl.innerHTML = UI.renderTrainDetails(details, state.station);
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
        state.expandedApiDate = null;
        return;
      }

      trainEl.classList.add("expanded");
      state.expandedVehicle = vehicleId;
      state.expandedApiDate = apiDate;

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
      state.expandedVehicle = null;
      state.expandedApiDate = null;
      App.saveState();

      if (DOM.stationSearch) DOM.stationSearch.value = "";
      select.style.display = "none";
      App.init(true);
    },

    handleStationSelect(e) {
      const value = e.target.value;
      if (!value) return;
      state.station = value;
      state.expandedVehicle = null;
      state.expandedApiDate = null;
      App.saveState();
      if (DOM.stationSearch) DOM.stationSearch.value = "";
      if (DOM.stationSelect) DOM.stationSelect.style.display = "none";
      App.init(true);
    },

    handleModeChange(mode) {
      state.mode = mode;
      state.expandedVehicle = null;
      state.expandedApiDate = null;
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
        state.expandedVehicle = null;
        state.expandedApiDate = null;
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
    },

    handleFavToggle() {
      App.toggleFavorite(state.station);
    },

    async handleFavoritesBarClick(event) {
      const removeBtn = event.target.closest("[data-remove-fav]");
      if (removeBtn) {
        event.stopPropagation();
        App.removeFavorite(removeBtn.dataset.removeFav);
        return;
      }

      const chip = event.target.closest(".fav-chip");
      if (!chip) return;
      const stationName = chip.dataset.station;
      if (!stationName || stationName === state.station) return;

      state.station = stationName;
      state.expandedVehicle = null;
      state.expandedApiDate = null;
      App.saveState();
      await App.init(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  // ---------- APP ----------
  const App = {
    saveState() {
      localStorage.setItem("nt_mode", state.mode);
      localStorage.setItem("nt_station", state.station);
    },

    isFavorite(station) {
      const n = Utils.normalize(station);
      return state.favorites.some((f) => Utils.normalize(f) === n);
    },

    saveFavorites() {
      try {
        localStorage.setItem("nt_favorites", JSON.stringify(state.favorites));
      } catch {}
    },

    toggleFavorite(station) {
      if (!station) return;
      if (this.isFavorite(station)) {
        state.favorites = state.favorites.filter((f) => Utils.normalize(f) !== Utils.normalize(station));
      } else {
        state.favorites = [...state.favorites, station];
      }
      this.saveFavorites();
      UI.updateHeader();
      UI.renderFavorites();
    },

    removeFavorite(station) {
      state.favorites = state.favorites.filter((f) => Utils.normalize(f) !== Utils.normalize(station));
      this.saveFavorites();
      UI.updateHeader();
      UI.renderFavorites();
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

      // Favoris
      if (DOM.favBtn) DOM.favBtn.addEventListener("click", Events.handleFavToggle);
      if (DOM.favoritesBar) DOM.favoritesBar.addEventListener("click", Events.handleFavoritesBarClick);

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

    // ========== RECHERCHE GLOBALE OPTIMISÉE ==========
    buildVehicleIdCandidates(digits) {
  // Préfixes de série SNCB couverts (IC/IR/L/P/S/ICT/THA/EUR/EXT)
  return [
    `BE.NMBS.IC${digits}`,
    `BE.NMBS.IR${digits}`,
    `BE.NMBS.L${digits}`,
    `BE.NMBS.P${digits}`,
    `BE.NMBS.S${digits}`,
    `BE.NMBS.ICT${digits}`,
    `BE.NMBS.THA${digits}`,
    `BE.NMBS.EUR${digits}`,
    `BE.NMBS.EXT${digits}`
  ];
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
      UI.showLoading(`🔍 Recherche du train ${digits}…`);

      // Aujourd'hui uniquement (beaucoup plus rapide qu'une recherche multi-jours)
      const days = [ new Date() ];
      

      const candidates = this.buildVehicleIdCandidates(digits);
      let found = null;

      console.log(`[SEARCH] Recherche de ${digits} avec ${candidates.length} formats possibles`);

      // Helper: sleep function
      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      // Helper: run tasks with limited concurrency + early exit + delay between requests
      async function runWithConcurrency(items, limit, worker) {
        let idx = 0;
        let foundResult = null;
        const running = new Set();

        async function runNext() {
          while (idx < items.length && !foundResult) {
            const my = idx++;
            const item = items[my];
            
            // Petit délai entre les requêtes pour ne pas surcharger l'API
            if (my > 0 && my % limit === 0) {
              await sleep(100);
            }
            
            const promise = (async () => {
              try {
                const result = await worker(item, my);
                if (result && !foundResult) {
                  foundResult = result;
                  console.log(`[SEARCH] ✅ Trouvé: ${item}`);
                }
                return result;
              } catch (e) {
                console.log(`[SEARCH] ❌ Échec: ${item} (${e.message || 'erreur'})`);
                return null;
              } finally {
                running.delete(promise);
              }
            })();
            
            running.add(promise);
            
            // Limite de concurrence
            if (running.size >= limit) {
              await Promise.race([...running]);
            }
          }
        }

        // Démarrer les workers
        const workers = Array(Math.min(limit, items.length))
          .fill(0)
          .map(() => runNext());

        await Promise.all(workers);
        
        // Attendre que tous les running se terminent
        if (running.size > 0) {
          await Promise.all([...running]);
        }

        return foundResult;
      }

      // Recherche par jour avec cache
      for (const day of days) {
        if (found) break;
        
        const apiDate = Utils.toApiDate(day);
        const cacheKey = this.globalCacheKey(digits, apiDate);
        
        console.log(`[SEARCH] Vérification du ${Utils.toFRDate(day)}`);

        // 1️⃣ Vérifier le cache
        const cached = this.getGlobalCache(cacheKey);
        if (cached) {
          if (cached.ok) {
            console.log(`[SEARCH] ✨ Cache HIT (positif) pour ${apiDate}`);
            found = cached.payload;
            break;
          } else {
            console.log(`[SEARCH] 💨 Cache HIT (négatif) pour ${apiDate} - skip`);
            continue; // Résultat négatif en cache, passer au jour suivant
          }
        }

        // 2️⃣ Rechercher dans l'API
        console.log(`[SEARCH] 🔄 Cache MISS pour ${apiDate} - recherche API`);
        
        const payload = await runWithConcurrency(
          candidates,
          CONFIG.GLOBAL_SEARCH_CONCURRENCY,
          async (vehicleId) => {
            const v = await API.getVehicleOnly(vehicleId, apiDate);
            if (v && v.stops && v.stops.stop) {
              return { vehicleId, apiDate };
            }
            return null;
          }
        );

        // 3️⃣ Mettre en cache le résultat
        if (payload) {
          this.setGlobalCache(cacheKey, true, payload);
          found = payload;
          console.log(`[SEARCH] 💾 Cache SAVE (positif) pour ${cacheKey}`);
          break;
        } else {
          this.setGlobalCache(cacheKey, false, null);
          console.log(`[SEARCH] 💾 Cache SAVE (négatif) pour ${cacheKey}`);
        }
      }

      // Affichage du résultat
      if (!found) {
        console.log(`[SEARCH] ❌ Aucun résultat trouvé pour ${digits}`);
        UI.showError(`Aucun train trouvé avec le numéro <strong>${Utils.escapeHtml(digits)}</strong> pour aujourd'hui.`);
        return;
      }

      console.log(`[SEARCH] ✅ Train trouvé: ${found.vehicleId} le ${found.apiDate}`);

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

      state.expandedVehicle = found.vehicleId;
      state.expandedApiDate = found.apiDate;

      DOM.trainsList.innerHTML = `
        <div class="banner" style="margin-bottom:10px">
          <strong>🔎 Résultat de recherche</strong><br>
          Train <strong>${Utils.escapeHtml(digits)}</strong> — ${Utils.escapeHtml(label)}<br>
          <span style="font-size:12px;color:#64748b">Date: ${displayDate}</span>
        </div>

        <div class="train expanded" data-vehicle="${Utils.escapeHtml(found.vehicleId)}" data-datestr="${found.apiDate}">
          <div class="left">
            <div class="train-number">${Utils.escapeHtml(label)}</div>
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
      UI.renderFavorites();
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
          ? `Impossible de trouver la gare <strong>${Utils.escapeHtml(state.station)}</strong>.`
          : `Impossible de charger les horaires. (${Utils.escapeHtml(e.message || "Erreur inconnue")})`;
        UI.showError(msg);
      } finally {
        state.isFetching = false;
      }
    },

    // Affiche le numéro de version depuis version.json (source unique de vérité,
    // partagée avec le Service Worker pour le nom du cache — voir service-worker.js).
    async loadVersion() {
      if (!DOM.appVersion) return;
      try {
        const res = await fetch("version.json", { cache: "no-store" });
        if (!res.ok) throw new Error("version.json indisponible");
        const info = await res.json();
        DOM.appVersion.textContent = `Version ${info.version}`;
        DOM.appVersion.title = info.notes || "";
      } catch {
        DOM.appVersion.textContent = ""; // pas bloquant si le fichier manque
      }
    },

    async start() {
      this.setupListeners();
      this.loadVersion();
      await this.init();

      // Ticker "dans X min" — mise à jour légère indépendante du refresh réseau
      setInterval(() => UI.tickRelativeTimes(), CONFIG.RELATIVE_TIME_TICK);
    }
  };

  // ---------- START ----------
  App.start();
})();