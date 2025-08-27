// Only the modified/added parts are highlighted below; full file included for clarity
require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const xml2js = require("xml2js");
const crypto = require("crypto");
const LRUCache = require("./lruCache");
let redisClient = null;
if (process.env.REDIS_URL) {
    try {
        const { Redis } = require('ioredis');
        redisClient = new Redis(process.env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 2
        });
        redisClient.on('error', e => console.error('[REDIS] Error:', e.message));
        redisClient.connect().catch(err => console.error('[REDIS] Connect failed:', err.message));
        console.log('[REDIS] Enabled');
    } catch (e) {
        console.warn('[REDIS] ioredis not installed or failed, falling back to in-memory LRU');
        redisClient = null;
    }
}

const ADDON_NAME = "M3U/EPG TV Addon";
const ADDON_ID = "org.stremio.m3u-epg-addon";

const MAX_CACHE_ENTRIES = parseInt(process.env.MAX_CACHE_ENTRIES || '100', 10);
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || (6 * 3600 * 1000).toString(), 10);
const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const dataCache = new LRUCache({ max: MAX_CACHE_ENTRIES, ttl: CACHE_TTL_MS });
const buildPromiseCache = new Map();

function createCacheKey(config) {
    return crypto.createHash('md5').update(JSON.stringify(config)).digest('hex');
}

const DEFAULT_LOGO_SOURCES = [
    "https://raw.githubusercontent.com/iptv-org/epg/master/logos/{id}.png",
    "https://raw.githubusercontent.com/iptv-org/iptv/master/logos/{id}.png"
];

