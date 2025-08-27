# M3U / EPG IPTV Addon for Stremio

A feature‑rich, configurable Stremio addon that ingests IPTV M3U playlists and optional EPG (XMLTV) guide data – with built‑in Xtream Codes API support, encrypted configuration tokens, caching (LRU + optional Redis), dynamic per‑user instances, and a polished web configuration UI.

---

## ✨ Key Features

| Area | Highlights |
|------|------------|
| IPTV Sources | Direct M3U playlists OR Xtream Codes API (JSON or `m3u_plus` modes) |
| EPG (XMLTV) | Optional program guide parsing, current & upcoming program injection |
| Movies vs TV | Auto classification using naming heuristics & `group-title` |
| Dynamic Config | Each user installs the addon via a unique (optionally encrypted) token |
| Reconfiguration | Stremio “Configure” button opens the prefill UI (`/:token/configure`) |
| Encrypted Tokens | AES‑256‑GCM encryption (when `CONFIG_SECRET` is set) instead of plain base64 |
| Caching Layers | In‑memory LRU (channels, EPG, interface) + optional Redis for shared / multi‑process caching |
| Cache Toggle | Global on/off (`CACHE_ENABLED=false`) for debugging or strict freshness |
| Logo Fallbacks | Multiple template sources + per‑playlist logo resolution with placeholders |
| Performance | Build promise deduplication, TTL boundaries, selective refresh logic |
| Security Extras | Password masking on reconfigure, encrypted payload option, instanceId randomization |
| Serverless Mode | Basic `serverless.js` deploy target (e.g. Vercel) |
| Minimal Footprint | No DB required unless you opt into Redis |

---

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/yourusername/stremio-m3u-epg-addon.git
cd stremio-m3u-epg-addon
npm install
```

### 2. (Optional) Create `.env`

```ini
# .env
CONFIG_SECRET=YOUR_64_HEX_RANDOM_SECRET   # enables encrypted config tokens (recommended)
CACHE_ENABLED=true                        # master cache switch
CACHE_TTL_MS=21600000                     # 6h cache TTL (data + interface)
MAX_CACHE_ENTRIES=100                     # LRU capacity
# REDIS_URL=redis://localhost:6379        # enable Redis for shared caching
```

> Generate a strong secret:
> ```bash
> openssl rand -hex 32
> # or
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```


### 3. Start the Server

```bash
npm start
```

---

## 🐳 Docker Support

You can run this addon in a Docker container for easy deployment and isolation.

### Build the Docker image

```bash
docker build -t stremio-m3u-epg-addon .
```

### Run the container

```bash
docker run -d \
  --name stremio_addon \
  -p 7000:7000 \
  -v $(pwd)/.env:/app/.env:ro \
  stremio-m3u-epg-addon
```

This will:
- Expose the addon on port 7000
- Use your local `.env` file for configuration
- Run in detached mode

You can now access the addon at `http://localhost:7000` (or your server's IP).

---

Visit: `http://localhost:7000`

### 4. Configure & Install

1. Choose “Direct Links” (M3U / EPG URLs) **or** “Xtream API”.
2. Fill required fields.
3. Click “Install / Update Addon”.
4. Stremio should open with the install prompt.  
   If not: copy the shown `.../<token>/manifest.json` URL and paste manually in Stremio → Add-ons → “Install via URL”.

---

## 🧩 Configuration Methods

### Method A: Direct URLs

| Field | Required | Description |
|-------|----------|-------------|
| `m3uUrl` | Yes | Full URL to playlist (.m3u / .m3u8) |
| `epgUrl` | No | XMLTV URL for guide data |
| Enable EPG | Optional | Skip if guide file is huge / unstable |

### Method B: Xtream Codes

| Field | Required | Description |
|-------|----------|-------------|
| `xtreamUrl` | Yes | Base URL (e.g. `http://panel.example.com:8080`) |
| `xtreamUsername` | Yes | Xtream account login |
| `xtreamPassword` | Yes | Xtream password |
| `xtreamUseM3U` | Optional | Force M3U mode instead of JSON API |
| `xtreamOutput` | Optional | Adds `&output=` for custom container hints |

### EPG Configuration

EPG Time Offset: Add or subtract hours from all guide times after parsing.
Use this if your EPG appears consistently shifted.

Example: If guide shows programs 4 hours ahead of your local time, set -4. Can be fractional (e.g. 2.5) and supports up to ±24 realistically (hard limit ±48).

---

## 🔐 Token Formats & Security

| Token Type | Prefix | Contents | When Used |
|------------|--------|----------|-----------|
| Plain Base64 | (none) | Base64 of JSON config | Default if `CONFIG_SECRET` not set or encryption endpoint not used |
| Encrypted | `enc:` | AES‑256‑GCM (iv + tag + ciphertext) base64 | When `CONFIG_SECRET` set **and** `/encrypt` endpoint consumed by a client |

