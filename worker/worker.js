/**
 * Playlist Master – Cloudflare Worker
 *
 * Bindings (im Cloudflare-Dashboard unter Settings → Bindings / Variables):
 *   PM          KV-Namespace (Pflicht)
 *   CLIENT_ID   Variable: Spotify Client ID
 *
 * Endpunkte:
 *   GET  /                Status
 *   GET  /login           Spotify-Login für den Worker (eigenes Token, unabhängig von der Web-App)
 *   GET  /callback        Spotify-Rückleitung; zeigt danach den persönlichen Kick-Link
 *   GET|POST /kick?key=…  aktuellen Song aus der laufenden Playlist entfernen, überspringen, Blacklist
 *   GET  /blacklist?key=… Blacklist als JSON
 *   POST /blacklist?key=… Einträge zusammenführen (Body: { "<uri>": {name, artists, …} })
 *   POST /artists?key=…   Künstlerlisten der App speichern (Body: { "<Kategorie>": ["Band", …] })
 *   GET  /concerts?key=…  Konzerte in NRW (sortiert nach Datum)
 *   GET  /concerts/refresh?key=…  nächsten Schwung Künstler sofort prüfen (Ticketmaster)
 *   POST /concerts/import?key=…   Eventim-Ergebnisse aus der App übernehmen
 *
 * Secret TM_KEY: Ticketmaster Consumer Key. Cron (z. B. alle 30 Min.) prüft je 8 Künstler.
 */

import { runBatch, allArtists, importResults } from "./concerts.js";

const API = "https://api.spotify.com/v1";
const SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
  "playlist-read-private",
  "playlist-modify-private",
  "playlist-modify-public",
].join(" ");

const ALLOWED_ORIGINS = ["https://p1r3ll1.github.io", "http://127.0.0.1:8888"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      switch (url.pathname) {
        case "/":
          return status(env);
        case "/login":
          return login(url, env);
        case "/callback":
          return callback(url, env);
        case "/kick":
          await requireKey(url, env);
          return text(await kick(env), 200, cors);
        case "/blacklist":
          await requireKey(url, env);
          if (request.method === "DELETE") {
            const bl = await getJSON(env, "blacklist", {});
            delete bl[url.searchParams.get("uri")];
            await env.PM.put("blacklist", JSON.stringify(bl));
            return json({ ok: true, count: Object.keys(bl).length }, 200, cors);
          }
          if (request.method === "POST") {
            const incoming = await request.json();
            const merged = { ...(await getJSON(env, "blacklist", {})), ...incoming };
            await env.PM.put("blacklist", JSON.stringify(merged));
            return json({ ok: true, count: Object.keys(merged).length }, 200, cors);
          }
          return json(await getJSON(env, "blacklist", {}), 200, cors);
        case "/artists":
          await requireKey(url, env);
          if (request.method === "POST") {
            const cats = await request.json();
            await env.PM.put("categories", JSON.stringify(cats));
            return json({ ok: true, artists: allArtists(cats).length }, 200, cors);
          }
          return json(await getJSON(env, "categories", {}), 200, cors);
        case "/concerts": {
          await requireKey(url, env);
          const store = await getJSON(env, "concerts", {});
          const today = new Date().toISOString().slice(0, 10);
          const list = Object.values(store).filter((e) => e.date >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
          return json({ status: await getJSON(env, "concertStatus", null), concerts: list }, 200, cors);
        }
        case "/concerts/import": {
          await requireKey(url, env);
          const body = await request.json();
          return json(await importResults(env, body.source === "eventim" ? "eventim" : "other", body.results), 200, cors);
        }
        case "/concerts/refresh":
          await requireKey(url, env);
          return json(await runBatch(env, Math.min(parseInt(url.searchParams.get("n") || "8", 10), 15)), 200, cors);
        default:
          return text("Nicht gefunden", 404, cors);
      }
    } catch (e) {
      return text(e.message || String(e), e.status || 500, cors);
    }
  },

  // Cron: Konzerte in kleinen Häppchen prüfen (später auch Neuerscheinungen)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBatch(env, 8));
  },
};

// ------------------------------------------------------------------ Helpers
function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return ALLOWED_ORIGINS.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" }
    : {};
}
const text = (s, status = 200, headers = {}) => new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...headers } });
const html = (body) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Playlist Master Worker</title><body style="font-family:-apple-system,sans-serif;background:#0f1115;color:#eceef2;padding:24px;max-width:640px;margin:auto;line-height:1.5">${body}</body>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function getJSON(env, key, fallback) {
  const v = await env.PM.get(key);
  return v ? JSON.parse(v) : fallback;
}

function randomString(len = 48) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(arr, (x) => chars[x % chars.length]).join("");
}
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function requireKey(url, env) {
  const key = await env.PM.get("key");
  if (!key || url.searchParams.get("key") !== key) {
    const e = new Error("Nicht berechtigt");
    e.status = 401;
    throw e;
  }
}