async function redisGetJSON(key) {
    if (!redisClient || !CACHE_ENABLED) return null;
    try {
        const raw = await redisClient.get(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function redisSetJSON(key, value, ttlMs) {
    if (!redisClient || !CACHE_ENABLED) return;
    try {
        if (ttlMs) {
            await redisClient.set(key, JSON.stringify(value), 'PX', ttlMs);
        } else {
            await redisClient.set(key, JSON.stringify(value));
        }
    } catch (e) {
        console.warn('[REDIS] set failed', e.message);
    }
}

class M3UEPGAddon {
    constructor(config = {}, manifestRef) {
        this.config = config;
        this.manifestRef = manifestRef;
        this.cacheKey = createCacheKey(config);
        this.updateInterval = 3600000;
        this.channels = [];
        this.movies = [];
        this.epgData = {};
        this.lastUpdate = 0;

        // Normalize epgOffsetHours (optional)
        if (typeof this.config.epgOffsetHours === 'string') {
            const n = parseFloat(this.config.epgOffsetHours);
            if (!isNaN(n)) this.config.epgOffsetHours = n;
        }
        if (typeof this.config.epgOffsetHours !== 'number' || !isFinite(this.config.epgOffsetHours)) {
            this.config.epgOffsetHours = 0;
        }
        if (Math.abs(this.config.epgOffsetHours) > 48) {
            this.config.epgOffsetHours = 0; // sanity
        }
    }

    async loadFromCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        let cached = dataCache.get(cacheKey);
        if (!cached && redisClient) {
            cached = await redisGetJSON(cacheKey);
            if (cached) dataCache.set(cacheKey, cached);
        }
        if (cached) {
            this.channels = cached.channels || [];
            this.movies = cached.movies || [];
            this.epgData = cached.epgData || {};
            this.lastUpdate = cached.lastUpdate || 0;
            if (this.channels.length || this.movies.length) {
                console.log(`[CACHE] Hit for ${this.cacheKey} (channels=${this.channels.length}, movies=${this.movies.length})`);
            }
        }
    }

    async saveToCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        const entry = {
            channels: this.channels,
            movies: this.movies,
            epgData: this.epgData,
            lastUpdate: this.lastUpdate
        };
        dataCache.set(cacheKey, entry);
        await redisSetJSON(cacheKey, entry, CACHE_TTL_MS);
    }

    buildGenresInManifest() {
        if (!this.manifestRef) return;
        const tvCatalog = this.manifestRef.catalogs.find(c => c.id === 'iptv_channels');
        if (!tvCatalog) return;
        const groups = [
            ...new Set(
                this.channels
                    .map(c => c.category || c.attributes?.['group-title'])
                    .filter(Boolean)
                    .map(s => s.trim())
            )
        ].sort((a, b) => a.localeCompare(b));
        if (!groups.includes('All Channels')) groups.unshift('All Channels');
        tvCatalog.genres = groups;
    }

    parseM3U(content) {
        const lines = content.split('\n');
        const items = [];
        let currentItem = null;
        for (const raw of lines) {
            const line = raw.trim();
            if (line.startsWith('#EXTINF:')) {
                const matches = line.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
                if (matches) {
                    currentItem = {
                        duration: parseInt(matches[1]),
                        attributes: this.parseAttributes(matches[2] || ''),
                        name: (matches[3] || '').trim()
                    };
                }
            } else if (line && !line.startsWith('#') && currentItem) {
                currentItem.url = line;
                currentItem.logo = currentItem.attributes['tvg-logo'];
                currentItem.epg_channel_id = currentItem.attributes['tvg-id'] || currentItem.attributes['tvg-name'];
                currentItem.category = currentItem.attributes['group-title'];
                const group = currentItem.attributes['group-title'] || '';
                const lower = currentItem.name.toLowerCase();
                currentItem.type = (group.toLowerCase().includes('movie') || lower.includes('movie') || this.isMovieFormat(currentItem.name)) ? 'movie' : 'tv';
                currentItem.id = `iptv_${crypto.createHash('md5').update(currentItem.name + currentItem.url).digest('hex').substring(0, 16)}`;
                items.push(currentItem);
                currentItem = null;
            }
        }
        return items;
    }

    parseAttributes(str) {
        const attrs = {};
        const regex = /(\w+(?:-\w+)*)="([^"]*)"/g;
        let m;
        while ((m = regex.exec(str)) !== null) attrs[m[1]] = m[2];
        return attrs;
    }

    isMovieFormat(name) {
        return [/\(\d{4}\)/, /\d{4}\./, /HD$|FHD$|4K$/i].some(p => p.test(name));
    }

    async parseEPG(content) {
        try {
            const parser = new xml2js.Parser();
            const result = await parser.parseStringPromise(content);
            const epgData = {};
            if (result.tv && result.tv.programme) {
                for (const prog of result.tv.programme) {
                    const ch = prog.$.channel;
                    if (!epgData[ch]) epgData[ch] = [];
                    epgData[ch].push({
                        start: prog.$.start,
                        stop: prog.$.stop,
                        title: prog.title ? prog.title[0]._ || prog.title[0] : 'Unknown',
                        desc: prog.desc ? prog.desc[0]._ || prog.desc[0] : ''
                    });
                }
            }
            return epgData;
        } catch {
            return {};
        }
    }

    // Enhanced to parse optional timezone and apply offset
    parseEPGTime(s) {
        if (!s) return new Date();
        // XMLTV often: YYYYMMDDHHMMSS ZZZZ  (timezone optional)  or YYYYMMDDHHMMSS+ZZZZ (no space)
        const m = s.match(/^(\d{14})(?:\s*([+\-]\d{4}))?/);
        if (m) {
            const base = m[1];
            const tz = m[2] || null;
            const year = parseInt(base.slice(0, 4), 10);
            const month = parseInt(base.slice(4, 6), 10) - 1;
            const day = parseInt(base.slice(6, 8), 10);
            const hour = parseInt(base.slice(8, 10), 10);
            const min = parseInt(base.slice(10, 12), 10);
            const sec = parseInt(base.slice(12, 14), 10);

            let date;
            if (tz) {
                // Construct ISO-like string and let Date parse
                const iso = `${year.toString().padStart(4,'0')}-${(month+1).toString().padStart(2,'0')}-${day.toString().padStart(2,'0')}T${hour.toString().padStart(2,'0')}:${min.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}${tz}`;
                const parsed = new Date(iso);
                if (!isNaN(parsed.getTime())) {
                    date = parsed;
                }
            }
            if (!date) {
                // Fallback: treat as local time
                date = new Date(year, month, day, hour, min, sec);
            }

            if (this.config.epgOffsetHours) {
                date = new Date(date.getTime() + this.config.epgOffsetHours * 3600000);
            }
            return date;
        }
        // Fallback original approach
        const d = new Date(s);
        if (this.config.epgOffsetHours && !isNaN(d.getTime())) {
            return new Date(d.getTime() + this.config.epgOffsetHours * 3600000);
        }
        return d;
    }

    getCurrentProgram(channelId) {
        if (!channelId || !this.epgData[channelId]) return null;
        const now = new Date();
        for (const p of this.epgData[channelId]) {
            const start = this.parseEPGTime(p.start);
            const stop = this.parseEPGTime(p.stop);
            if (now >= start && now <= stop) {
                return { title: p.title, description: p.desc, start, stop, startTime: start, stopTime: stop };
            }
        }
        return null;
    }

    getUpcomingPrograms(channelId, limit = 5) {
        if (!channelId || !this.epgData[channelId]) return [];
        const now = new Date();
        const upcoming = [];
        for (const p of this.epgData[channelId]) {
            const start = this.parseEPGTime(p.start);
            if (start > now && upcoming.length < limit) {
                upcoming.push({ title: p.title, description: p.desc, startTime: start, stopTime: this.parseEPGTime(p.stop) });
            }
        }
        return upcoming.sort((a, b) => a.startTime - b.startTime);
    }

    async fetchXtreamJsonData() {
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config;
        const base = `${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;
        const liveResp = await fetch(`${base}&action=get_live_streams`);
        const live = await liveResp.json();
        const vodResp = await fetch(`${base}&action=get_vod_streams`);
        const vod = await vodResp.json();

        this.channels = live.map(s => ({
            id: `iptv_live_${s.stream_id}`,
            name: s.name,
            type: 'tv',
            url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.m3u8`,
            logo: s.stream_icon,
            category: s.category_name,
            epg_channel_id: s.epg_channel_id,
            attributes: {
                'tvg-logo': s.stream_icon,
                'tvg-id': s.epg_channel_id,
                'group-title': s.category_name
            }
        }));

        this.movies = vod.map(s => ({
            id: `iptv_vod_${s.stream_id}`,
            name: s.name,
            type: 'movie',
            url: `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.${s.container_extension}`,
            poster: s.stream_icon,
            plot: s.plot,
            year: s.releasedate ? new Date(s.releasedate).getFullYear() : null,
            attributes: {
                'tvg-logo': s.stream_icon,
                'group-title': 'Movies',
                'plot': s.plot
            }
        }));

        if (this.config.enableEpg) {
            const epgResp = await fetch(`${xtreamUrl}/xmltv.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`);
            const epgContent = await epgResp.text();
            this.epgData = await this.parseEPG(epgContent);
        }
    }

    async fetchXtreamM3UData() {
        const { xtreamUrl, xtreamUsername, xtreamPassword, xtreamOutput } = this.config;
        const url =
            `${xtreamUrl}/get.php?username=${encodeURIComponent(xtreamUsername)}` +
            `&password=${encodeURIComponent(xtreamPassword)}` +
            `&type=m3u_plus` +
            (xtreamOutput ? `&output=${encodeURIComponent(xtreamOutput)}` : '');
        const resp = await fetch(url, { timeout: 30000, headers: { 'User-Agent': 'Stremio M3U/EPG Addon' } });
        if (!resp.ok) throw new Error('Xtream M3U fetch failed');
        const text = await resp.text();
        const items = this.parseM3U(text);
        this.channels = items.filter(i => i.type === 'tv');
        this.movies = items.filter(i => i.type === 'movie');

        if (this.config.enableEpg) {
            const epgResp = await fetch(`${xtreamUrl}/xmltv.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`);
            if (epgResp.ok) {
                const epgContent = await epgResp.text();
                this.epgData = await this.parseEPG(epgContent);
            }
        }
    }

    async fetchDirectData() {
        const { m3uUrl, epgUrl } = this.config;
        if (m3uUrl) {
            const resp = await fetch(m3uUrl, { timeout: 30000, headers: { 'User-Agent': 'Stremio M3U/EPG Addon' } });
            if (!resp.ok) throw new Error('Direct M3U fetch failed');
            const text = await resp.text();
            const items = this.parseM3U(text);
            this.channels = items.filter(i => i.type === 'tv');
            this.movies = items.filter(i => i.type === 'movie');
        }
        if (epgUrl && this.config.enableEpg !== false) {
            try {
                const epgResp = await fetch(epgUrl, { timeout: 20000, headers: { 'User-Agent': 'Stremio M3U/EPG Addon' } });
                if (epgResp.ok) {
                    const epgContent = await epgResp.text();
                    this.epgData = await this.parseEPG(epgContent);
                }
            } catch { /* ignore */ }
        }
    }

    async updateData(force = false) {
        const now = Date.now();
        if (!force && CACHE_ENABLED) {
            if (this.lastUpdate && now - this.lastUpdate < this.updateInterval) return;
            if ((this.channels.length || this.movies.length) && now - this.lastUpdate < 900000) return;
        }
        try {
            if (this.config.useXtream) {
                if (this.config.xtreamUseM3U) await this.fetchXtreamM3UData();
                else await this.fetchXtreamJsonData();
            } else {
                await this.fetchDirectData();
            }
            this.lastUpdate = Date.now();
            if (CACHE_ENABLED) {
                await this.saveToCache();
            }
            this.buildGenresInManifest();
        } catch (e) {
            console.error('[UPDATE] Failed:', e.message);
        }
    }

    deriveFallbackLogoUrl(item) {
        const logoAttr = item.attributes?.['tvg-logo'];
        if (logoAttr && logoAttr.trim()) return logoAttr;
        const tvgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
        if (!tvgId)
            return `https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(item.name)}`;
        return `logo/${encodeURIComponent(tvgId)}.png`;
    }

    generateMetaPreview(item) {
        const meta = { id: item.id, type: item.type, name: item.name };
        if (item.type === 'tv') {
            const epgId = item.attributes['tvg-id'] || item.attributes['tvg-name'];
            const current = this.getCurrentProgram(epgId);
            meta.description = current ? `📡 Now: ${current.title}${current.description ? `\n${current.description}` : ''}` : '📡 Live Channel';
            meta.poster = this.deriveFallbackLogoUrl(item);
            meta.genres = item.category ? [item.category] : (item.attributes['group-title'] ? [item.attributes['group-title']] : ['Live TV']);
            meta.runtime = 'Live';
        } else {
            meta.poster = item.poster ||
                item.attributes['tvg-logo'] ||
                `https://via.placeholder.com/300x450/CC6600/FFFFFF?text=${encodeURIComponent(item.name)}`;
            meta.year = item.year;
            if (!meta.year) {
                const m = item.name.match(/\((\d{4})\)/);
                if (m) meta.year = parseInt(m[1]);
            }
            meta.description = item.plot || item.attributes['plot'] || `Movie: ${item.name}`;
            meta.genres = item.attributes['group-title'] ? [item.attributes['group-title']] : ['Movie'];
        }
        return meta;
    }

    getStream(id) {
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
        if (!item) return null;
        return {
            url: item.url,
            title: item.type === 'tv' ? `${item.name} - Live` : item.name,
            behaviorHints: { notWebReady: true }
        };
    }

    getDetailedMeta(id) {
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
        if (!item) return null;
        if (item.type === 'tv') {
            const epgId = item.attributes['tvg-id'] || item.attributes['tvg-name'];
            const current = this.getCurrentProgram(epgId);
            const upcoming = this.getUpcomingPrograms(epgId, 3);
            let description = `📺 CHANNEL: ${item.name}`;
            if (current) {
                const start = current.startTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
                const end = current.stopTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
                description += `\n\n📡 NOW: ${current.title}${start && end ? ` (${start}-${end})` : ''}`;
                if (current.description) description += `\n\n${current.description}`;
            }
            if (upcoming.length) {
                description += '\n\n📅 UPCOMING:\n';
                for (const p of upcoming) {
                    description += `${p.startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${p.title}\n`;
                }
            }
            return {
                id: item.id,
                type: 'tv',
                name: item.name,
                poster: this.deriveFallbackLogoUrl(item),
                description,
                genres: item.category ? [item.category] :
                    (item.attributes['group-title'] ? [item.attributes['group-title']] : ['Live TV']),
                runtime: 'Live'
            };
        } else {
            let year = item.year;
            if (!year) {
                const m = item.name.match(/\((\d{4})\)/);
                if (m) year = parseInt(m[1]);
            }
            const description = item.plot || item.attributes['plot'] || `Movie: ${item.name}`;
            return {
                id: item.id,
                type: 'movie',
                name: item.name,
                poster: item.poster || item.attributes['tvg-logo'] ||
                    `https://via.placeholder.com/300x450/CC6600/FFFFFF?text=${encodeURIComponent(item.name)}`,
                description,
                genres: item.attributes['group-title'] ? [item.attributes['group-title']] : ['Movie'],
                year
            };
        }
    }
}

