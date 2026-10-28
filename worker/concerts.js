/**
 * Konzert-Suche: Ticketmaster Discovery API (per Cron im Worker) + Eventim (fragt die App ab, weil
 * Eventim Anfragen von Cloudflare-Servern mit 403 ablehnt; Ergebnisse kommen über /concerts/import).
 * - Abfrage je Künstler, Treffer nur bei exakt gleichem Künstlernamen (keine Tribute-Bands)
 * - nur NRW (über Postleitzahl der Spielstätte), keine Festivals
 * - läuft in kleinen Häppchen per Cron, damit die Free-Limits von Cloudflare reichen
 */

// Postleitzahl-Bereiche NRW (erste zwei Ziffern). Randgebiete sind bewusst großzügig.
const NRW_PLZ = new Set(["32", "33", "40", "41", "42", "44", "45", "46", "47", "48", "50", "51", "52", "53", "57", "58", "59"]);
const FESTIVAL = /festival|rock am ring|rock im park|summer breeze|wacken|juicy beats|parookaville|ruhr in love|kreuzfahrt|cruise/i;

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

export const norm = (s) => String(s || "")
  .toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/^the\s+/, "")
  .replace(/&/g, "and")
  .replace(/[^a-z0-9]/g, "");

const isNrw = (plz) => /^\d{5}$/.test(String(plz || "").trim()) && NRW_PLZ.has(String(plz).trim().slice(0, 2));  // 5-stellig = Deutschland (AT/CH haben 4 Stellen)