// ------------------------------------------------------------------ Auth
async function status(env) {
  const token = await getJSON(env, "token", null);
  return html(`<h1>Playlist Master Worker</h1><p>Spotify: ${token ? "verbunden ✓" : "nicht verbunden"}</p><p><a style="color:#1ed760" href="/login">${token ? "Neu verbinden" : "Mit Spotify verbinden"}</a></p>`);
}

async function login(url, env) {
  const verifier = randomString(64);
  const state = randomString(16);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  await env.PM.put("pkce:" + state, verifier, { expirationTtl: 600 });
  const params = new URLSearchParams({
    client_id: env.CLIENT_ID,
    response_type: "code",
    redirect_uri: url.origin + "/callback",
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: SCOPES,
  });
  return Response.redirect("https://accounts.spotify.com/authorize?" + params, 302);
}

async function tokenRequest(env, body) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.CLIENT_ID, ...body }),
  });
  if (!res.ok) throw new Error("Spotify-Token-Fehler " + res.status + ": " + (await res.text()));
  const t = await res.json();
  const prev = await getJSON(env, "token", {});
  const token = { access: t.access_token, refresh: t.refresh_token || prev.refresh, expires: Date.now() + (t.expires_in - 60) * 1000 };
  await env.PM.put("token", JSON.stringify(token));
  return token;
}

async function callback(url, env) {
  const err = url.searchParams.get("error");
  if (err) return html(`<p>Login abgebrochen: ${esc(err)}</p>`);
  const state = url.searchParams.get("state");
  const verifier = state && (await env.PM.get("pkce:" + state));
  if (!verifier) return html(`<p>Login abgelaufen. <a style="color:#1ed760" href="/login">Nochmal versuchen</a></p>`);
  await env.PM.delete("pkce:" + state);
  await tokenRequest(env, { grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: url.origin + "/callback", code_verifier: verifier });

  let key = await env.PM.get("key");
  if (!key) { key = randomString(32); await env.PM.put("key", key); }
  const kickUrl = `${url.origin}/kick?key=${key}`;
  return html(`<h1>Verbunden ✓</h1>
<p>Dein persönlicher Kick-Link (für den Siri-Kurzbefehl, nicht weitergeben):</p>
<p><input readonly value="${esc(kickUrl)}" style="width:100%;padding:10px;font-size:14px;border-radius:8px;border:1px solid #333;background:#181b22;color:#eceef2" onclick="this.select()"></p>
<p><button onclick="navigator.clipboard.writeText('${esc(kickUrl)}');this.textContent='Kopiert ✓'" style="padding:12px 16px;border:0;border-radius:10px;background:#1ed760;font-weight:600">Link kopieren</button></p>`);
}

async function accessToken(env) {
  const t = await getJSON(env, "token", null);
  if (!t) { const e = new Error("Worker ist nicht mit Spotify verbunden"); e.status = 503; throw e; }
  if (Date.now() < t.expires) return t.access;
  return (await tokenRequest(env, { grant_type: "refresh_token", refresh_token: t.refresh })).access;
}

async function api(env, path, { method = "GET", body } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: "Bearer " + (await accessToken(env)), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, (parseInt(res.headers.get("Retry-After") || "1", 10) + 1) * 1000)); continue; }
    if (res.status === 401 && attempt === 0) {
      const t = await getJSON(env, "token", null);
      if (t) { t.expires = 0; await env.PM.put("token", JSON.stringify(t)); }
      continue;
    }
    const raw = await res.text();
    let data = null;
    if (raw) { try { data = JSON.parse(raw); } catch { data = raw; } }
    if (!res.ok) { const e = new Error((data && data.error && data.error.message) || "Spotify " + res.status); e.status = res.status; throw e; }
    return { status: res.status, data };
  }
  throw new Error("Spotify antwortet nicht");
}

// ------------------------------------------------------------------ Kick
async function kick(env) {
  const { status, data } = await api(env, "/me/player/currently-playing");
  if (status === 204 || !data || !data.item) return "Gerade läuft nichts.";
  const item = data.item;
  const artists = (item.artists || []).map((a) => a.name).join(", ");
  const ctx = data.context && data.context.type === "playlist" ? data.context.uri.split(":").pop() : null;

  const bl = await getJSON(env, "blacklist", {});
  bl[item.uri] = { name: item.name, artists, album: item.album ? item.album.name : "", date: new Date().toISOString(), via: "siri" };
  await env.PM.put("blacklist", JSON.stringify(bl));

  let removed = false;
  if (ctx) {
    try {
      await api(env, `/playlists/${ctx}/items`, { method: "DELETE", body: { items: [{ uri: item.uri }] } });
      removed = true;
    } catch { /* z. B. fremde Playlist – Song bleibt trotzdem auf der Blacklist */ }
  }
  try { await api(env, "/me/player/next", { method: "POST" }); } catch { /* ignore */ }

  return removed ? `${item.name} von ${artists} gekickt.` : `${item.name} übersprungen und gemerkt.`;
}
