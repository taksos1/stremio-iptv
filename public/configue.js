/* Configuration page logic (extracted from inline script) */

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

    // Prefill logic for reconfigure
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
                } catch (e) {
                    console.warn('Config decode failed (likely encrypted token):', e.message);
                }
            } else {
                console.log('Encrypted config: cannot prefill client-side.');
            }
        }
    })();

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

        if (!config.instanceId) {
            config.instanceId = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
        }

        // Base64 encode (server may also offer /encrypt; this version keeps your original behavior)
        const token = btoa(JSON.stringify(config));
        const manifestUrl = `${window.location.origin}/${token}/manifest.json`;
        const stremioUrl = `stremio://${window.location.host}/${token}/manifest.json`;

        window.location.href = stremioUrl;
        setTimeout(() => {
            alert(`If Stremio did not open, copy this URL:\n\n${manifestUrl}`);
        }, 1500);
    });

    // Initialize defaults
    switchMethod('direct');
})();