### Example Plain JSON (before encoding)

```json
{
  "useXtream": false,
  "m3uUrl": "https://example.com/list.m3u",
  "epgUrl": "https://example.com/epg.xml",
  "enableEpg": true,
  "instanceId": "0b7c6c5c-5e9e-4d1c-9b9d-d3bf..."
}
```

### Reconfigure

Stremio calls:  
`https://your-host/<token>/configure`  
If the token is **plain base64**, the form is prefilled (password masked as `********`).  
If encrypted (`enc:`), user must re-enter (privacy by design).

### Password Masking

During reconfigure, unchanged password fields retain original value via a hidden data attribute – preventing accidental blanking.

---

## 🗄️ Caching Architecture

| Layer | Purpose | Controlled By |
|-------|---------|---------------|
| In‑Process LRU | Channels, Movies, EPG, Interface objects | `CACHE_ENABLED`, `MAX_CACHE_ENTRIES`, `CACHE_TTL_MS` |
| Redis (optional) | Shared cache across multiple processes / pods | `REDIS_URL` |
| Build Promise Map | Prevents duplicate concurrent initializations | Disabled if `CACHE_ENABLED=false` |

### Disabling Cache

```bash
CACHE_ENABLED=false npm start
```

Effects:
- Every request refetches playlist / EPG.
- No reuse of parsed arrays.
- Useful for debugging freshness or provider issues.

---

## 🔄 Update & Refresh Logic

- Forced initial build: first hit to `/:token/manifest.json`.
- Subsequent catalog calls trigger background `updateData()` if stale.
- Short-circuit intervals:
  - Full update interval: 1 hour.
  - Frequent access guard: skip rebuild within 15 mins if data present.

---

## 🖼️ Logos

Order of resolution:
1. M3U attribute: `tvg-logo`
2. Derived fallback using relative `logo/{tvg-id}.png`
3. External template sources (defaults from iptv-org repos)
4. Placeholder image (text-based)

Route format:  
`/:token/logo/<tvgId>.png`

---

## 📁 Project Structure (Key Files)

```
├── addon.js             # Core addon & data logic
├── server.js            # Express server (dynamic token routing, encryption endpoint)
├── serverless.js        # Simplified handler for serverless platforms
├── configure.html       # Root HTML configuration page
├── public/
│   ├── configure.css    # Extracted UI styles
│   └── configure.js     # UI logic (token build, form handling)
├── cryptoConfig.js      # AES-GCM encrypt/decrypt helpers
├── lruCache.js          # Minimal LRU+TTL implementation
├── .env.example         # (You can create for documentation)
├── package.json
└── README.md
```

---

## ⚙️ Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CONFIG_SECRET` | Enables encrypted tokens (AES-256-GCM) | (unset) |
| `CACHE_ENABLED` | Master cache toggle | `true` |
| `CACHE_TTL_MS` | TTL for data & interface caches | `21600000` (6h) |
| `MAX_CACHE_ENTRIES` | LRU capacity | `100` |
| `REDIS_URL` | Enables Redis caching if set | (unset) |
| `PORT` | HTTP port | `7000` |

### Example `.env`

```ini
CONFIG_SECRET=cbf87d...<64 hex>...
CACHE_ENABLED=true
CACHE_TTL_MS=21600000
MAX_CACHE_ENTRIES=150
# REDIS_URL=redis://localhost:6379
```

> Do **not** commit your real `.env`. Add a `.env.example` template if contributing.

---

## 🔌 API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Config UI |
| `/health` | GET | Health probe |
| `/:token/manifest.json` | GET | Stremio manifest |
| `/:token/catalog/:type/:id.json` | GET | Catalog (supports `?genre=&search=&skip=`) |
| `/:token/stream/:type/:id.json` | GET | Stream object(s) |
| `/:token/meta/:type/:id.json` | GET | Rich metadata (channel or movie) |
| `/:token/logo/:tvgId.png` | GET | Logo proxy / fallback |
| `/:token/configure` | GET | Reconfigure UI |
| `/encrypt` | POST (JSON) | Returns encrypted `enc:` token (only if `CONFIG_SECRET` set) |

#### `/encrypt` Usage Example

```bash
curl -X POST http://localhost:7000/encrypt \
  -H "Content-Type: application/json" \
  -d '{"m3uUrl":"https://example.com/playlist.m3u","enableEpg":true}'
```

Response:
```json
{ "token": "enc:BASE64_IV_TAG_CIPHERTEXT" }
```

Then manifest URL:  
`http://localhost:7000/enc:BASE64_IV_TAG_CIPHERTEXT/manifest.json`

---

## 🧪 Testing & Validation

Although no formal test suite is bundled beyond simple flows:

- Validate playlist accessibility:
  ```bash
  curl -I https://your-playlist.m3u
  ```
- Inspect manifest:
  ```bash
  curl http://localhost:7000/<token>/manifest.json | jq
  ```
