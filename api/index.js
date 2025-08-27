const { getRouter } = require("stremio-addon-sdk");
const createAddon = require("../addon");
const { tryParseConfigToken } = require("../cryptoConfig");
const path = require("path");
const fs = require("fs");

// Cache for interfaces
const interfaceCache = new Map();

function isConfigToken(token) {
    if (!token) return false;
    if (token.startsWith('enc:')) return true;
    if (token.length < 8) return false;
    return true;
}

function maybeDecryptConfig(token) {
    return tryParseConfigToken(token);
}

module.exports = async function (req, res) {
    try {
        const url = new URL(req.url, `https://${req.headers.host}`);
        const pathSegments = url.pathname.split('/').filter(Boolean);

        // Handle root configuration page
        if (pathSegments.length === 0) {
            const configHtml = fs.readFileSync(path.join(__dirname, '../configure.html'), 'utf8');
            res.setHeader('Content-Type', 'text/html');
            res.statusCode = 200;
            res.end(configHtml);
            return;
        }

        // Handle static assets
        if (pathSegments[0] === 'configure.css' || pathSegments[0] === 'configure.js') {
            const filePath = path.join(__dirname, '../public', pathSegments[0]);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                const contentType = pathSegments[0].endsWith('.css') ? 'text/css' : 'application/javascript';
                res.setHeader('Content-Type', contentType);
                res.statusCode = 200;
                res.end(content);
                return;
            }
        }

        // Handle health check
        if (pathSegments[0] === 'health') {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 200;
            res.end(JSON.stringify({ status: 'OK', timestamp: new Date().toISOString() }));
            return;
        }

        // Handle token-based requests
        const token = pathSegments[0];
        if (!isConfigToken(token)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Invalid token' }));
            return;
        }

        // Handle reconfigure
        if (pathSegments[1] === 'configure') {
            const configHtml = fs.readFileSync(path.join(__dirname, '../configure.html'), 'utf8');
            res.setHeader('Content-Type', 'text/html');
            res.statusCode = 200;
            res.end(configHtml);
            return;
        }

        // Parse config from token
        let config;
        try {
            config = maybeDecryptConfig(token);
        } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Invalid configuration token' }));
            return;
        }

        // Get or create addon interface
        const cacheKey = token;
        let addonInterface = interfaceCache.get(cacheKey);
        
        if (!addonInterface) {
            addonInterface = await createAddon(config);
            interfaceCache.set(cacheKey, addonInterface);
        }

        // Handle logo requests
        if (pathSegments[1] === 'logo' && pathSegments[2]) {
            res.statusCode = 302;
            res.setHeader('Location', `https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(pathSegments[2].replace('.png', ''))}`);
            res.end();
            return;
        }

        // Route to Stremio addon
        const router = getRouter(addonInterface);
        
        // Adjust URL to remove token prefix
        const newPath = '/' + pathSegments.slice(1).join('/');
        req.url = newPath || '/';
        
        router(req, res, function () {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Not found' }));
        });
        
    } catch (e) {
        console.error('[SERVERLESS] Error:', e);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Serverless addon error' }));
    }
};
