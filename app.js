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
    SCROLL_LOAD_MORE_THRESHOLD: 400, // px avant le bas de page pour charger la suite des trains
    SCROLL_DEBOUNCE_DELAY: 150,

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
    stationDropdownItems: [], // stations actuellement affichées dans la liste maison (hors lignes désactivées)
    stationDropdownActive: -1, // index sélectionné au clavier (-1 = aucun)
    boardHasMore: true, // reste-t-il des trains à charger pour la journée en cours ?
    boardLoadingMore: false,
    boardLastTime: null, // heure programmée (epoch sec) du dernier train affiché — curseur de pagination
    boardLoadDate: null, // jour du tableau affiché, pour détecter un passage à minuit
    shownTrainKeys: new Set(), // "vehicle__time" déjà affichés, pour dédupliquer au chargement de la suite
    disturbances: [],
    disturbancesHidden: localStorage.getItem("nt_hideDisturbances") === "1",
    expandedVehicle: null,
    expandedApiDate: null,
    trainDetailsCache: {},
    trainsByKey: new Map(), // "vehicle__ddmmyy" -> objet train de la liste (pour re-rendre une ligne)
    cancelOverrides: new Map(), // "vehicle__ddmmyy" -> {kind,label,hereCanceled,ts} (résultat de l'analyse des arrêts)
    autoRefreshHandle: null,
    isFetching: false,

    // global search cache in-memory
    globalSearchCache: new Map() // key -> {ts, ok, payload}
  };

  // ---------- UTILITAIRES ----------
  const Utils = {
    // iRail renvoie ses booléens sous des formes variables ("1", 1, true, "true").
    isFlagged(v) {
      return v === true || v === 1 || v === "1" || (typeof v === "string" && v.toLowerCase() === "true");
    },
    // Un train / arrêt est supprimé si l'un des champs d'annulation est positionné
    // (selon l'endpoint : canceled, departureCanceled ou arrivalCanceled).
    isCanceledItem(o) {
      return !!o && (Utils.isFlagged(o.canceled) || Utils.isFlagged(o.departureCanceled) || Utils.isFlagged(o.arrivalCanceled));
    },
    lang() {
      // Forcé en français : l'API iRail renvoie parfois les noms de gares
      // transfrontalières dans la langue du pays voisin (ex: "Lëtzebuerg" pour
      // Luxembourg) si on suit la langue du navigateur. On demande donc
      // toujours le français, quel que soit navigator.language.
      return "fr";
    },

    // Corrige les noms de gares transfrontalières que l'API iRail renvoie
    // parfois dans une autre langue que le français, même avec lang=fr
    // (données sourcées directement du réseau ferroviaire voisin).
    // N'affecte que l'affichage : la valeur technique utilisée pour
    // interroger l'API reste inchangée.
    STATION_NAME_OVERRIDES: {
      "letzebuerg": "Luxembourg"
      // Ajouter ici toute autre gare mal traduite, ex: "aachen": "Aix-la-Chapelle"
    },

    displayStationName(name) {
      if (!name) return name;
      const key = Utils.normalize(name);
      return Utils.STATION_NAME_OVERRIDES[key] || name;
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

      if (diff <= -30) {
        const pastText = state.mode === "arrival" ? "Arrivé" : "Parti";
        return { text: pastText, cls: "relative-past" };
      }
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

    // Découpe une chaîne déjà normalisée en mots (ex: "bruxelles-midi" → ["bruxelles","midi"]),
    // sans filtre de longueur minimale (utile pour la recherche, contrairement à
    // stationNameParts ci-dessous qui sert au matching des perturbations).
    wordsOf(normalizedStr) {
      return (normalizedStr || "").split(/[^a-z0-9]+/).filter(Boolean);
    },

    // Entoure de <mark> la première occurrence de la recherche dans le texte affiché
    // (comparaison insensible aux accents/casse via normalize, mais le texte original
    // est préservé pour l'affichage). Retourne du HTML déjà échappé, prêt à insérer.
    highlightMatch(text, rawQuery) {
      const safe = Utils.escapeHtml(text);
      const q = Utils.normalize(rawQuery);
      if (!q) return safe;
      const norm = Utils.normalize(text);
      const idx = norm.indexOf(q);
      if (idx === -1) return safe;
      const before = Utils.escapeHtml(text.slice(0, idx));
      const match = Utils.escapeHtml(text.slice(idx, idx + q.length));
      const after = Utils.escapeHtml(text.slice(idx + q.length));
      return `${before}<mark>${match}</mark>${after}`;
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
    stationDropdown: document.getElementById("stationDropdown"),
    stationSearch: document.getElementById("stationSearch"),
    stationSearchBtn: document.getElementById("stationSearchBtn"),
    trainSearch: document.getElementById("trainSearch"),
    trainSearchBtn: document.getElementById("trainSearchBtn"),
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

    async getStationBoard(station, mode, timeHHMM) {
      const arrdep = mode === "arrival" ? "ARR" : "DEP";
      let url = `${CONFIG.API_BASE}/liveboard/?station=${encodeURIComponent(station)}&arrdep=${arrdep}&lang=${Utils.lang()}&format=json`;
      if (timeHHMM) url += `&time=${encodeURIComponent(timeHHMM)}`;
      try {
        const data = await this.fetchWithTimeout(url, 15000);
        // On ne met en cache hors-ligne que le tableau initial (page complète du jour) :
        // une page "charger plus" écraserait le cache avec une liste partielle.
        if (!timeHHMM) Offline.saveLiveboard(station, mode, data);
        return data;
      } catch (e) {
        console.warn("Erreur getStationBoard:", e.message);
        if (!timeHHMM) {
          const offline = Offline.loadLiveboard(station, mode);
          if (offline) {
            console.log("Utilisation des données hors ligne");
            return offline;
          }
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
      if (DOM.stationNameText) DOM.stationNameText.textContent = Utils.displayStationName(state.station);
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
              <span class="fav-goto">⭐ ${Utils.escapeHtml(Utils.displayStationName(f))}</span>
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

    // Classe les résultats par pertinence plutôt que par simple ordre alphabétique global :
    // 1) la gare COMMENCE par la recherche (ex: "na" → "Namur")
    // 2) un MOT de la gare commence par la recherche (ex: "midi" → "Bruxelles-Midi")
    // 3) la recherche apparaît n'importe où (ex: "el" → "Bruxelles-...")
    // Chaque groupe est ensuite trié alphabétiquement en interne, sans jamais mélanger
    // les groupes entre eux (c'était le bug : un tri final unique annulait ce classement).
    renderStationSelect(filter = "") {
      const dropdown = DOM.stationDropdown;
      if (!dropdown) return;

      const q = Utils.normalize(filter);
      const byName = (a, b) => (a.standardname || "").localeCompare(b.standardname || "");
      let stations;

      if (q) {
        const starts = [];
        const wordStart = [];
        const contains = [];
        for (const s of state.allStationsNormalized) {
          if (s.norm.startsWith(q)) {
            starts.push(s.raw);
          } else if (Utils.wordsOf(s.norm).some((w) => w.startsWith(q))) {
            wordStart.push(s.raw);
          } else if (s.norm.includes(q)) {
            contains.push(s.raw);
          }
        }
        starts.sort(byName);
        wordStart.sort(byName);
        contains.sort(byName);
        stations = [...starts, ...wordStart, ...contains].slice(0, 60);
      } else {
        stations = state.allStationsNormalized.map((s) => s.raw).sort(byName).slice(0, 60);
      }

      state.stationDropdownItems = stations;
      state.stationDropdownActive = -1;

      if (!stations.length && filter) {
        dropdown.innerHTML = `<div class="station-option disabled">❌ Aucune gare trouvée</div>`;
      } else {
        dropdown.innerHTML = stations
          .map((s, i) => {
            const displayName = Utils.displayStationName(s.standardname);
            const label = filter ? Utils.highlightMatch(displayName, filter) : Utils.escapeHtml(displayName);
            return `<div class="station-option" id="station-opt-${i}" role="option" data-index="${i}" data-station="${Utils.escapeHtml(s.standardname)}">${label}</div>`;
          })
          .join("");
        if (stations.length === 60) dropdown.innerHTML += `<div class="station-option disabled">… (limité à 60)</div>`;
      }

      dropdown.style.display = filter ? "block" : "none";
      if (DOM.stationSearch) DOM.stationSearch.setAttribute("aria-expanded", filter ? "true" : "false");
    },

    // Met en évidence l'option active au clavier (flèches haut/bas) et la garde visible.
    setActiveStationOption(index) {
      const dropdown = DOM.stationDropdown;
      if (!dropdown) return;

      const options = dropdown.querySelectorAll(".station-option:not(.disabled)");
      options.forEach((el) => el.classList.remove("active"));

      const count = state.stationDropdownItems.length;
      if (!count) { state.stationDropdownActive = -1; return; }

      // Boucle sur la liste (flèche bas en bas de liste revient en haut, et inversement)
      const next = ((index % count) + count) % count;
      state.stationDropdownActive = next;

      const el = options[next];
      if (el) {
        el.classList.add("active");
        el.scrollIntoView({ block: "nearest" });
        if (DOM.stationSearch) DOM.stationSearch.setAttribute("aria-activedescendant", el.id);
      }
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
        const dirDisplay = Utils.displayStationName(dir);
        return state.mode === "departure" ? `Vers ${dirDisplay}` : `Depuis ${dirDisplay}`;
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
          const cDisplay = Utils.displayStationName(c);
          return state.mode === "departure" ? `Vers ${cDisplay}` : `Depuis ${cDisplay}`;
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

      // La liste (liveboard) indique si le train est supprimé À CETTE GARE. Un train limité à
      // un arrêt intermédiaire (ex. Bruxelles → Arlon au lieu de Luxembourg) n'est donc pas
      // forcément supprimé : l'analyse des arrêts (UI.analyzeCancellation) tranche.
      const key = `${train.vehicle}__${apiDate}`;
      state.trainsByKey.set(key, train);
      const flagged = Utils.isCanceledItem(train);
      let ov = flagged ? state.cancelOverrides.get(key) : null;
      if (ov && Date.now() - ov.ts > CONFIG.CACHE_TTL) ov = null;
      const modified = !!(ov && ov.kind === "partial" && !ov.hereCanceled);
      const cancelled = flagged && !modified;

      let delayText;
      if (modified) {
        delayText = `<div class="delay modified-badge">⚠️ ${Utils.escapeHtml(ov.label)}</div>`;
      } else if (cancelled) {
        const txt = ov && ov.kind === "partial" ? (ov.hereText || "Non desservi ici") : "Supprimé";
        delayText = `<div class="delay cancelled-badge">🚫 ${txt}</div>`;
      } else {
        delayText = delaySec > 0
          ? `<div class="delay delayed">+${delayMin} min</div>`
          : `<div class="delay on-time">À l'heure</div>`;
      }
      const occupancy = cancelled ? "" : UI.renderOccupancy(train.occupancy);
      const platformHtml = cancelled ? "" : `<div class="platform">Voie: ${Utils.escapeHtml(platform)}</div>`;

      const realTimestamp = Number(train.time) + delaySec;
      const relative = Utils.formatRelative(realTimestamp);
      const relativeHtml = cancelled
        ? ""
        : `<span class="relative-time ${relative.cls}" data-realtime="${realTimestamp}">${relative.text}</span>`;

      return `
        <div class="train ${cancelled ? "cancelled" : ""} ${modified ? "modified" : ""}" ${flagged ? 'data-flagged="1"' : ""} ${ov ? 'data-checked="1"' : ""} data-vehicle="${Utils.escapeHtml(train.vehicle)}" data-datestr="${apiDate}">
          <div class="left">
            <div class="train-number">${Utils.escapeHtml(number)} ${occupancy}</div>
            <div class="route">${Utils.escapeHtml(routeText)}</div>
            ${platformHtml}
          </div>
          <div style="text-align:right">
            <div class="time ${cancelled ? "time-cancelled" : ""}">${time}</div>
            ${relativeHtml}
            <div class="date">${displayDate}</div>
            ${delayText}
          </div>
        </div>
        <div class="details"></div>
      `;
    },

    // Met à jour uniquement la zone perturbations (masquer/afficher/déplier),
    // sans recharger toute la liste des trains.
    refreshDisturbanceZone() {
      const zone = document.getElementById("disturbanceZone");
      if (zone) zone.innerHTML = UI.renderDisturbanceBanner();
    },

    renderDisturbanceBanner() {
      const all = state.disturbances || [];
      if (!all.length) return "";

      if (state.disturbancesHidden) {
        return `
          <div class="disturbance-muted" data-disturbance-unmute role="button" tabindex="0">
            🔕 Perturbations masquées (${all.length}) <span class="disturbance-unmute-link">— Afficher</span>
          </div>
        `;
      }

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

      const closeBtn = `<button type="button" class="disturbance-close" data-disturbance-mute title="Masquer les perturbations" aria-label="Masquer les perturbations">✕</button>`;

      if (rel.length) {
        return `
          <div class="banner disturbance-banner">
            <div class="disturbance-header">
              <strong>⚠️ Perturbations — ${Utils.escapeHtml(Utils.displayStationName(state.station))}</strong>
              ${closeBtn}
            </div>
            <div class="disturbance-list">${rel.map(renderItem).join("")}</div>
          </div>
        `;
      }

      // Aucune perturbation ne mentionne explicitement cette gare : on ne pollue pas
      // l'écran avec des perturbations sans rapport, mais on les rend accessibles
      // en un clic — utile car la NMBS utilise parfois des noms abrégés
      // ("Brux.-Midi" au lieu de "Bruxelles-Midi") que le matching peut manquer.
      const others = [...all].sort(byRecency).slice(0, 5);
      return `
        <div class="banner disturbance-fallback-card">
          <div class="disturbance-header">
            <button type="button" class="disturbance-summary-toggle" data-disturbance-toggle>
              <span class="toggle-caret">▸</span>
              ℹ️ Aucune perturbation connue pour ${Utils.escapeHtml(Utils.displayStationName(state.station))} — voir les ${others.length} en Belgique
            </button>
            ${closeBtn}
          </div>
          <div class="disturbance-list disturbance-list-collapsed" data-disturbance-list>${others.map(renderItem).join("")}</div>
        </div>
      `;
    },

    // Analyse les arrêts d'un train pour distinguer :
    //  - "full"    : train supprimé (tous les arrêts annulés, ou drapeau liste sans détail contraire)
    //  - "partial" : parcours modifié (ex. limité à Arlon, Luxembourg non desservi)
    //  - "none"    : rien d'annulé
    // Les arrêts font foi dès qu'ils montrent un mélange d'arrêts desservis / non desservis.
    analyzeCancellation(details, rowFlagged, currentStation, mode) {
      const sd = details && details.vehicle && details.vehicle.stops && details.vehicle.stops.stop;
      const stops = sd ? (Array.isArray(sd) ? sd : [sd]) : [];
      const n = stops.length;
      const has = (v) => v !== undefined && v !== null;

      // Départ / arrivée sont évalués séparément : sur un train limité à Arlon, le DÉPART d'Arlon
      // est supprimé mais son ARRIVÉE ne l'est pas — Arlon reste donc un arrêt desservi (terminus).
      const depC = stops.map((st) => Utils.isFlagged(has(st.departureCanceled) ? st.departureCanceled : st.canceled));
      const arrKnown = stops.map((st) => has(st.arrivalCanceled));
      const arrC = stops.map((st, i) => (arrKnown[i] ? Utils.isFlagged(st.arrivalCanceled) : depC[i]));

      // Si l'API ne fournit pas arrivalCanceled, on déduit le nouveau terminus : c'est le premier
      // arrêt du bloc final d'arrêts à départ supprimé, à condition que le train quitte l'arrêt précédent.
      let tailStart = n;
      while (tailStart > 0 && (tailStart - 1 === n - 1 || depC[tailStart - 1])) tailStart--;
      if (tailStart > 0 && tailStart < n && !arrKnown[tailStart] && !depC[tailStart - 1]) {
        arrC[tailStart] = false;
      }

      // Arrêt totalement non desservi = ni arrivée ni départ (1er arrêt : pas d'arrivée ; dernier : pas de départ)
      const flags = stops.map((_, i) => (i === 0 || arrC[i]) && (i === n - 1 || depC[i]));
      const c = flags.filter(Boolean).length;
      const anyCancel = depC.some(Boolean) || arrC.some(Boolean);

      let kind;
      if (!n) kind = rowFlagged ? "full" : "none";
      else if (c === n) kind = "full";
      else if (c > 0 || anyCancel) kind = "partial";
      else kind = rowFlagged ? "full" : "none";

      const info = {
        kind, stops, flags, depC, arrC,
        canceledStops: stops.filter((_, i) => flags[i]),
        endIdx: -1,
        hereCanceled: false,
        hereText: "Non desservi ici",
        label: "Parcours modifié",
        title: "Parcours modifié"
      };
      if (kind !== "partial") return info;

      const nm = (st) => Utils.displayStationName(st.station);
      const firstServed = flags.indexOf(false);
      const lastServed = flags.lastIndexOf(false);
      if (firstServed < 0) return info;
      const truncatedEnd = flags.slice(0, lastServed + 1).every((f) => !f) && lastServed < n - 1;
      const truncatedStart = flags.slice(firstServed).every((f) => !f) && firstServed > 0;
      if (truncatedEnd) {
        info.endIdx = lastServed;
        info.label = `Limité à ${nm(stops[lastServed])}`;
        info.title = `Parcours limité à ${nm(stops[lastServed])}`;
      } else if (truncatedStart) {
        info.label = `Part de ${nm(stops[firstServed])}`;
        info.title = `Parcours débutant à ${nm(stops[firstServed])}`;
      }

      // Statut à la gare consultée, selon l'onglet : départs → départ supprimé ? ; arrivées → arrivée supprimée ?
      const hereIdx = stops.findIndex((st) => Utils.normalize(st.station) === Utils.normalize(currentStation));
      if (hereIdx >= 0) {
        info.hereCanceled = mode === "arrival" ? arrC[hereIdx] : depC[hereIdx];
        if (hereIdx === info.endIdx && mode !== "arrival") info.hereText = "Terminus ici";
      }
      return info;
    },

    // Re-rend la ligne d'un train signalé supprimé par la liste une fois ses arrêts connus.
    refreshRowFromDetails(detailsEl, details) {
      const row = detailsEl && detailsEl.previousElementSibling;
      if (!row || !row.classList || !row.classList.contains("train") || row.dataset.flagged !== "1") return;
      const key = `${row.dataset.vehicle}__${row.dataset.datestr}`;
      const train = state.trainsByKey.get(key);
      if (!train) return;

      const info = UI.analyzeCancellation(details, true, state.station, state.mode);
      const next = { kind: info.kind, label: info.label, hereCanceled: info.hereCanceled, hereText: info.hereText, ts: Date.now() };
      const prev = state.cancelOverrides.get(key) || { kind: "full", label: "", hereCanceled: false, hereText: undefined };
      state.cancelOverrides.set(key, next);
      const same = prev.kind === next.kind && prev.hereCanceled === next.hereCanceled && prev.hereText === next.hereText && (next.kind !== "partial" || prev.label === next.label);
      if (same) return;

      const tmp = document.createElement("div");
      tmp.innerHTML = UI.renderTrain(train);
      const newRow = tmp.firstElementChild;
      if (!newRow) return;
      if (row.classList.contains("expanded")) newRow.classList.add("expanded");
      row.replaceWith(newRow);
    },

    // Pour les trains signalés supprimés dans la liste, charge discrètement leurs arrêts
    // (mis en cache) afin d'afficher directement le bon statut sans clic.
    checkCancelledRows() {
      const rows = Array.from(document.querySelectorAll(".train[data-flagged=\"1\"]:not([data-checked])")).slice(0, 8);
      rows.forEach((row) => {
        row.dataset.checked = "1";
        const detailsEl = row.nextElementSibling;
        API.getVehicleDetails(row.dataset.vehicle, row.dataset.datestr)
          .then((d) => UI.refreshRowFromDetails(detailsEl, d))
          .catch(() => {});
      });
    },

    renderTrainDetails(details, currentStation, opts = {}) {
      let html = "";

      const vehicle = details && details.vehicle;
      const stopsData = vehicle && vehicle.stops && vehicle.stops.stop;

      if (stopsData) {
        const stops = Array.isArray(stopsData) ? stopsData : [stopsData];
        const now = Utils.nowSeconds();
        const lastIdx = stops.length - 1;

        // Suppression totale ou parcours modifié (voir analyzeCancellation).
        const info = UI.analyzeCancellation(details, !!opts.flagged, currentStation, state.mode);
        const isStopCanceled = (st) => Utils.isCanceledItem(st);
        const canceledStops = info.canceledStops;
        const fullCancel = info.kind === "full";

        if (fullCancel) {
          html += `
            <div class="cancel-banner" role="status">
              <span class="cancel-banner-icon">🚫</span>
              <div>
                <strong>Train supprimé</strong>
                <div class="cancel-banner-sub">Ce train ne circule pas. Vérifiez le train suivant ou les perturbations.</div>
              </div>
            </div>`;
        } else if (info.kind === "partial") {
          const names = canceledStops.slice(0, 3).map((st) => Utils.escapeHtml(Utils.displayStationName(st.station))).join(", ");
          const more = canceledStops.length > 3 ? `… (+${canceledStops.length - 3})` : "";
          const here = info.hereCanceled ? ` Ce train ne s'arrête pas à ${Utils.escapeHtml(Utils.displayStationName(currentStation))}.` : "";
          html += `
            <div class="cancel-banner partial" role="status">
              <span class="cancel-banner-icon">⚠️</span>
              <div>
                <strong>${Utils.escapeHtml(info.title)}</strong>
                <div class="cancel-banner-sub">Le train circule mais ne dessert pas : ${names}${more}.${here}</div>
              </div>
            </div>`;
        }

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

        // Train supprimé : aucun suivi temps réel (pas de "en gare", "en route", etc.)
        const arrivedAtTerminus = !fullCancel && lastLeftIndex === lastIdx;
        const waitingAtOrigin = !fullCancel && lastLeftIndex === -1;
        // Index de l'arrêt que le train vient de quitter, s'il est en route vers le suivant
        const inTransitAfterIndex = (!fullCancel && !arrivedAtTerminus && !waitingAtOrigin) ? lastLeftIndex : -1;

        html += `<h4>Itinéraire</h4><div class="metro-line">`;

        stops.forEach((stop, i) => {
          const isCurrentStation = Utils.normalize(stop.station) === Utils.normalize(currentStation);
          // "Passé" = arrêt déjà quitté par le train (hors terminus, géré séparément ci-dessous)
          const isPassed = !fullCancel && i <= lastLeftIndex && i !== lastIdx;
          const stopCanceled = !!info.flags[i];
          const isCanceled = fullCancel || stopCanceled;

          const isWaitingHere = waitingAtOrigin && i === 0;
          const isArrivedHere = arrivedAtTerminus && i === lastIdx;
          const isNextStop = inTransitAfterIndex >= 0 && i === inTransitAfterIndex + 1;
          const isTrainPosition = isWaitingHere || isArrivedHere;

          const delay = parseInt(stop.delay || 0, 10);
          const delayMin = Math.floor(delay / 60);
          const hasDelay = !isCanceled && delay > 0;
          const delayText = !isCanceled && delay > 0 ? ` <span class="stop-delay">+${delayMin}min</span>` : "";
          const platform = !isCanceled && stop.platform ? ` <span class="stop-platform">Voie ${Utils.escapeHtml(stop.platform)}</span>` : "";

          let badge = "";
          if (!isCanceled && isWaitingHere) badge += ` <span class="train-here">🚉 En gare</span>`;
          if (!isCanceled && isArrivedHere) badge += ` <span class="train-here">✅ Arrivé</span>`;
          if (!isCanceled && isNextStop) badge += ` <span class="next-stop-badge">Prochain arrêt</span>`;

          html += `
            <div class="metro-stop ${i === 0 ? "first" : ""} ${i === lastIdx ? "last" : ""} ${isCurrentStation ? "current" : ""} ${isTrainPosition ? "train-position" : ""} ${isPassed ? "passed" : ""} ${isCanceled ? "canceled" : ""} ${isNextStop ? "next-stop" : ""} ${hasDelay ? "has-delay" : ""}">
              <div class="metro-dot">${isTrainPosition ? "🚂" : ""}</div>
              <div class="metro-info">
                <div class="metro-station">
                  <a href="#" class="goto-station" data-station="${Utils.escapeHtml(stop.station)}">${Utils.escapeHtml(Utils.displayStationName(stop.station))}</a>
                  ${!fullCancel && stopCanceled ? ' <span class="stop-canceled">Supprimé</span>' : ""}${!fullCancel && i === info.endIdx ? ' <span class="stop-terminus">Terminus modifié</span>' : ""}${badge}${platform}
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

        // Diagnostic : valeurs brutes d'annulation renvoyées par iRail (uniquement si quelque chose est annulé)
        if (info.kind !== "none") {
          const val = (v) => (v === undefined || v === null ? "—" : String(v));
          const rows = stops.map((st, i) =>
            `${Utils.escapeHtml(Utils.displayStationName(st.station)).padEnd(22)} canceled=${val(st.canceled)}  dep=${val(st.departureCanceled)}  arr=${val(st.arrivalCanceled)}  → ${info.flags[i] ? "NON desservi" : "desservi"}`
          ).join("\n");
          html += `<details class="debug-raw"><summary>🔍 Diagnostic (valeurs iRail)</summary><pre>${rows}</pre></details>`;
        }
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

      container.innerHTML += `<div id="disturbanceZone">${UI.renderDisturbanceBanner()}</div>`;

      const key = state.mode === "departure" ? "departures" : "arrivals";
      const trainsKey = state.mode === "departure" ? "departure" : "arrival";
      const block = data && data[key];
      const raw = block && block[trainsKey];

      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];

      // Réinitialise la pagination "charger plus" à chaque rendu complet
      // (nouvelle gare, changement de mode, auto-refresh...).
      state.shownTrainKeys = new Set(list.map((t) => `${t.vehicle}__${t.time}`));
      state.boardLastTime = list.length ? Number(list[list.length - 1].time) : null;
      state.boardLoadDate = new Date();
      state.boardHasMore = list.length > 0;
      state.boardLoadingMore = false;

      if (!list.length) {
        const modeText = state.mode === "departure" ? "départ" : "arrivée";
        container.innerHTML += `<div class="info">Aucun ${modeText} prévu pour la gare de ${Utils.escapeHtml(Utils.displayStationName(state.station))}.</div>`;
        return;
      }

      container.innerHTML += `<div id="trainsListItems">${list.map((t) => UI.renderTrain(t)).join("")}</div>`;
      container.innerHTML += `<div id="loadMoreZone" class="load-more-zone"></div>`;

      await UI.restoreExpandedState();
      UI.checkCancelledRows();
    },

    // Charge la suite des trains du jour en interrogeant à nouveau le liveboard,
    // à partir de l'heure du dernier train déjà affiché (paramètre "time" de l'API iRail).
    // Déclenché par le scroll (voir setupListeners) plutôt que par un bouton "page suivante".
    async loadMoreTrains() {
      const itemsEl = document.getElementById("trainsListItems");
      if (!itemsEl) return; // pas la liste standard (ex: vue "résultat de recherche de train")
      if (state.boardLoadingMore || !state.boardHasMore || state.isFetching) return;
      if (state.boardLastTime == null) { state.boardHasMore = false; return; }

      state.boardLoadingMore = true;
      const zone = document.getElementById("loadMoreZone");
      if (zone) zone.innerHTML = `<div class="load-more-spinner"><div class="spinner small"></div> Chargement de la suite…</div>`;

      try {
        const nextDate = new Date((state.boardLastTime + 60) * 1000);

        // La requête ne couvre qu'une journée : si l'heure suivante retombe sur un autre
        // jour calendaire (passage de minuit), il n'y a plus rien à charger pour aujourd'hui.
        if (!state.boardLoadDate || nextDate.getDate() !== state.boardLoadDate.getDate()) {
          state.boardHasMore = false;
          if (zone) zone.innerHTML = `<div class="load-more-end">Fin des horaires du jour.</div>`;
          return;
        }

        const data = await API.getStationBoard(state.station, state.mode, Utils.toHHMM(nextDate));

        const key = state.mode === "departure" ? "departures" : "arrivals";
        const trainsKey = state.mode === "departure" ? "departure" : "arrival";
        const block = data && data[key];
        const raw = block && block[trainsKey];
        const list = Array.isArray(raw) ? raw : raw ? [raw] : [];

        const fresh = list.filter((t) => !state.shownTrainKeys.has(`${t.vehicle}__${t.time}`));

        if (!fresh.length) {
          state.boardHasMore = false;
          if (zone) zone.innerHTML = `<div class="load-more-end">Plus aucun train prévu pour aujourd'hui.</div>`;
          return;
        }

        fresh.forEach((t) => state.shownTrainKeys.add(`${t.vehicle}__${t.time}`));
        state.boardLastTime = Number(fresh[fresh.length - 1].time);

        itemsEl.insertAdjacentHTML("beforeend", fresh.map((t) => UI.renderTrain(t)).join(""));
        if (zone) zone.innerHTML = "";
        UI.checkCancelledRows();
      } catch (e) {
        console.warn("Erreur loadMoreTrains:", e.message);
        // Pas bloquant : l'utilisateur peut simplement re-scroller pour réessayer.
        if (zone) zone.innerHTML = "";
      } finally {
        state.boardLoadingMore = false;
      }
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
        detailsEl.innerHTML = UI.renderTrainDetails(cached, state.station, { flagged: trainEl.dataset.flagged === "1" });
        UI.refreshRowFromDetails(detailsEl, cached);
        return;
      }

      detailsEl.innerHTML = `
        <div class="loading">
          <div class="spinner small"></div>
          Chargement des détails...
        </div>
      `;
      const details = await API.getVehicleDetails(vehicleId, apiDate);
      detailsEl.innerHTML = UI.renderTrainDetails(details, state.station, { flagged: trainEl.dataset.flagged === "1" });
      UI.refreshRowFromDetails(detailsEl, details);
    }
  };

  // ---------- EVENTS ----------
  const Events = {
    // click delegation (train list + itinerary stations)
    async handleTrainsListClick(event) {
      const muteBtn = event.target.closest("[data-disturbance-mute]");
      if (muteBtn) {
        event.preventDefault();
        App.setDisturbancesHidden(true);
        return;
      }

      const unmuteEl = event.target.closest("[data-disturbance-unmute]");
      if (unmuteEl) {
        event.preventDefault();
        App.setDisturbancesHidden(false);
        return;
      }

      const toggleEl = event.target.closest("[data-disturbance-toggle]");
      if (toggleEl) {
        event.preventDefault();
        const card = toggleEl.closest(".disturbance-fallback-card");
        const list = card ? card.querySelector("[data-disturbance-list]") : null;
        if (list) list.classList.toggle("disturbance-list-collapsed");
        toggleEl.classList.toggle("open");
        return;
      }

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
      if (detailsEl) {
        const rowEl = detailsEl.previousElementSibling;
        detailsEl.innerHTML = UI.renderTrainDetails(details, state.station, { flagged: !!(rowEl && rowEl.dataset && rowEl.dataset.flagged === "1") });
        UI.refreshRowFromDetails(detailsEl, details);
      }
    },

    handleStationSearch: Utils.debounce((e) => {
      UI.renderStationSelect(e.target.value);
    }, CONFIG.DEBOUNCE_DELAY),

    // Applique la sélection d'une gare, quelle que soit sa source (clic, clavier, Entrée).
    selectStation(stationName) {
      if (!stationName) return;
      state.station = stationName;
      state.expandedVehicle = null;
      state.expandedApiDate = null;
      App.saveState();

      if (DOM.stationSearch) {
        DOM.stationSearch.value = "";
        DOM.stationSearch.setAttribute("aria-expanded", "false");
      }
      if (DOM.stationDropdown) DOM.stationDropdown.style.display = "none";
      App.init(true);
    },

    // Enter/search/change on mobile => choisit l'option surlignée au clavier,
    // ou à défaut la première option de la liste, et charge la gare.
    submitStationSearch() {
      const dropdown = DOM.stationDropdown;
      if (!dropdown || dropdown.style.display === "none") return;

      const items = state.stationDropdownItems;
      if (!items || !items.length) return;

      const chosen = state.stationDropdownActive >= 0 ? items[state.stationDropdownActive] : items[0];
      if (!chosen) return;

      Events.selectStation(chosen.standardname);
    },

    // Clic sur une ligne de la liste maison
    handleStationDropdownClick(e) {
      const opt = e.target.closest(".station-option[data-station]");
      if (!opt) return;
      Events.selectStation(opt.dataset.station);
    },

    // Navigation clavier dans la liste (flèches haut/bas, Échap pour fermer)
    handleStationSearchKeydown(e) {
      const dropdown = DOM.stationDropdown;
      const isOpen = !!dropdown && dropdown.style.display !== "none";

      if (e.key === "ArrowDown") {
        if (!isOpen) return;
        e.preventDefault();
        UI.setActiveStationOption(state.stationDropdownActive + 1);
      } else if (e.key === "ArrowUp") {
        if (!isOpen) return;
        e.preventDefault();
        UI.setActiveStationOption(state.stationDropdownActive - 1);
      } else if (e.key === "Escape") {
        if (isOpen) { dropdown.style.display = "none"; DOM.stationSearch?.setAttribute("aria-expanded", "false"); }
      } else if (e.key === "Enter") {
        e.preventDefault();
        Events.submitStationSearch();
      }
    },

    handleModeChange(mode) {
      state.mode = mode;
      state.expandedVehicle = null;
      state.expandedApiDate = null;
      App.saveState();
      App.init(true);
    },

    handleDocumentClick(e) {
      const isDropdown = DOM.stationDropdown && DOM.stationDropdown.contains(e.target);
      const isSearch = DOM.stationSearch && DOM.stationSearch.contains(e.target);
      if (!isDropdown && !isSearch && DOM.stationDropdown) {
        DOM.stationDropdown.style.display = "none";
        DOM.stationSearch?.setAttribute("aria-expanded", "false");
      }
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
        const label = DOM.locateBtn.querySelector(".btn-label");
        if (label) label.textContent = " Localisation…";
        else DOM.locateBtn.textContent = "📍 Localisation…";
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
          DOM.stationNameText.textContent = `${Utils.displayStationName(nearest.standardname)} (${best.toFixed(1)} km)`;
          setTimeout(() => { DOM.stationNameText.textContent = Utils.displayStationName(nearest.standardname); }, 3000);
        }
      } catch (err) {
        console.error("Erreur géolocalisation:", err);
        alert("Erreur lors de la géolocalisation. Veuillez réessayer.");
      } finally {
        if (DOM.locateBtn) {
          DOM.locateBtn.disabled = false;
          const label = DOM.locateBtn.querySelector(".btn-label");
          if (label) label.textContent = " Localiser";
          else DOM.locateBtn.textContent = "📍 Localiser";
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

    setDisturbancesHidden(hidden) {
      state.disturbancesHidden = hidden;
      localStorage.setItem("nt_hideDisturbances", hidden ? "1" : "0");
      UI.refreshDisturbanceZone();
    },

    setupListeners() {
      // Station search
      if (DOM.stationSearch) {
        DOM.stationSearch.addEventListener("input", Events.handleStationSearch);

        // Flèches haut/bas, Entrée, Échap — navigation clavier dans la liste maison
        DOM.stationSearch.addEventListener("keydown", Events.handleStationSearchKeydown);

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

      // Bouton loupe : déclenche la même recherche que Entrée
      if (DOM.stationSearchBtn) {
        DOM.stationSearchBtn.addEventListener("click", () => Events.submitStationSearch());
      }

      // Clic sur une ligne de la liste de gares (remplace l'ancien <select> natif)
      if (DOM.stationDropdown) {
        DOM.stationDropdown.addEventListener("click", Events.handleStationDropdownClick);
      }

      // Mode tabs
      if (DOM.tabDeparture) DOM.tabDeparture.addEventListener("click", () => Events.handleModeChange("departure"));
      if (DOM.tabArrival) DOM.tabArrival.addEventListener("click", () => Events.handleModeChange("arrival"));

      // Refresh
      if (DOM.refreshBtn) DOM.refreshBtn.addEventListener("click", () => this.init(true));

      // Train list click
      if (DOM.trainsList) DOM.trainsList.addEventListener("click", Events.handleTrainsListClick);
      if (DOM.trainsList) DOM.trainsList.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-disturbance-unmute]")) {
          e.preventDefault();
          App.setDisturbancesHidden(false);
        }
      });

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

      // Bouton loupe : déclenche la même recherche que Entrée
      if (DOM.trainSearchBtn) {
        DOM.trainSearchBtn.addEventListener("click", (e) => Events.handleTrainSearchSubmit(e));
      }

      // Chargement automatique de la suite des trains en scrollant vers le bas
      // (voir UI.loadMoreTrains — pagine sur le liveboard iRail via le paramètre "time")
      window.addEventListener(
        "scroll",
        Utils.debounce(() => {
          const remaining = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
          if (remaining < CONFIG.SCROLL_LOAD_MORE_THRESHOLD) UI.loadMoreTrains();
        }, CONFIG.SCROLL_DEBOUNCE_DELAY),
        { passive: true }
      );
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

      // Helper: run tasks with limited concurrency, en respectant la PRIORITÉ des candidats.
      // Important : on ne retourne pas le premier résultat dont la requête réseau arrive
      // en premier (ex: THA2119 qui répond plus vite qu'IC2119) — on attend que tous les
      // candidats aient répondu, puis on prend le premier valide dans l'ordre de la liste
      // (IC > IR > L > P > S > ICT > THA > EUR > EXT, voir buildVehicleIdCandidates).
      async function runWithConcurrency(items, limit, worker) {
        const results = new Array(items.length).fill(null);
        let idx = 0;

        async function runNext() {
          while (idx < items.length) {
            const my = idx++;
            const item = items[my];

            // Petit délai entre les requêtes pour ne pas surcharger l'API
            if (my > 0 && my % limit === 0) {
              await sleep(100);
            }

            try {
              const result = await worker(item, my);
              if (result) console.log(`[SEARCH] ✅ Candidat valide: ${item}`);
              results[my] = result;
            } catch (e) {
              console.log(`[SEARCH] ❌ Échec: ${item} (${e.message || 'erreur'})`);
              results[my] = null;
            }
          }
        }

        const workers = Array(Math.min(limit, items.length))
          .fill(0)
          .map(() => runNext());

        await Promise.all(workers);

        // Premier résultat valide dans l'ordre de PRIORITÉ, pas dans l'ordre d'arrivée réseau.
        const winner = results.find((r) => r) || null;
        if (winner) console.log(`[SEARCH] 🏆 Retenu (priorité la plus haute): ${winner.vehicleId}`);
        return winner;
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

        // Pas la peine d'auto-refresh pendant que l'onglet est en arrière-plan :
        // on resynchronisera immédiatement au retour (voir visibilitychange dans start()).
        if (!document.hidden) {
          state.autoRefreshHandle = setTimeout(() => this.init(), CONFIG.AUTO_REFRESH);
        }
      } catch (e) {
        console.error("Erreur init:", e);
        const msg = (e.message || "").includes("HTTP 404")
          ? `Impossible de trouver la gare <strong>${Utils.escapeHtml(Utils.displayStationName(state.station))}</strong>.`
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

      // Ticker "dans X min" — mise à jour légère indépendante du refresh réseau,
      // mise en pause quand l'onglet n'est pas visible (inutile de travailler en arrière-plan).
      let tickHandle = setInterval(() => UI.tickRelativeTimes(), CONFIG.RELATIVE_TIME_TICK);

      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          clearInterval(tickHandle);
          if (state.autoRefreshHandle) clearTimeout(state.autoRefreshHandle);
        } else {
          // Retour sur l'onglet : on resynchronise tout de suite (compteurs + données)
          // plutôt que d'attendre le prochain tick/refresh programmé.
          UI.tickRelativeTimes();
          tickHandle = setInterval(() => UI.tickRelativeTimes(), CONFIG.RELATIVE_TIME_TICK);
          if (!state.isFetching) this.init(true);
        }
      });
    }
  };

  // ---------- START ----------
  App.start();
})();