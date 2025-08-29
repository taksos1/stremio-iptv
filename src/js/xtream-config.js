(function () {
    const form             = document.getElementById('xtreamForm');
    if (!form) {
        console.error('[XTREAM-CONFIG] #xtreamForm not found');
        return;
    }

    const xtreamUrlInput   = document.getElementById('xtreamUrl');
    const userInput        = document.getElementById('xtreamUsername');
    const pwdInput         = document.getElementById('xtreamPassword');
    const togglePwdBtn     = document.getElementById('togglePwd');
    const useM3UChk        = document.getElementById('xtreamUseM3U');
    const outputInput      = document.getElementById('xtreamOutput');
    const outputGroup      = document.getElementById('xtreamOutputGroup');
    const enableEpgChk     = document.getElementById('enableEpg');
    const epgOffsetInput   = document.getElementById('epgOffsetHours');
    const debugChk         = document.getElementById('debugMode');
    const customEpgGroup   = document.getElementById('customEpgGroup');
    const customEpgUrlInp  = document.getElementById('customEpgUrl');

    const epgModeRadios    = () => [...document.querySelectorAll('input[name="epgMode"]')];

    const {
        showOverlay,
        hideOverlay,
        startPolling,
        buildUrls,
        appendDetail,
        setProgress,
        overlaySetMessage,
        forceDisableActions,
        prefillIfReconfigure
    } = window.ConfigureCommon || {};

    if (!window.ConfigureCommon) {
        console.error('[XTREAM-CONFIG] ConfigureCommon not loaded.');
        return;
    }

    if (typeof prefillIfReconfigure === 'function')
        prefillIfReconfigure('xtream');

    function syncOutputVisibility() {
        if (outputGroup) {
            outputGroup.classList.toggle('hidden', !useM3UChk.checked);
        }
    }

    function selectedEpgMode() {
        const r = epgModeRadios().find(r => r.checked);
        return r ? r.value : 'xtream';
    }

    function syncCustomEpgVisibility() {
        const mode = selectedEpgMode();
        customEpgGroup.classList.toggle('hidden', !(enableEpgChk.checked && mode === 'custom'));
    }

    if (togglePwdBtn && pwdInput) {
        togglePwdBtn.addEventListener('click', e => {
            e.preventDefault();
            if (pwdInput.type === 'password') {
                pwdInput.type = 'text';
                togglePwdBtn.textContent = 'Hide';
            } else {
                pwdInput.type = 'password';
                togglePwdBtn.textContent = 'Show';
            }
        });
    }

    if (useM3UChk) {
        useM3UChk.addEventListener('change', syncOutputVisibility);
        syncOutputVisibility();
    }

    enableEpgChk.addEventListener('change', syncCustomEpgVisibility);
    epgModeRadios().forEach(r => r.addEventListener('change', syncCustomEpgVisibility));
    syncCustomEpgVisibility();

    function validateUrl(u) {
        try {
            const parsed = new URL(u);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
            return false;
        }
    }

    function normalizedBaseUrl(raw) {
        if (!raw) return '';
        let s = raw.trim();
        if (s.endsWith('/')) s = s.slice(0, -1);
        return s;
    }

    async function fetchTextBrowser(url, phaseLabel) {
        appendDetail(`→ (Browser) Fetching ${phaseLabel}: ${url}`);
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) throw new Error(`${phaseLabel} HTTP ${res.status}`);
        const txt = await res.text();
        appendDetail(`✔ (Browser) ${phaseLabel} ${txt.length.toLocaleString()} bytes`);
        return txt;
    }

    async function fetchTextServer(url, purpose) {
        appendDetail(`→ (Server) Prefetch ${purpose}: ${url}`);
        const res = await fetch('/api/prefetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, purpose })
        });
        let payload = {};
        try { payload = await res.json(); } catch { }
        if (!res.ok) {
            const msg = payload.error || `HTTP ${res.status}`;
            const detail = payload.detail ? ` (${payload.detail})` : '';
            throw new Error(`Server prefetch failed ${res.status} - ${msg}${detail}`);
        }
        if (!payload.ok || !payload.content) throw new Error('Server prefetch empty content');
        appendDetail(`✔ (Server) ${purpose} ${payload.bytes.toLocaleString()} bytes${payload.truncated ? ' (truncated)' : ''}`);
        return payload.content;
    }

    async function robustFetch(url, purpose, browserFirst = true) {
        if (browserFirst) {
            try {
                return await fetchTextBrowser(url, purpose);
            } catch (e) {
                appendDetail(`⚠ Browser fetch failed (${e.message}) → server fallback`);
            }
        }
        return await fetchTextServer(url, purpose);
    }

    function parseM3U(content) {
        const start = performance.now();
        const lines = content.split('\n');
        const items = [];
        let current = null;
        let processed = 0;
        for (const raw of lines) {
            const line = raw.trim();
            if (line.startsWith('#EXTINF:')) {
                const m = line.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
                if (m) {
                    current = {
                        duration: parseInt(m[1]),
                        attrs: parseAttrs(m[2] || ''),
                        name: (m[3] || '').trim()
                    };
                }
            } else if (line && !line.startsWith('#') && current) {
                current.url = line;
                items.push(current);
                current = null;
            }
            processed++;
            if (processed % 1500 === 0) appendDetail(`… parsed ${processed}/${lines.length}`);
        }
        appendDetail(`✔ Playlist parsed: ${items.length} entries (${(performance.now() - start).toFixed(1)} ms)`);
        return items;
    }

    function parseAttrs(str) {
        const out = {};
        const r = /(\w+(?:-\w+)*)="([^"]*)"/g;
        let m;
        while ((m = r.exec(str)) !== null) out[m[1]] = m[2];
        return out;
    }

    function quickEpgStats(xml) {
        const prog = xml.match(/<programme\s/gi);
        const ch   = xml.match(/<channel\s/gi);
        return {
            programmes: prog ? prog.length : 0,
            channels: ch ? ch.length : 0
        };
    }

    function uuid() {
        return (crypto && crypto.randomUUID)
            ? crypto.randomUUID()
            : 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    }

    async function sha256Fragment(str) {
        try {
            const enc = new TextEncoder().encode(str);
            const digest = await crypto.subtle.digest('SHA-256', enc);
            const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
            return hex.slice(0, 10) + '…';
        } catch {
            return '(hash-unavailable)';
        }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const baseUrlRaw  = xtreamUrlInput.value.trim();
        const baseUrl     = normalizedBaseUrl(baseUrlRaw);
        const username    = userInput.value.trim();
        let password      = pwdInput.value;
        const useM3U      = useM3UChk.checked;
        const outputFmt   = outputInput.value.trim();
        const enableEpgInitial = enableEpgChk.checked;
        const epgMode     = enableEpgInitial ? selectedEpgMode() : 'disabled';
        const customEpg   = (epgMode === 'custom') ? customEpgUrlInp.value.trim() : '';
        const epgOffset   = epgOffsetInput.value ? parseFloat(epgOffsetInput.value) : 0;
        const debug       = !!(debugChk && debugChk.checked);

        if (!validateUrl(baseUrl)) {
            alert('Invalid Xtream base URL');
            return;
        }
        if (!username || !password) {
            alert('Username / password required');
            return;
        }
        if (password === '********' && pwdInput.dataset.original) {
            password = pwdInput.dataset.original;
        }

        if (epgMode === 'custom' && enableEpgInitial) {
            if (!customEpg) {
                alert('Custom EPG URL is empty');
                return;
            }
            if (!validateUrl(customEpg)) {
                alert('Invalid Custom EPG URL');
                return;
            }
        }

        showOverlay(true);
        forceDisableActions && forceDisableActions();
        overlaySetMessage('Pre-flight: Validating Xtream inputs…');
        setProgress(5, 'Starting');
        appendDetail('== PRE-FLIGHT (XTREAM) ==');
        appendDetail(`Base URL: ${baseUrl}`);
        appendDetail(`Mode: ${useM3U ? 'M3U (m3u_plus)' : 'JSON API'}`);
        appendDetail(`EPG Mode: ${enableEpgInitial ? (epgMode === 'custom' ? 'Custom URL' : 'Panel XMLTV') : 'Disabled'}`);
        appendDetail(`Debug logging: ${debug ? 'enabled' : 'disabled'}`);

        let enableEpgFinal = enableEpgInitial;
        try {
            let liveCount = 0;
            let vodCount  = 0;
            let categories = new Set();
            let epgStats = { programmes: 0, channels: 0 };

            if (useM3U) {
                setProgress(12, 'Fetching Playlist');
                const m3uEndpoint =
                    `${baseUrl}/get.php?username=${encodeURIComponent(username)}` +
                    `&password=${encodeURIComponent(password)}` +
                    `&type=m3u_plus` +
                    (outputFmt ? `&output=${encodeURIComponent(outputFmt)}` : '');
                let playlist;
                try {
                    playlist = await robustFetch(m3uEndpoint, 'playlist', true);
                } catch (firstErr) {
                    appendDetail(`⚠ Initial playlist fetch failed: ${firstErr.message}`);
                    playlist = await robustFetch(m3uEndpoint, 'playlist', false);
                }
                setProgress(28, 'Parsing Playlist');
                const items = parseM3U(playlist);
                if (!items.length) throw new Error('Empty playlist (m3u_plus)');
                for (const it of items) {
                    const cat = it.attrs && (it.attrs['group-title'] || '').trim();
                    if (cat) categories.add(cat);
                }
                liveCount = items.filter(i => !/movie/i.test(i.name) && !/\(\d{4}\)/.test(i.name)).length;
                vodCount  = items.length - liveCount;
                appendDetail(`Heuristic: ~${liveCount} live / ~${vodCount} vod`);
            } else {
                const base = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
                setProgress(12, 'Fetching Live Streams');
                let liveJsonText;
                try {
                    liveJsonText = await robustFetch(`${base}&action=get_live_streams`, 'live_streams', true);
                } catch (lErr) {
                    appendDetail(`⚠ Live streams browser fetch failed: ${lErr.message}`);
                    liveJsonText = await robustFetch(`${base}&action=get_live_streams`, 'live_streams', false);
                }
                let liveList = [];
                try { liveList = JSON.parse(liveJsonText); } catch { throw new Error('Failed to parse live streams JSON'); }
                liveCount = Array.isArray(liveList) ? liveList.length : 0;
                appendDetail(`✔ Live streams: ${liveCount.toLocaleString()}`);

                setProgress(28, 'Fetching VOD Streams');
                let vodJsonText;
                try {
                    vodJsonText = await robustFetch(`${base}&action=get_vod_streams`, 'vod_streams', true);
                } catch (vErr) {
                    appendDetail(`⚠ VOD browser fetch failed: ${vErr.message}`);
                    vodJsonText = await robustFetch(`${base}&action=get_vod_streams`, 'vod_streams', false);
                }
                let vodList = [];
                try { vodList = JSON.parse(vodJsonText); } catch { throw new Error('Failed to parse VOD streams JSON'); }
                vodCount = Array.isArray(vodList) ? vodList.length : 0;
                appendDetail(`✔ VOD streams: ${vodCount.toLocaleString()}`);

                if (Array.isArray(liveList)) {
                    for (const l of liveList) {
                        const c = l.category_name || l.category || '';
                        if (c) categories.add(c);
                    }
                }
                if (Array.isArray(vodList)) {
                    for (const v of vodList) {
                        const c = v.category_name || v.category || '';
                        if (c) categories.add(c);
                    }
                }
            }

            if (enableEpgInitial) {
                const epgSourceUrl = (epgMode === 'custom')
                    ? customEpgUrlInp.value.trim()
                    : `${baseUrl}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

                setProgress(44, 'Fetching EPG');
                let epgTxt = null;
                try {
                    try {
                        epgTxt = await robustFetch(epgSourceUrl, 'epg', true);
                    } catch (firstEpgErr) {
                        appendDetail(`⚠ EPG browser fetch failed: ${firstEpgErr.message} → server fallback`);
                        epgTxt = await robustFetch(epgSourceUrl, 'epg', false);
                    }
                } catch (finalEpgErr) {
                    appendDetail(`✖ EPG fetch failed after both attempts (${finalEpgErr.message}) – continuing WITHOUT EPG`);
                    enableEpgFinal = false;
                }

                if (enableEpgFinal && epgTxt) {
                    setProgress(52, 'Scanning EPG');
                    epgStats = quickEpgStats(epgTxt);
                    appendDetail(`✔ EPG scan: ${epgStats.programmes.toLocaleString()} programmes / ${epgStats.channels.toLocaleString()} channels`);
                }
            } else {
                appendDetail('EPG disabled by user.');
            }

            setProgress(60, 'Building token');
            const config = {
                provider: 'xtream',
                xtreamUrl: baseUrl,
                xtreamUsername: username,
                xtreamPassword: password,
                enableEpg: enableEpgFinal,
                debug: debug || undefined
            };
            if (useM3U) config.xtreamUseM3U = true;
            if (useM3U && outputFmt) config.xtreamOutput = outputFmt;
            if (enableEpgFinal && epgMode === 'custom' && customEpgUrlInp.value.trim()) {
                config.epgUrl = customEpgUrlInp.value.trim();
            }
            if (isFinite(epgOffset) && epgOffset !== 0) config.epgOffsetHours = epgOffset;

            config.prescan = {
                liveCount,
                vodCount,
                categoryCount: categories.size,
                epgProgrammes: enableEpgFinal ? epgStats.programmes : 0,
                epgChannels: enableEpgFinal ? epgStats.channels : 0,
                mode: useM3U ? 'm3u_plus' : 'json',
                epgSource: enableEpgFinal
                    ? (epgMode === 'custom' ? 'custom' : 'xtream')
                    : 'disabled'
            };

            config.instanceId = config.instanceId || uuid();

            const passHash = await sha256Fragment(password);
            appendDetail(`Password hash fragment: ${passHash}`);

            const { manifestUrl, stremioUrl } = buildUrls(config);
            appendDetail('✔ Token built');
            appendDetail('Manifest URL: ' + manifestUrl);
            appendDetail('Stremio URL: ' + stremioUrl);

            setProgress(70, 'Waiting for manifest');
            appendDetail('== SERVER BUILD PHASE ==');
            appendDetail('Polling server…');
            startPolling(70);

        } catch (err) {
            console.error('[XTREAM-CONFIG] Pre-flight error', err);
            overlaySetMessage('Pre-flight failed');
            appendDetail('✖ Error: ' + (err.message || err.toString()));
            setProgress(100, 'Failed');
            appendDetail('Close overlay and adjust inputs to retry.');

            const status = document.getElementById('statusDetails');
            if (status && !document.getElementById('retryCloseXtreamBtn')) {
                const btn = document.createElement('button');
                btn.id = 'retryCloseXtreamBtn';
                btn.textContent = 'Close';
                btn.className = 'btn danger';
                btn.style.marginTop = '14px';
                btn.onclick = hideOverlay;
                status.parentElement.appendChild(btn);
            }
        }
    });
})();