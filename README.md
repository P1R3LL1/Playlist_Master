# Playlist Master

Private Web-App für Spotify: Genre-Playlists aus kompletten Studio-Discografien, Songs beim Hören mit einem Tipp „kicken“.

## Funktionen (v1)
- **Läuft gerade:** aktueller Song mit großem Kick-Button. Der Song wird aus der laufenden Playlist entfernt, übersprungen und auf die Blacklist gesetzt.
- **Playlists:** pro Kategorie (Metal, Rock, Electro, Rap & HipHop, Softrock & Indie) eine Playlist `PM · <Kategorie>`. Nur Studioalben, ohne Live-, Compilation- und Deluxe-Duplikate. Gekickte Songs werden übersprungen.
- **Blacklist:** gekickte Songs ansehen, zurückholen, exportieren/importieren.

## Geplant (Cloudflare Worker)
- Siri-Kurzbefehl „Song kicken“ (freihändig über CarPlay)
- Neuerscheinungen der eigenen Künstler (MusicBrainz)
- Vorschläge neuer Künstler mit Probehör-Playlist (Last.fm)
- Konzerte in NRW (Ticketmaster Discovery API, ohne Festivals)

## Setup
- Spotify-Developer-App „Playlist Manager Dennis“, Client ID in `config.js`
- Redirect-URIs im Spotify-Dashboard: `http://127.0.0.1:8888/callback` (lokal) und die GitHub-Pages-Adresse `https://p1r3ll1.github.io/Playlist_Master/`
- Hosting: GitHub Pages (Branch `main`, Ordner `/`)

Lokal testen: `python3 -m http.server 8888 --bind 127.0.0.1` und `http://127.0.0.1:8888/` öffnen (Redirect-URI dafür: `http://127.0.0.1:8888/`).
