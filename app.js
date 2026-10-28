/* Playlist Master – Single-Page-App für Spotify (PKCE, kein Server nötig)
 * Funktionen v1:
 *  - Läuft gerade: aktueller Song + Kick-Button (aus Playlist entfernen, überspringen, Blacklist)
 *  - Playlists: Studio-Discografien je Kategorie in eigene Playlists schreiben
 *  - Blacklist: gekickte Songs verwalten, Export/Import
 * Vorbereitet für später (Cloudflare Worker): Neuerscheinungen, Vorschläge, Konzerte NRW.
 */
(() => {
  "use strict";

  const CFG = window.PM_CONFIG;
  const API = "https://api.spotify.com/v1";
  const SCOPES = [
    "user-read-currently-playing",
    "user-read-playback-state",
    "user-modify-playback-state",
    "playlist-read-private",
    "playlist-modify-private",
    "playlist-modify-public",
  ].join(" ");

  // Redirect-URI = diese Seite ohne Query/Hash und ohne index.html
  const REDIRECT_URI = (location.origin + location.pathname).replace(/index\.html$/, "");

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem("pm_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("pm_" + k, JSON.stringify(v)); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem("pm_" + k); } catch { /* ignore */ } },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- Auth (PKCE)
  function b64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randomString(len = 64) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const arr = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(arr, (x) => chars[x % chars.length]).join("");
  }

  async function login() {
    const verifier = randomString(64);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    sessionStorage.setItem("pm_verifier", verifier);
    const params = new URLSearchParams({
      client_id: CFG.clientId,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      code_challenge_method: "S256",
      code_challenge: challenge,
      scope: SCOPES,
    });
    location.href = "https://accounts.spotify.com/authorize?" + params;
  }

  async function tokenRequest(body) {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CFG.clientId, ...body }),
    });
    if (!res.ok) throw new Error("Token-Fehler " + res.status + ": " + (await res.text()));
    const t = await res.json();
    const prev = store.get("token", {});
    store.set("token", {
      access: t.access_token,
      refresh: t.refresh_token || prev.refresh,
      expires: Date.now() + (t.expires_in - 60) * 1000,
    });
  }

  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (q.get("error")) { alert("Spotify-Login abgebrochen: " + q.get("error")); }
    const code = q.get("code");
    if (!code) return;
    const verifier = sessionStorage.getItem("pm_verifier");
    history.replaceState(null, "", REDIRECT_URI);
    if (!verifier) return;
    await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
    sessionStorage.removeItem("pm_verifier");
  }

  async function accessToken() {
    const t = store.get("token");
    if (!t) return null;
    if (Date.now() < t.expires) return t.access;
    if (!t.refresh) return null;
    await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh });
    return store.get("token").access;
  }

  function logout() { store.del("token"); location.reload(); }

  // ---------------------------------------------------------------- API helper
  async function api(path, { method = "GET", body, raw = false } = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = await accessToken();
      if (!token) throw new Error("Nicht angemeldet");
      const res = await fetch(path.startsWith("http") ? path : API + path, {
        method,
        headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429) {
        const wait = (parseInt(res.headers.get("Retry-After") || "2", 10) + 1) * 1000;
        await sleep(wait);
        continue;
      }
      if (res.status === 401 && attempt === 0) {
        const t = store.get("token"); if (t) { t.expires = 0; store.set("token", t); }
        continue;
      }
      if (raw) return res;
      if (res.status === 204) return null;
      const text = await res.text();
      // Manche Player-Endpunkte antworten mit leerem Body oder reinem Text statt JSON
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = text; } }
      if (!res.ok) {
        const err = new Error((data && data.error && data.error.message) || ("HTTP " + res.status));
        err.status = res.status;
        throw err;
      }
      return data;
    }
    throw new Error("Zu viele Anfragen – bitte später erneut versuchen");
  }

  // Alle Seiten einer Liste holen; fällt bei 400 auf kleinere Seitengrößen zurück
  async function getAll(path, limit = 50) {
    const sep = path.includes("?") ? "&" : "?";
    let url = `${path}${sep}limit=${limit}`;
    const out = [];
    try {
      while (url) {
        const page = await api(url);
        const container = page.items ? page : (page.tracks || page.albums || page);
        out.push(...(container.items || []));
        url = container.next;
      }
    } catch (e) {
      if (e.status === 400 && limit > 10) return getAll(path, 10);
      throw e;
    }
    return out;
  }

  // Playlist-Einträge: neues Format (item) und altes Format (track) unterstützen
  const entryTrack = (e) => (e && (typeof e.item === "object" ? e.item : null)) || (e && typeof e.track === "object" ? e.track : null);

  // ---------------------------------------------------------------- Blacklist
  const blacklist = {
    all() { return store.get("blacklist", {}); },
    has(uri) { return !!this.all()[uri]; },
    add(uri, info) { const b = this.all(); b[uri] = { ...info, date: new Date().toISOString() }; store.set("blacklist", b); },
    remove(uri) { const b = this.all(); delete b[uri]; store.set("blacklist", b); },
  };

  // ---------------------------------------------------------------- Läuft gerade
  let current = null;
  let pollTimer = null;
  const playlistNames = {};

  async function playlistName(id) {
    if (playlistNames[id]) return playlistNames[id];
    try { const p = await api(`/playlists/${id}?fields=name`); playlistNames[id] = p.name; } catch { playlistNames[id] = "Playlist"; }
    return playlistNames[id];
  }

  async function refreshNow() {
    try {
      const res = await api("/me/player/currently-playing", { raw: true });
      if (res.status === 204 || !res.ok) { renderNow(null); return; }
      const data = await res.json();
      if (!data || !data.item || data.currently_playing_type !== "track") { renderNow(null); return; }
      const ctx = data.context && data.context.type === "playlist" ? data.context.uri.split(":").pop() : null;
      current = {
        uri: data.item.uri,
        name: data.item.name,
        artists: data.item.artists.map((a) => a.name).join(", "),
        album: data.item.album ? data.item.album.name : "",
        cover: data.item.album && data.item.album.images && data.item.album.images[0] ? data.item.album.images[0].url : "",
        playlistId: ctx,
        playlistName: ctx ? await playlistName(ctx) : null,
        contextType: data.context ? data.context.type : null,
      };
      renderNow(current);
    } catch (e) {
      if (e.message === "Nicht angemeldet") return showLogin();
      toast("Fehler: " + e.message, true);
    }
  }

  function renderNow(c) {
    current = c;
    $("kickBtn").disabled = !c;
    $("skipBtn").disabled = !c;
    if (!c) {
      $("npTitle").textContent = "Nichts läuft gerade";
      $("npArtist").textContent = $("npAlbum").textContent = $("npContext").textContent = "";
      $("npCover").hidden = true;
      return;
    }
    $("npTitle").textContent = c.name;
    $("npArtist").textContent = c.artists;
    $("npAlbum").textContent = c.album;
    $("npContext").textContent = c.playlistId ? "aus Playlist: " + c.playlistName : (c.contextType ? "aus " + c.contextType : "");
    if (c.cover) { $("npCover").src = c.cover; $("npCover").hidden = false; } else { $("npCover").hidden = true; }
  }

  async function removeFromPlaylist(playlistId, uri) {
    try {
      await api(`/playlists/${playlistId}/items`, { method: "DELETE", body: { items: [{ uri }] } });
    } catch (e) {
      if (e.status !== 400 && e.status !== 404) throw e;
      await api(`/playlists/${playlistId}/tracks`, { method: "DELETE", body: { tracks: [{ uri }] } });
    }
  }

  async function kick() {
    if (!current) return;
    const c = current;
    $("kickBtn").disabled = true;
    try {
      blacklist.add(c.uri, { name: c.name, artists: c.artists, album: c.album });
      pushBlacklistAdd(c.uri);
      let msg = "";
      if (c.playlistId) {
        try { await removeFromPlaylist(c.playlistId, c.uri); msg = `„${c.name}“ aus ${c.playlistName} entfernt`; }
        catch (e) { msg = `Nicht entfernt (${e.message}) – aber auf der Blacklist`; }
      } else {
        msg = `„${c.name}“ auf der Blacklist (läuft nicht aus einer Playlist)`;
      }
      try { await api("/me/player/next", { method: "POST" }); } catch { /* ignore */ }
      toast(msg);
      await sleep(800);
      refreshNow();
      renderBlacklist();
    } finally {
      $("kickBtn").disabled = !current;
    }
  }

  async function skip() {
    try { await api("/me/player/next", { method: "POST" }); await sleep(800); refreshNow(); }
    catch (e) { toast("Fehler: " + e.message, true); }
  }

  let toastTimer;
  function toast(text, isError = false) {
    const t = $("toast");
    t.textContent = text;
    t.className = "toast" + (isError ? " error" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  function startPolling() {
    stopPolling();
    refreshNow();
    pollTimer = setInterval(() => { if (!document.hidden) refreshNow(); }, 5000);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  // ---------------------------------------------------------------- Studio-Discografie
  const EXCLUDE_ALBUM = /\b(live|unplugged|mtv|acoustic|akustik|demos?|remix(es)?|instrumentals?|karaoke|commentary|sessions?|b-sides|rarities|greatest hits|best of|anthology|collection|essentials|hits|tour edition|in concert|bootleg)\b/i;
  const EDITION = /\s*[([{-].*?(deluxe|remaster(ed)?|expanded|edition|anniversary|bonus|special|version|re-?issue|super|collector|legacy|reloaded).*?([)\]}]|$)/gi;
  const EXCLUDE_TRACK = /\b(live|demo|instrumental|remix|acoustic version|radio edit|commentary|karaoke)\b/i;

  const baseName = (s) => s.replace(EDITION, "").replace(/\s+/g, " ").trim().toLowerCase();
  const hasEdition = (s) => { EDITION.lastIndex = 0; return EDITION.test(s); };

  async function findArtist(name) {
    const q = encodeURIComponent(name);
    const res = await api(`/search?type=artist&limit=10&q=${q}`);
    const items = (res.artists && res.artists.items) || [];
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9äöüß]/g, "");
    return items.find((a) => norm(a.name) === norm(name)) || items[0] || null;
  }

  async function studioAlbums(artistId) {
    const albums = await getAll(`/artists/${artistId}/albums?include_groups=album`, 10);
    const groups = new Map();
    for (const al of albums) {
      if (EXCLUDE_ALBUM.test(al.name)) continue;
      const key = baseName(al.name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(al);
    }
    // je Album eine Version: ohne Edition-Zusatz bevorzugt, sonst die mit den wenigsten Songs
    const chosen = [];
    for (const list of groups.values()) {
      list.sort((a, b) => (hasEdition(a.name) - hasEdition(b.name)) || (a.total_tracks - b.total_tracks));
      chosen.push(list[0]);
    }
    chosen.sort((a, b) => (a.release_date || "").localeCompare(b.release_date || ""));
    return chosen;
  }

  async function artistTrackUris(artistId, log) {
    const albums = await studioAlbums(artistId);
    const uris = [];
    const seenNames = new Set();
    for (const al of albums) {
      const tracks = await getAll(`/albums/${al.id}/tracks`, 50);
      let n = 0;
      for (const t of tracks) {
        if (EXCLUDE_TRACK.test(t.name)) continue;
        const key = t.name.replace(/\s*[-(].*$/, "").trim().toLowerCase();
        if (seenNames.has(key)) continue;
        seenNames.add(key);
        if (blacklist.has(t.uri)) continue;
        uris.push(t.uri);
        n++;
      }
      log(`    ${al.release_date ? al.release_date.slice(0, 4) : "????"}  ${al.name} (${n})`);
    }
    return uris;
  }

  async function findPlaylist(name) {
    const mine = await getAll("/me/playlists", 50);
    const found = mine.find((p) => p.name === name);
    return found ? found.id : null;
  }

  async function findOrCreatePlaylist(name) {
    const id = await findPlaylist(name);
    if (id) return id;
    const p = await api("/me/playlists", {
      method: "POST",
      body: { name, public: false, description: "Erstellt mit Playlist Master – nur Studioalben" },
    });
    return p.id;
  }

  async function playlistTracks(id) {
    const entries = await getAll(`/playlists/${id}/items`, 50).catch(() => getAll(`/playlists/${id}/tracks`, 50));
    return entries.map(entryTrack).filter(Boolean);
  }

  async function addToPlaylist(id, uris, onProgress) {
    let batch = 100;
    let i = 0;
    while (i < uris.length) {
      const chunk = uris.slice(i, i + batch);
      try {
        await api(`/playlists/${id}/items`, { method: "POST", body: { uris: chunk } });
        i += chunk.length;
        onProgress(i);
      } catch (e) {
        if (e.status === 400 && batch > 10) { batch = 10; continue; }
        throw e;
      }
    }
  }

  async function removeManyFromPlaylist(id, uris, onProgress) {
    let batch = 100;
    let i = 0;
    while (i < uris.length) {
      const chunk = uris.slice(i, i + batch);
      try {
        await api(`/playlists/${id}/items`, { method: "DELETE", body: { items: chunk.map((uri) => ({ uri })) } });
        i += chunk.length;
        onProgress(i);
      } catch (e) {
        if (e.status === 400 && batch > 10) { batch = 10; continue; }
        throw e;
      }
    }
  }

  // ---------------------------------------------------------------- Kategorien & Künstlerliste
  const sortDe = (arr) => arr.sort((a, b) => a.localeCompare(b, "de", { sensitivity: "base" }));
  const sameName = (a, b) => a.localeCompare(b, "de", { sensitivity: "base" }) === 0;

  function categories() { return store.get("categories", CFG.categories); }
  function saveCategories(c) { store.set("categories", c); pushCategories(); }
  function loadedMap() { return store.get("loaded", {}); }
  function isLoaded(cat, name) { return (loadedMap()[cat] || []).some((n) => sameName(n, name)); }
  function setLoaded(cat, name, on) {
    const m = loadedMap();
    const list = (m[cat] || []).filter((n) => !sameName(n, name));
    if (on) list.push(name);
    m[cat] = list;
    store.set("loaded", m);
  }

  let selectedArtist = null;
  let busy = false;
  const currentCat = () => $("catSelect").value;

  function initBuilder() {
    const sel = $("catSelect");
    sel.innerHTML = "";
    Object.keys(categories()).forEach((c) => { const o = document.createElement("option"); o.value = o.textContent = c; sel.appendChild(o); });
    sel.onchange = () => { selectedArtist = null; renderArtists(); };
    renderArtists();
  }

  function renderArtists() {
    const cat = currentCat();
    const names = sortDe([...(categories()[cat] || [])]);
    const ul = $("artistUl");
    ul.innerHTML = "";
    for (const name of names) {
      const li = document.createElement("li");
      li.textContent = name;
      if (!isLoaded(cat, name)) {
        const tag = document.createElement("small");
        tag.textContent = "noch nicht geladen";
        li.appendChild(tag);
      }
      if (selectedArtist && sameName(selectedArtist, name)) li.classList.add("selected");
      li.onclick = () => {
        selectedArtist = selectedArtist && sameName(selectedArtist, name) ? null : name;
        renderArtists();
      };
      ul.appendChild(li);
    }
    const btn = $("removeArtistBtn");
    btn.disabled = !selectedArtist || busy;
    btn.textContent = selectedArtist ? `„${selectedArtist}“ aus Playlist entfernen` : "Künstler aus Playlist entfernen";
    const missing = names.filter((n) => !isLoaded(cat, n));
    const lm = $("loadMissingBtn");
    lm.hidden = missing.length === 0;
    lm.disabled = busy;
    lm.textContent = `${missing.length} noch nicht geladene Künstler jetzt laden`;
  }

  function setBusy(on) {
    busy = on;
    $("addArtistBtn").disabled = on;
    renderArtists();
  }

  function logger() {
    const logEl = $("buildLog");
    logEl.textContent = "";
    $("progressBar").style.width = "0%";
    return (s) => { logEl.textContent += s + "\n"; logEl.scrollTop = logEl.scrollHeight; };
  }

  // Studioalben der angegebenen Künstler in die Kategorie-Playlist laden
  async function loadArtists(cat, names) {
    if (busy || !names.length) return;
    setBusy(true);
    const log = logger();
    const bar = $("progressBar");
    try {
      const plName = CFG.playlistPrefix + cat;
      log(`Playlist „${plName}“ wird vorbereitet …`);
      const plId = await findOrCreatePlaylist(plName);
      const existing = new Set((await playlistTracks(plId)).map((t) => t.uri));
      log(`${existing.size} Songs bereits in der Playlist.\n`);

      const all = [];
      const ok = [];
      for (let k = 0; k < names.length; k++) {
        const name = names[k];
        try {
          const a = await findArtist(name);
          if (!a) { log(`✗ ${name}: nicht gefunden`); continue; }
          log(`● ${name}${!sameName(a.name, name) ? " → " + a.name : ""}`);
          const uris = await artistTrackUris(a.id, log);
          const fresh = uris.filter((u) => !existing.has(u));
          fresh.forEach((u) => existing.add(u));
          all.push(...fresh);
          ok.push(name);
          log(`  ${uris.length} Songs, davon ${fresh.length} neu`);
        } catch (e) {
          log(`✗ ${name}: ${e.message}`);
        }
        bar.style.width = Math.round(((k + 1) / names.length) * 50) + "%";
      }

      if (existing.size > 10000) log(`\n⚠ Über 10.000 Songs – Spotify erlaubt max. ca. 10.000 pro Playlist.`);
      log(`\nFüge ${all.length} neue Songs hinzu …`);
      await addToPlaylist(plId, all, (n) => { bar.style.width = (50 + Math.round((n / Math.max(all.length, 1)) * 50)) + "%"; });
      ok.forEach((n) => setLoaded(cat, n, true));
      bar.style.width = "100%";
      log(`✓ Fertig. „${plName}“ enthält jetzt ca. ${existing.size} Songs.`);
      toast(`${all.length} Songs hinzugefügt`);
    } catch (e) {
      log("Fehler: " + e.message);
      toast("Fehler: " + e.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function addArtist() {
    const input = $("artistInput");
    const name = input.value.trim().replace(/\s+/g, " ");
    if (!name) return;
    const cat = currentCat();
    const cats = categories();
    const list = cats[cat] || [];
    if (list.some((n) => sameName(n, name))) {
      toast(`„${name}“ steht schon in ${cat}`);
      return;
    }
    cats[cat] = sortDe([...list, name]);
    saveCategories(cats);
    input.value = "";
    selectedArtist = null;
    renderArtists();
    await loadArtists(cat, [name]);
  }

  async function removeArtist() {
    if (!selectedArtist || busy) return;
    const cat = currentCat();
    const name = selectedArtist;
    const plName = CFG.playlistPrefix + cat;
    if (!confirm(`„${name}“ aus der Liste ${cat} streichen und alle Songs aus „${plName}“ entfernen?`)) return;
    setBusy(true);
    const log = logger();
    const bar = $("progressBar");
    try {
      const plId = await findPlaylist(plName);
      let removed = 0;
      if (plId) {
        const a = await findArtist(name);
        const tracks = await playlistTracks(plId);
        const uris = [...new Set(tracks
          .filter((t) => (t.artists || []).some((x) => (a && x.id === a.id) || sameName(x.name, name)))
          .map((t) => t.uri))];
        log(`Entferne ${uris.length} Songs von ${name} …`);
        await removeManyFromPlaylist(plId, uris, (n) => { bar.style.width = Math.round((n / Math.max(uris.length, 1)) * 100) + "%"; });
        removed = uris.length;
      }
      const cats = categories();
      cats[cat] = (cats[cat] || []).filter((n) => !sameName(n, name));
      saveCategories(cats);
      setLoaded(cat, name, false);
      selectedArtist = null;
      bar.style.width = "100%";
      log(`✓ ${name} entfernt (${removed} Songs).`);
      toast(`${name} entfernt (${removed} Songs)`);
    } catch (e) {
      log("Fehler: " + e.message);
      toast("Fehler: " + e.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function loadMissing() {
    const cat = currentCat();
    const missing = sortDe([...(categories()[cat] || [])]).filter((n) => !isLoaded(cat, n));
    if (!missing.length) return;
    if (!confirm(`${missing.length} Künstler in ${cat} laden? Das kann einige Minuten dauern.`)) return;
    await loadArtists(cat, missing);
  }

  // ---------------------------------------------------------------- Blacklist-Ansicht
  function renderBlacklist() {
    const ul = $("blackList");
    ul.innerHTML = "";
    const entries = Object.entries(blacklist.all()).sort((a, b) => (b[1].date || "").localeCompare(a[1].date || ""));
    if (!entries.length) { ul.innerHTML = "<li class='empty'>Noch nichts gekickt.</li>"; return; }
    for (const [uri, info] of entries) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.innerHTML = `<strong></strong><br><small></small>`;
      span.querySelector("strong").textContent = info.name || uri;
      span.querySelector("small").textContent = info.artists || "";
      const btn = document.createElement("button");
      btn.className = "ghost small";
      btn.textContent = "Zurückholen";
      btn.onclick = () => { blacklist.remove(uri); pushBlacklistRemove(uri); renderBlacklist(); };
      li.append(span, btn);
      ul.appendChild(li);
    }
  }
  // ---------------------------------------------------------------- Worker-Anbindung
  function workerCfg() { return store.get("worker", null); }
  function parseWorkerLink(link) {
    try {
      const u = new URL(link.trim());
      const key = u.searchParams.get("key");
      if (!key || !/workers\.dev$/.test(u.hostname)) return null;
      return { base: u.origin, key };
    } catch { return null; }
  }
  async function wapi(path, { method = "GET", body } = {}) {
    const w = workerCfg();
    if (!w) throw new Error("Worker nicht verbunden");
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${w.base}${path}${sep}key=${encodeURIComponent(w.key)}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || "Worker " + res.status);
    try { return JSON.parse(text); } catch { return text; }
  }

  // Künstlerlisten + Blacklist mit dem Worker abgleichen
  async function syncWorker() {
    if (!workerCfg()) return;
    try {
      await wapi("/artists", { method: "POST", body: categories() });
      const remote = await wapi("/blacklist");
      const local = blacklist.all();
      const localOnly = Object.fromEntries(Object.entries(local).filter(([u]) => !remote[u]));
      store.set("blacklist", { ...remote, ...local });
      if (Object.keys(localOnly).length) await wapi("/blacklist", { method: "POST", body: localOnly });
      renderBlacklist();
    } catch (e) { console.warn("Sync", e); }
  }
  function pushBlacklistAdd(uri) { if (workerCfg()) wapi("/blacklist", { method: "POST", body: { [uri]: blacklist.all()[uri] } }).catch(() => {}); }
  function pushBlacklistRemove(uri) { if (workerCfg()) wapi("/blacklist?uri=" + encodeURIComponent(uri), { method: "DELETE" }).catch(() => {}); }
  function pushCategories() { if (workerCfg()) wapi("/artists", { method: "POST", body: categories() }).catch(() => {}); }

  // ---------------------------------------------------------------- Konzerte
  const fmtDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
  const fmtMonth = (d) => new Date(d + "T12:00:00").toLocaleDateString("de-DE", { month: "long", year: "numeric" });

  function initLive() {
    const has = !!workerCfg();
    $("workerSetup").hidden = has;
    $("liveView").hidden = !has;
    if (has) { loadConcerts(); eventimScan(); }
  }

  async function saveWorker() {
    const cfg = parseWorkerLink($("workerInput").value);
    if (!cfg) { toast("Das sieht nicht nach deinem Kick-Link aus", true); return; }
    store.set("worker", cfg);
    try { await wapi("/concerts"); } catch (e) { store.del("worker"); toast("Verbindung fehlgeschlagen: " + e.message, true); return; }
    $("workerInput").value = "";
    toast("Mit Worker verbunden");
    await syncWorker();
    initLive();
  }

  async function loadConcerts() {
    const list = $("liveList");
    try {
      const data = await wapi("/concerts");
      renderConcerts(data.concerts || []);
      const s = data.status;
      $("liveStatus").textContent = s
        ? `Ticketmaster zuletzt: ${new Date(s.at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })} (läuft automatisch alle 30 Min.)`
        : "Ticketmaster: noch keine Prüfung gelaufen.";
    } catch (e) {
      list.innerHTML = "";
      $("liveStatus").textContent = "Fehler: " + e.message;
    }
  }

  function renderConcerts(items) {
    const list = $("liveList");
    list.innerHTML = "";
    if (!items.length) { list.innerHTML = "<p class='hint'>Noch keine Konzerte in NRW gefunden.</p>"; return; }
    const weekAgo = Date.now() - 7 * 864e5;
    let month = "";
    let card = null;
    for (const c of items) {
      const m = fmtMonth(c.date);
      if (m !== month) {
        month = m;
        const h = document.createElement("h3"); h.className = "month"; h.textContent = m; list.appendChild(h);
        card = document.createElement("div"); card.className = "card concerts"; list.appendChild(card);
      }
      const row = document.createElement("div");
      row.className = "concert";
      const isNew = new Date(c.firstSeen).getTime() > weekAgo;
      const price = c.price != null ? `ab ${c.price.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : "Preis k. A.";
      row.innerHTML = `<div class="c-date"></div><div class="c-main"><div class="c-band"></div><div class="c-where"></div><div class="c-meta"></div></div>`;
      row.querySelector(".c-date").textContent = fmtDate(c.date) + (c.time ? `\n${c.time} Uhr` : "");
      row.querySelector(".c-band").textContent = c.artist + (isNew ? "  · NEU" : "");
      if (isNew) row.classList.add("new");
      row.querySelector(".c-where").textContent = c.venue ? `${c.venue}, ${c.city}` : c.city;
      const meta = row.querySelector(".c-meta");
      meta.textContent = price;
      for (const [src, label] of [["eventim", "Eventim"], ["ticketmaster", "Ticketmaster"]]) {
        if (!c.links || !c.links[src]) continue;
        const a = document.createElement("a");
        a.href = c.links[src]; a.target = "_blank"; a.rel = "noopener"; a.textContent = label;
        meta.append(" · ", a);
      }
      card.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- Eventim-Abfrage (läuft im Browser, weil
  // Eventim Server-Anfragen von Cloudflare blockt; Ergebnisse gehen an den Worker)
  async function eventimSearch(artist) {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const params = new URLSearchParams({ webId: "web__eventim-de", language: "de", page: String(page), search_term: artist, categories: "Konzerte" });
      const res = await fetch("https://public-api.eventim.com/websearch/search/api/exploration/v1/products?" + params);
      if (!res.ok) throw new Error("Eventim " + res.status);
      const data = await res.json();
      for (const p of data.products || []) {
        const le = p.typeAttributes && p.typeAttributes.liveEntertainment;
        if (!le || !le.location) continue;
        out.push({
          name: p.name || "",
          attractions: (p.attractions || []).map((a) => a.name),
          categories: (p.categories || []).map((c) => c.name),
          start: le.startDate || "",
          venue: le.location.name || "",
          city: le.location.city || "",
          plz: le.location.postalCode || "",
          price: typeof p.price === "number" ? p.price : null,
          currency: p.currency || "EUR",
          url: p.link || (p.url ? p.url.domain + p.url.path : ""),
        });
      }
      if (!data.totalPages || page >= data.totalPages) break;
    }
    return out;
  }

  let eventimRunning = false;
  async function eventimScan(force = false) {
    if (eventimRunning || !workerCfg()) return;
    const last = store.get("eventimScan", 0);
    if (!force && Date.now() - last < 20 * 3600 * 1000) return;
    eventimRunning = true;
    const names = [...new Set(Object.values(categories()).flat())].sort((a, b) => a.localeCompare(b, "de"));
    const status = (t) => { const el = $("eventimStatus"); if (el) el.textContent = t; };
    let done = 0, failed = 0, pending = {};
    const flush = async () => {
      if (!Object.keys(pending).length) return;
      const body = { source: "eventim", results: pending };
      pending = {};
      await wapi("/concerts/import", { method: "POST", body });
    };
    try {
      const queue = [...names];
      const worker = async () => {
        while (queue.length) {
          const name = queue.shift();
          try { pending[name] = await eventimSearch(name); } catch { failed++; }
          done++;
          status(`Eventim: ${done}/${names.length} Künstler geprüft …`);
          if (Object.keys(pending).length >= 15) await flush();
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      await flush();
      store.set("eventimScan", Date.now());
      status(`Eventim zuletzt durchsucht: ${new Date().toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}` + (failed ? ` (${failed} Fehler)` : ""));
      if (!$("tab-live").hidden) loadConcerts();
    } catch (e) {
      status("Eventim-Suche fehlgeschlagen: " + e.message);
    } finally {
      eventimRunning = false;
    }
  }

  async function refreshConcerts() {
    const b = $("liveRefreshBtn");
    b.disabled = true; b.textContent = "Aktualisiere …";
    try {
      await wapi("/concerts/refresh?n=10").catch(() => {});
      await eventimScan(true);
      await loadConcerts();
    } catch (e) { toast("Fehler: " + e.message, true); }
    finally { b.disabled = false; b.textContent = "Jetzt aktualisieren"; }
  }

  // ---------------------------------------------------------------- UI
  function showLogin() { stopPolling(); $("loginView").hidden = false; $("appView").hidden = true; $("logoutBtn").hidden = true; }
  function showApp() {
    $("loginView").hidden = true; $("appView").hidden = false; $("logoutBtn").hidden = false;
    initBuilder(); renderBlacklist(); startPolling(); syncWorker().then(() => eventimScan());
  }

  function initTabs() {
    document.querySelectorAll(".tabs button").forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
        ["now", "build", "live", "black"].forEach((t) => { $("tab-" + t).hidden = t !== b.dataset.tab; });
        if (b.dataset.tab === "now") startPolling(); else stopPolling();
        if (b.dataset.tab === "live") initLive();
      };
    });
  }

  async function main() {
    $("loginBtn").onclick = login;
    $("logoutBtn").onclick = logout;
    $("kickBtn").onclick = kick;
    $("skipBtn").onclick = skip;
    $("refreshBtn").onclick = refreshNow;
    $("addArtistBtn").onclick = addArtist;
    $("artistInput").onkeydown = (e) => { if (e.key === "Enter") addArtist(); };
    $("removeArtistBtn").onclick = removeArtist;
    $("loadMissingBtn").onclick = loadMissing;
    $("workerSaveBtn").onclick = saveWorker;
    $("liveRefreshBtn").onclick = refreshConcerts;
    initTabs();

    try { await handleRedirect(); } catch (e) { alert(e.message); }
    let token = null;
    try { token = await accessToken(); } catch { token = null; }
    if (token) showApp(); else showLogin();
  }

  main();
})();