- Catalog page sample:
  ```bash
  curl http://localhost:7000/<token>/catalog/tv/iptv_channels.json | jq '.metas[0]'
  ```

---

## 🔍 Troubleshooting

| Symptom | Possible Cause | Fix |
|---------|----------------|-----|
| 404 on configure link | Token invalid / route mis-ordered | Ensure `/:token/configure` before generic middleware |
| Empty catalog | M3U unreachable or blocked | Open M3U URL directly in browser / curl |
| No EPG info | `enableEpg` false or XML invalid | Confirm `epgUrl` returns XML; check channel IDs |
| Frequent rebuilds | Cache disabled | Set `CACHE_ENABLED=true` |
| Credentials visible in URL | Not using encryption | Set `CONFIG_SECRET` & switch to `/encrypt` flow |
| High memory usage | Many distinct tokens (unique configs) | Set TTL shorter / adjust `MAX_CACHE_ENTRIES` / enable Redis |

Enable debug noise:
```bash
DEBUG=* npm start
```

---

## 🛡️ Security Recommendations

1. Always set `CONFIG_SECRET` in production.
2. Serve via HTTPS (reverse proxy: Nginx, Caddy, Traefik).
3. Do **not** publicly advertise tokens; they act as bearer “access”.
4. Rotate credentials with providers if tokens leak.
5. Consider adding IP allowlists or simple auth middleware if hosting publicly.
6. Avoid logging plain tokens (if you must log, hash them first).

---

## 📦 Deployment Notes

### Classic Node / PM2

```bash
pm2 start server.js --name stremio-iptv
```

## 🧩 Docker Compose

You can use Docker Compose to run the addon (and optional Redis) easily:

```bash
docker-compose up -d
```

This will build and start the addon on port 7000. To enable Redis, uncomment the Redis section in `docker-compose.yml` and set `REDIS_URL=redis://redis:6379` in your `.env`.

---

### Docker Build (example)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=7000
EXPOSE 7000
CMD ["node","server.js"]
```

Build & run:
```bash
docker build -t stremio-iptv .
docker run -e CONFIG_SECRET=$(openssl rand -hex 32) -p 7000:7000 stremio-iptv
```

---

## ▲ Deploy on Vercel

This project supports serverless deployment on [Vercel](https://vercel.com/):

1. Push your code to a GitHub/GitLab repo.
2. Sign up at [vercel.com](https://vercel.com/) and import your repo.
3. Vercel will detect `vercel.json` and deploy using `serverless.js`.
4. Set your environment variables in the Vercel dashboard (Settings → Environment Variables).

Your addon will be available at `https://your-vercel-project.vercel.app`.

---

### Serverless (Vercel / Now)

`now.json` currently routes everything to `serverless.js` – note:
- Only a single static configuration (no dynamic token parsing) is implemented there.
- To enable dynamic tokens serverlessly, replicate the Express logic (URL token segment decode + route rewriting).
- Serverless cold starts will re-fetch playlists; consider trimming features or enabling external cache (Redis) if TPS grows.

---

## 🧱 Future Ideas (Contributions Welcome)

- HLS stream preflight / health checks
- Channel logo caching persistence
- WebSocket push for EPG live updates
- Multi-key rotation support (`CONFIG_SECRET_OLD`)
- Multi-provider aggregation
- Metrics endpoint (cache hit rate, fetch timings)
- Optional auth layer (JWT / API key)

---

## 🤝 Contributing

1. Fork & branch:
   ```bash
   git checkout -b feature/my-improvement
   ```
2. Follow existing code style (lightweight).
3. Add ENV docs if introducing new variables.
4. Submit PR with a clear description & use case.

---

## 📝 License

MIT © Your Name (Replace in `package.json` & README)

---

## ⚠️ Disclaimer

This project is for personal / educational IPTV aggregation. Ensure your use complies with all applicable laws and your provider’s terms. Do **not** distribute credentials or proprietary playlists.

---

## 🧭 Changelog (Summary)

| Version | Highlights |
|---------|------------|
| 1.5.0 | Added support for users to host on vercel and run in docker |
| 1.4.0 | Added function to manage EPG Offset in addon config |
| 1.3.0 | Added new loader ui and copy manifest button |
| 1.2.0 | Cache toggle env, separated assets, encryption endpoint refinement |
| 1.1.x | Encrypted configs, Redis + LRU caching, password masking |
| 1.0.0 | Initial release, M3U + EPG + Xtream support, dynamic config |

(See commit history for detailed changes.)

---

## 🙋 Support

Open a GitHub Issue with:

- Environment (OS, Node version)
- Config token type (plain vs encrypted)
- Logs (redact secrets)
- Reproduction steps
- Sample (anonymized) playlist snippet (if relevant)

---

Happy streaming! 🎬📡  
If this helps you, consider starring the repo ⭐