module.exports = async function createAddon(config = {}) {
    if (!config.instanceId) {
        config.instanceId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex');
    }

    const manifest = {
        id: ADDON_ID,
        version: "1.2.0",
        name: ADDON_NAME,
        description: "IPTV addon with M3U, EPG & Xtream (JSON/M3U) + encrypted configs, LRU/Redis cache, cache toggle, EPG offset",
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie"],
        catalogs: [
            {
                type: 'tv',
                id: 'iptv_channels',
                name: 'IPTV Channels',
                extra: [
                    { name: 'genre' },
                    { name: 'search' },
                    { name: 'skip' }
                ],
                genres: []
            },
            {
                type: 'movie',
                id: 'iptv_movies',
                name: 'IPTV Movies',
                extra: [
                    { name: 'search' },
                    { name: 'skip' }
                ]
            }
        ],
        idPrefixes: ["iptv_"],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    };

    const cacheKey = createCacheKey(config);
    console.log(`[ADDON] Cache ${CACHE_ENABLED ? 'ENABLED' : 'DISABLED'} for config ${cacheKey}`);

    if (CACHE_ENABLED && buildPromiseCache.has(cacheKey)) {
        return buildPromiseCache.get(cacheKey);
    }

    const buildPromise = (async () => {
        const builder = new addonBuilder(manifest);
        const addonInstance = new M3UEPGAddon(config, manifest);
        await addonInstance.loadFromCache();
        await addonInstance.updateData(true);
        addonInstance.buildGenresInManifest();

        builder.defineCatalogHandler(async (args) => {
            try {
                addonInstance.updateData().catch(() => { });
                let items = [];
                if (args.type === 'tv' && args.id === 'iptv_channels') {
                    items = addonInstance.channels;
                } else if (args.type === 'movie' && args.id === 'iptv_movies') {
                    items = addonInstance.movies;
                }
                const extra = args.extra || {};
                if (extra.genre && extra.genre !== 'All Channels') {
                    const g = extra.genre.toLowerCase();
                    items = items.filter(it => (it.category || it.attributes?.['group-title'] || '').toLowerCase() === g);
                }
                if (extra.search) {
                    const q = extra.search.toLowerCase();
                    items = items.filter(it =>
                        it.name.toLowerCase().includes(q) ||
                        (it.category || '').toLowerCase().includes(q)
                    );
                }
                const skip = parseInt(extra.skip || args.skip) || 0;
                const metas = items.slice(skip, skip + 100).map(i => addonInstance.generateMetaPreview(i));
                return { metas };
            } catch (e) {
                console.error('[CATALOG] error', e);
                return { metas: [] };
            }
        });

        builder.defineStreamHandler(async (args) => {
            try {
                const s = addonInstance.getStream(args.id);
                return { streams: s ? [s] : [] };
            } catch (e) {
                return { streams: [] };
            }
        });

        try {
            builder.defineMetaHandler(async (args) => {
                try {
                    const m = addonInstance.getDetailedMeta(args.id);
                    return { meta: m || null };
                } catch {
                    return { meta: null };
                }
            });
        } catch {
            const idx = manifest.resources.indexOf('meta');
            if (idx > -1) manifest.resources.splice(idx, 1);
        }

        const logoSources = Array.isArray(config.logoSources) && config.logoSources.length
            ? config.logoSources
            : DEFAULT_LOGO_SOURCES;
        const iface = builder.getInterface();
        iface._logoSources = logoSources;
        return iface;
    })();

    if (CACHE_ENABLED) buildPromiseCache.set(cacheKey, buildPromise);
    return buildPromise;
};