// ------------------------------------------------------------------ Eventim
export async function searchEventim(artist) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const params = new URLSearchParams({ webId: "web__eventim-de", language: "de", page: String(page), search_term: artist, categories: "Konzerte" });
    const res = await fetch("https://public-api.eventim.com/websearch/search/api/exploration/v1/products?" + params, {
      headers: { "User-Agent": UA, Accept: "application/json", "Accept-Language": "de-DE,de;q=0.9" },
    });
    if (!res.ok) throw new Error("Eventim " + res.status);
    const data = await res.json();
    for (const p of data.products || []) {
      const le = p.typeAttributes && p.typeAttributes.liveEntertainment;
      if (!le || !le.location) continue;
      out.push({
        source: "eventim",
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

// ------------------------------------------------------------------ Ticketmaster
export async function searchTicketmaster(artist, apiKey) {
  if (!apiKey) return [];
  const params = new URLSearchParams({ apikey: apiKey, keyword: artist, countryCode: "DE", classificationName: "music", locale: "de-de,*", size: "100", sort: "date,asc" });
  const res = await fetch("https://app.ticketmaster.com/discovery/v2/events.json?" + params);
  if (!res.ok) throw new Error("Ticketmaster " + res.status);
  const data = await res.json();
  const events = (data._embedded && data._embedded.events) || [];
  return events.map((e) => {
    const v = (e._embedded && e._embedded.venues && e._embedded.venues[0]) || {};
    const pr = (e.priceRanges || [])[0];
    const cls = (e.classifications || []).map((c) => [c.segment, c.genre, c.subGenre, c.type, c.subType].map((x) => x && x.name).filter(Boolean).join(" ")).join(" ");
    return {
      source: "ticketmaster",
      name: e.name || "",
      attractions: ((e._embedded && e._embedded.attractions) || []).map((a) => a.name),
      categories: [cls],
      start: (e.dates && e.dates.start && e.dates.start.localDate ? e.dates.start.localDate + (e.dates.start.localTime ? "T" + e.dates.start.localTime.slice(0, 5) : "") : ""),
      venue: v.name || "",
      city: (v.city && v.city.name) || "",
      plz: v.postalCode || "",
      price: pr && typeof pr.min === "number" ? pr.min : null,
      currency: (pr && pr.currency) || "EUR",
      url: e.url || "",
    };
  });
}

// ------------------------------------------------------------------ Filter & Merge
export function relevant(ev, artist) {
  const a = norm(artist);
  if (!ev.attractions.some((x) => norm(x) === a)) return false;      // exakter Künstler, keine Tribute-Bands
  if (!isNrw(ev.plz)) return false;
  if (FESTIVAL.test(ev.name) || ev.categories.some((c) => /festival/i.test(c))) return false;
  if (ev.attractions.length >= 6) return false;                        // viele Acts = Festival-artig
  if (!ev.start || new Date(ev.start) < new Date(Date.now() - 864e5)) return false;
  return true;
}

const dayKey = (ev, artist) => `${String(ev.start).slice(0, 10)}|${norm(artist)}|${String(ev.plz).trim().slice(0, 3)}`;  // PLZ statt Stadt (TM schreibt z. B. „Cologne“)

export function mergeInto(store, artist, events, pruneSource = null, now = new Date().toISOString()) {
  const a = norm(artist);
  // alte Einträge dieses Künstlers merken, um verschwundene Termine zu erkennen
  const seen = new Set();
  for (const ev of events) {
    const id = dayKey(ev, artist);
    seen.add(id);
    const cur = store[id] || { id, artist, firstSeen: now, links: {} };
    cur.artist = artist;
    cur.date = String(ev.start).slice(0, 10);
    if (String(ev.start).length > 10 && (!cur.time || ev.source === "eventim")) cur.time = String(ev.start).slice(11, 16);
    cur.time = cur.time || "";
    if (ev.venue && (!cur.venue || ev.source === "eventim")) cur.venue = ev.venue;
    cur.venue = cur.venue || "";
    if (!cur.city || ev.source === "eventim") cur.city = ev.city.replace(/\s*\(.*\)$/, "");
    cur.plz = ev.plz;
    if (ev.price != null && (cur.price == null || ev.price < cur.price)) { cur.price = ev.price; cur.currency = ev.currency; }
    cur.links[ev.source] = ev.url;
    cur.lastSeen = now;
    store[id] = cur;
  }
  // Termine dieses Künstlers, die bei keiner Quelle mehr auftauchen, entfernen
  // Termine, die diese Quelle nicht mehr meldet: Link entfernen, Eintrag löschen wenn keine Quelle übrig
  if (pruneSource) for (const [id, ev] of Object.entries(store)) {
    if (norm(ev.artist) !== a || seen.has(id) || !ev.links) continue;
    delete ev.links[pruneSource];
    if (!Object.keys(ev.links).length) delete store[id];
  }
  return store;
}

export function prunePast(store) {
  const cutoff = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  for (const [id, ev] of Object.entries(store)) if (ev.date < cutoff) delete store[id];
  return store;
}

// ------------------------------------------------------------------ Batch-Lauf
export function allArtists(categories) {
  const names = new Map();
  for (const list of Object.values(categories || {})) for (const n of list) if (!names.has(norm(n))) names.set(norm(n), n);
  return [...names.values()].sort((a, b) => a.localeCompare(b, "de"));
}

export async function runBatch(env, size = 8) {
  const categories = JSON.parse((await env.PM.get("categories")) || "{}");
  const artists = allArtists(categories);
  if (!artists.length) return { done: 0, total: 0, note: "Keine Künstlerlisten im Worker – App einmal öffnen" };

  let cursor = parseInt((await env.PM.get("concertCursor")) || "0", 10);
  if (cursor >= artists.length) cursor = 0;
  const batch = artists.slice(cursor, cursor + size);

  const store = prunePast(JSON.parse((await env.PM.get("concerts")) || "{}"));
  const log = [];
  for (const artist of batch) {
    try {
      const found = (await searchTicketmaster(artist, env.TM_KEY)).filter((e) => relevant(e, artist));
      mergeInto(store, artist, found, "ticketmaster");
      log.push(`${artist}: ${found.length} Treffer`);
    } catch (e) {
      log.push(`${artist}: Ticketmaster Fehler ${e.message}`);
    }
  }

  const next = cursor + batch.length >= artists.length ? 0 : cursor + batch.length;
  await env.PM.put("concerts", JSON.stringify(store));
  await env.PM.put("concertCursor", String(next));
  await env.PM.put("concertStatus", JSON.stringify({ at: new Date().toISOString(), cursor: next, total: artists.length, log }));
  return { from: cursor, to: cursor + batch.length, total: artists.length, log };
}

// Ergebnisse, die die App direkt bei Eventim abgefragt hat (Eventim blockt Cloudflare-Server)
export async function importResults(env, source, results) {
  const store = prunePast(JSON.parse((await env.PM.get("concerts")) || "{}"));
  let hits = 0;
  for (const [artist, events] of Object.entries(results || {})) {
    const found = (events || []).map((e) => ({ ...e, source })).filter((e) => relevant(e, artist));
    hits += found.length;
    mergeInto(store, artist, found, source);
  }
  await env.PM.put("concerts", JSON.stringify(store));
  return { ok: true, artists: Object.keys(results || {}).length, hits };
}
