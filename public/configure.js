/* Enhanced configuration page logic with loader & manifest polling + EPG offset */

(function () {
    const methodTabs = document.querySelectorAll('.method-tab');
    const sections = document.querySelectorAll('.config-section');
    const methodTitle = document.getElementById('method-title');
    const methodDescription = document.getElementById('method-description');

    const methodInfo = {
        direct: {
            title: 'Direct M3U & EPG Links',
            description: 'Use direct URLs to your M3U playlist and EPG XML files.'
        },
        xtream: {
            title: 'Xtream Codes API',
            description: 'Use Xtream credentials to fetch your playlist and EPG.'
        }
    };

    function switchMethod(m) {
        methodTabs.forEach(t => t.classList.remove('active'));
        const tab = document.querySelector(`.method-tab[data-method="${m}"]`);
        if (tab) tab.classList.add('active');

        sections.forEach(s => s.classList.remove('active'));
        const section = document.getElementById(`${m}-section`);
        if (section) section.classList.add('active');

        methodTitle.textContent = methodInfo[m].title;
        methodDescription.textContent = methodInfo[m].description;
        updateRequired(m);
    }

    methodTabs.forEach(tab => tab.addEventListener('click', () => switchMethod(tab.dataset.method)));

    function updateRequired(m) {
        document.querySelectorAll('#direct-section input, #xtream-section input')
            .forEach(i => i.removeAttribute('required'));
        if (m === 'direct') {
            document.getElementById('m3uUrl').setAttribute('required', '');
        } else {
            document.getElementById('xtreamUrl').setAttribute('required', '');
            document.getElementById('xtreamUsername').setAttribute('required', '');
            document.getElementById('xtreamPassword').setAttribute('required', '');
        }
    }

    const xtreamUseM3U = document.getElementById('xtreamUseM3U');
    const xtreamOutputGroup = document.getElementById('xtreamOutputGroup');
    if (xtreamUseM3U) {
        xtreamUseM3U.addEventListener('change', () => {
            xtreamOutputGroup.style.display = xtreamUseM3U.checked ? 'block' : 'none';
        });
    }

    const pwdInput = document.getElementById('xtreamPassword');
    const togglePwd = document.getElementById('togglePwd');
    if (togglePwd && pwdInput) {
        togglePwd.addEventListener('click', e => {
            e.preventDefault();
            if (pwdInput.type === 'password') {
                pwdInput.type = 'text';
                togglePwd.textContent = 'Hide';
            } else {
                pwdInput.type = 'password';
                togglePwd.textContent = 'Show';
            }
        });
    }

    // Prefill on reconfigure (added epgOffsetHours)
    (function prefill() {
        const parts = window.location.pathname.split('/').filter(Boolean);
        if (parts.length >= 2 && parts[1] === 'configure') {
            const token = parts[0];
            if (!token.startsWith('enc:')) {
                try {
                    const cfg = JSON.parse(atob(token));
                    if (cfg.useXtream) {
                        switchMethod('xtream');
                        if (cfg.xtreamUrl) document.getElementById('xtreamUrl').value = cfg.xtreamUrl;
                        if (cfg.xtreamUsername) document.getElementById('xtreamUsername').value = cfg.xtreamUsername;
                        if (cfg.xtreamPassword) {
                            pwdInput.dataset.original = cfg.xtreamPassword;
                            pwdInput.value = '********';
                        }
                        if (cfg.xtreamUseM3U) {
                            xtreamUseM3U.checked = true;
                            xtreamOutputGroup.style.display = 'block';
                        }
                        if (cfg.xtreamOutput) document.getElementById('xtreamOutput').value = cfg.xtreamOutput;
                    } else {
                        switchMethod('direct');
                        if (cfg.m3uUrl) document.getElementById('m3uUrl').value = cfg.m3uUrl;
                        if (cfg.epgUrl) document.getElementById('epgUrl').value = cfg.epgUrl;
                    }
                    document.getElementById('enableEpg').checked = !!cfg.enableEpg;
                    if (typeof cfg.epgOffsetHours === 'number') {
                        document.getElementById('epgOffsetHours').value = cfg.epgOffsetHours;
                    }
                } catch (e) {
                    console.warn('Config decode failed (likely encrypted token):', e.message);
                }
            } else {
                console.log('Encrypted config: cannot prefill client-side.');
            }
        }
    })();

    // Loader elements (unchanged from previous enhancement)
    const overlay = document.getElementById('loaderOverlay');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const loaderMessage = document.getElementById('loaderMessage');
    const loaderBox = document.querySelector('.loader-box');
    const statusDetails = document.getElementById('statusDetails');
    const copyBtn = document.getElementById('copyManifestBtn');
    const openBtn = document.getElementById('openStremioBtn');
    const cancelLoaderBtn = document.getElementById('cancelLoaderBtn');

    const POLL_INTERVAL_MS = 1500;
    const MAX_WAIT_MS = 90000;
    const PROGRESS_ESTIMATE_MS = 45000;

    let pollTimer = null;
    let autoOpened = false;
    let manifestUrlGlobal = '';
    let stremioUrlGlobal = '';
    let startTime = 0;

    function showOverlay() {
        overlay.classList.remove('hidden');
        loaderBox.classList.remove('success', 'error');
        setProgress(0, 'Starting…');
        statusDetails.textContent = '';
        openBtn.disabled = true;
        copyBtn.disabled = true;
    }

    function hideOverlay() {
        overlay.classList.add('hidden');
    }

    function setProgress(pct, text) {
        progressBar.style.width = Math.min(100, pct) + '%';
        if (text) progressText.textContent = text;
    }

    function copyManifest() {
        if (!manifestUrlGlobal) return;
        navigator.clipboard.writeText(manifestUrlGlobal)
            .then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => copyBtn.textContent = 'Copy Manifest URL', 1800);
            })
            .catch(() => {
                copyBtn.textContent = 'Copy Failed';
                setTimeout(() => copyBtn.textContent = 'Copy Manifest URL', 1800);
            });
    }

    copyBtn.addEventListener('click', copyManifest);
    openBtn.addEventListener('click', () => {
        if (!stremioUrlGlobal) return;
        window.location.href = stremioUrlGlobal;
    });
    cancelLoaderBtn.addEventListener('click', hideOverlay);

    function startPolling() {
        startTime = Date.now();
        attemptPoll();
    }

    function attemptPoll() {
        const elapsed = Date.now() - startTime;
        if (parseFloat(progressBar.style.width) < 95) {
            const synthetic = Math.min(95, (elapsed / PROGRESS_ESTIMATE_MS) * 95);
            if (!loaderBox.classList.contains('success') && !loaderBox.classList.contains('error')) {
                setProgress(synthetic, progressMessage(elapsed));
            }
        }
        fetch(manifestUrlGlobal + '?_=' + Date.now(), { cache: 'no-store' })
            .then(r => r.ok ? r.json() : Promise.reject(r.status))
            .then(json => {
                if (json && json.id) {
                    loaderBox.classList.add('success');
                    setProgress(100, 'Ready');
                    statusDetails.textContent = 'Manifest fetched successfully.\nYou can now install the addon in Stremio.';
                    loaderMessage.textContent = 'Playlist parsed successfully.';
                    copyBtn.disabled = false;
                    openBtn.disabled = false;
                    if (!autoOpened) {
                        autoOpened = true;
                        window.location.href = stremioUrlGlobal;
                    }
                    if (pollTimer) clearTimeout(pollTimer);
                    return;
                }
                scheduleNext(elapsed);
            })
            .catch(() => scheduleNext(elapsed));
    }

    function scheduleNext(elapsed) {
        if (elapsed > MAX_WAIT_MS) {
            loaderBox.classList.add('error');
            loaderMessage.textContent = 'Taking longer than expected.';
            statusDetails.textContent = 'You can still try opening Stremio or copy the manifest URL.\nIf installation fails now, wait a bit and retry.';
            copyBtn.disabled = false;
            openBtn.disabled = false;
            setProgress(100, 'Fallback Ready');
            return;
        }
        pollTimer = setTimeout(attemptPoll, POLL_INTERVAL_MS);
    }

    function progressMessage(elapsed) {
        if (elapsed < 4000) return 'Downloading playlist…';
        if (elapsed < 10000) return 'Parsing channels…';
        if (elapsed < 18000) return 'Detecting movies & grouping…';
        if (elapsed < 26000) return 'Fetching EPG (if enabled)…';
        if (elapsed < 35000) return 'Parsing EPG data…';
        if (elapsed < 45000) return 'Finalizing manifest…';
        return 'Almost done…';
    }

    document.getElementById('configForm').addEventListener('submit', async e => {
        e.preventDefault();
        const activeMethod = document.querySelector('.method-tab.active').dataset.method;
        const formData = new FormData(e.target);
        const config = {};
        config.useXtream = activeMethod === 'xtream';

        const directFields = ['m3uUrl', 'epgUrl'];
        const xtreamFields = ['xtreamUrl', 'xtreamUsername', 'xtreamPassword', 'xtreamOutput'];

        directFields.forEach(f => {
            const v = formData.get(f);
            if (v && activeMethod === 'direct') config[f] = v.trim();
        });

        xtreamFields.forEach(f => {
            let v = formData.get(f);
            if (v && activeMethod === 'xtream') {
                v = v.trim();
                if (f === 'xtreamPassword' && v === '********' && pwdInput.dataset.original) {
                    v = pwdInput.dataset.original;
                }
                if (v) config[f] = v;
            }
        });

        config.enableEpg = formData.has('enableEpg');
        if (formData.has('xtreamUseM3U')) config.xtreamUseM3U = true;

        const epgOffsetRaw = formData.get('epgOffsetHours');
        if (epgOffsetRaw !== null && epgOffsetRaw.trim() !== '') {
            const num = parseFloat(epgOffsetRaw);
            if (!isNaN(num) && isFinite(num) && Math.abs(num) < 48) {
                config.epgOffsetHours = num;
            }
        }

        if (!config.instanceId) {
            config.instanceId = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
        }

        const token = btoa(JSON.stringify(config));
        const origin = window.location.origin;
        const host = window.location.host;
        manifestUrlGlobal = `${origin}/${token}/manifest.json`;
        stremioUrlGlobal = `stremio://${host}/${token}/manifest.json`;

        showOverlay();
        copyBtn.disabled = false;
        statusDetails.textContent = 'We are preparing your addon instance.\nPlease keep this tab open.';
        startPolling();
    });

    switchMethod('direct');
})();