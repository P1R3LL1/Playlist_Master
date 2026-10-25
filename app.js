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

  async function findOrCreatePlaylist(name) {
    const mine = await getAll("/me/playlists", 50);
    const found = mine.find((p) => p.name === name);
    if (found) return found.id;
    const p = await api("/me/playlists", {
      method: "POST",
      body: { name, public: false, description: "Erstellt mit Playlist Master – nur Studioalben" },
    });
    return p.id;
  }

  async function playlistUris(id) {
    const entries = await getAll(`/playlists/${id}/items`, 50).catch(() => getAll(`/playlists/${id}/tracks`, 50));
    return new Set(entries.map(entryTrack).filter(Boolean).map((t) => t.uri));
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

  let building = false;
  async function buildPlaylist() {
    if (building) return;
    building = true;
    $("buildBtn").disabled = true;
    const logEl = $("buildLog");
    logEl.textContent = "";
    const log = (s) => { logEl.textContent += s + "\n"; logEl.scrollTop = logEl.scrollHeight; };
    const bar = $("progressBar");
    bar.style.width = "0%";
    try {
      const cat = $("catSelect").value;
      const artists = $("artistList").value.split("\n").map((s) => s.trim()).filter(Boolean);
      const plName = CFG.playlistPrefix + cat;
      log(`Playlist „${plName}“ wird vorbereitet …`);
      const plId = await findOrCreatePlaylist(plName);
      const existing = await playlistUris(plId);
      log(`${existing.size} Songs bereits in der Playlist.\n`);

      const all = [];
      for (let k = 0; k < artists.length; k++) {
        const name = artists[k];
        try {
          const a = await findArtist(name);
          if (!a) { log(`✗ ${name}: nicht gefunden`); continue; }
          log(`● ${name}${a.name !== name ? " → " + a.name : ""}`);
          const uris = await artistTrackUris(a.id, log);
          const fresh = uris.filter((u) => !existing.has(u));
          fresh.forEach((u) => existing.add(u));
          all.push(...fresh);
          log(`  ${uris.length} Songs, davon ${fresh.length} neu`);
        } catch (e) {
          log(`✗ ${name}: ${e.message}`);
        }
        bar.style.width = Math.round(((k + 1) / artists.length) * 50) + "%";
      }

      if (existing.size > 10000) log(`\n⚠ Über 10.000 Songs – Spotify erlaubt max. ca. 10.000 pro Playlist. Liste besser aufteilen.`);
      log(`\nFüge ${all.length} neue Songs hinzu …`);
      await addToPlaylist(plId, all, (n) => { bar.style.width = (50 + Math.round((n / Math.max(all.length, 1)) * 50)) + "%"; });
      bar.style.width = "100%";
      log(`✓ Fertig. „${plName}“ enthält jetzt ca. ${existing.size} Songs.`);
    } catch (e) {
      log("Fehler: " + e.message);
    } finally {
      building = false;
      $("buildBtn").disabled = false;
    }
  }

  // ---------------------------------------------------------------- Kategorien
  function categories() { return store.get("categories", CFG.categories); }
  function initBuilder() {
    const sel = $("catSelect");
    sel.innerHTML = "";
    Object.keys(categories()).forEach((c) => { const o = document.createElement("option"); o.value = o.textContent = c; sel.appendChild(o); });
    const show = () => { $("artistList").value = (categories()[sel.value] || []).join("\n"); };
    sel.onchange = show;
    show();
  }
  function saveArtists() {
    const cats = categories();
    cats[$("catSelect").value] = $("artistList").value.split("\n").map((s) => s.trim()).filter(Boolean);
    store.set("categories", cats);
    toast("Liste gespeichert");
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
      btn.onclick = () => { blacklist.remove(uri); renderBlacklist(); };
      li.append(span, btn);
      ul.appendChild(li);
    }
  }
  function exportBlacklist() {
    const blob = new Blob([JSON.stringify(blacklist.all(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "playlist-master-blacklist.json";
    a.click();
  }
  async function importBlacklist(file) {
    const data = JSON.parse(await file.text());
    store.set("blacklist", { ...blacklist.all(), ...data });
    renderBlacklist();
    toast("Blacklist importiert");
  }

  // ---------------------------------------------------------------- UI
  function showLogin() { stopPolling(); $("loginView").hidden = false; $("appView").hidden = true; $("logoutBtn").hidden = true; }
  function showApp() {
    $("loginView").hidden = true; $("appView").hidden = false; $("logoutBtn").hidden = false;
    initBuilder(); renderBlacklist(); startPolling();
  }

  function initTabs() {
    document.querySelectorAll(".tabs button").forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
        ["now", "build", "black"].forEach((t) => { $("tab-" + t).hidden = t !== b.dataset.tab; });
        if (b.dataset.tab === "now") startPolling(); else stopPolling();
      };
    });
  }

  async function main() {
    $("loginBtn").onclick = login;
    $("logoutBtn").onclick = logout;
    $("kickBtn").onclick = kick;
    $("skipBtn").onclick = skip;
    $("refreshBtn").onclick = refreshNow;
    $("buildBtn").onclick = buildPlaylist;
    $("saveArtistsBtn").onclick = saveArtists;
    $("exportBtn").onclick = exportBlacklist;
    $("importInput").onchange = (e) => e.target.files[0] && importBlacklist(e.target.files[0]);
    initTabs();

    try { await handleRedirect(); } catch (e) { alert(e.message); }
    let token = null;
    try { token = await accessToken(); } catch { token = null; }
    if (token) showApp(); else showLogin();
  }

  main();
})();
