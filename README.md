# Music Finder

Shazam-style song identification for Instagram Reels, video clips, and audio files.

**Pipeline:** Upload → FFmpeg (extract audio) → Chromaprint/`fpcalc` (fingerprint) → AcoustID (lookup) → MusicBrainz (metadata) → Cover Art Archive (artwork)

```
music-finder/
├── backend/           Express API — never exposes the AcoustID key to the browser
│   ├── server.js
│   ├── routes/recognize.js
│   ├── utils/audioProcessor.js      FFmpeg + fpcalc wrappers
│   ├── utils/recognitionProvider.js AcoustID/MusicBrainz + pluggable fallback chain
│   └── .env.example
└── frontend/           Static SPA — dark, mobile-first UI
    ├── index.html
    ├── css/style.css
    └── js/app.js
```

## 1. Get an AcoustID key (free)

Register an application at https://acoustid.org/new-application — you get a client API key instantly. This key stays server-side only.

## 2. Backend setup

Requires **FFmpeg** and **Chromaprint's `fpcalc`** on the machine running the server.

```bash
# Ubuntu/Debian (also works on Render's build via apt in a Dockerfile)
sudo apt-get install -y ffmpeg chromaprint

# macOS
brew install ffmpeg chromaprint
```

```bash
cd backend
npm install
cp .env.example .env
# edit .env — paste your ACOUSTID_CLIENT_KEY, set ALLOWED_ORIGINS to your frontend URL
npm start
```

The API is now running on `http://localhost:3000` with one route:

- `POST /api/recognize` — multipart form field `media` (audio or video file, ≤50MB by default) → JSON result
- `GET /api/health` — health check

### Deploying the backend (Render)

Render's default Node buildpack doesn't include `ffmpeg`/`fpcalc`, so use a Dockerfile:

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg chromaprint && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --production
COPY backend/ .
ENV NODE_ENV=production
CMD ["node", "server.js"]
```

Set `ACOUSTID_CLIENT_KEY` and `ALLOWED_ORIGINS` as Render environment variables — never commit `.env`.

## 3. Frontend setup

The frontend is static — deploy `frontend/` as-is to **Vercel** or **GitHub Pages**.

Before deploying, point it at your live backend by setting `window.MUSIC_FINDER_API_BASE` — easiest is adding one line before the `app.js` script tag in `index.html`:

```html
<script>window.MUSIC_FINDER_API_BASE = "https://your-backend.onrender.com/api";</script>
<script src="js/app.js"></script>
```

For local development, the frontend defaults to `/api` (relative), so serving both from the same origin works with no config.

## Notes on the current build (v1)

- **History** is stored in `localStorage` on-device — no database needed yet. When you're ready for cross-device history, swap `getHistory()`/`addToHistory()` in `app.js` for calls to a Supabase table (`songs_identified`) keyed by a Firebase Auth UID — the rest of the app doesn't need to change.
- **Recognition fallback**: `RecognitionChain` in `utils/recognitionProvider.js` already accepts multiple providers in order. To add a paid fallback (e.g. AudD, ACRCloud) later, write a class with the same `identify({fingerprint, duration})` shape and add it to the array in `routes/recognize.js` — no other changes needed.
- **Full-track playback** (the "Future Recognition Fallback"/full-media feature described in the spec) is intentionally not wired up yet — the result screen only links out to official YouTube/Spotify/Apple Music search results, which keeps things unambiguously legal for v1. If you add `yt-dlp` later, keep it in its own module, separate from recognition, and gate it behind confirming the user owns/is authorized for the content.
- **Rate limiting**: 10 recognition requests/minute per IP by default (`server.js`) — adjust for your traffic.
- **Upload limit**: 50MB by default, set via `MAX_UPLOAD_MB`.
