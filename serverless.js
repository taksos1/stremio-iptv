const { getRouter } = require("stremio-addon-sdk");
const createAddon = require("./addon");

let cachedInterface = null;
let cachedConfigKey = null;

async function getInterface(eventConfig = {}) {
    const key = JSON.stringify(eventConfig);
    if (cachedInterface && cachedConfigKey === key) {
        return cachedInterface;
    }
    cachedInterface = await createAddon(eventConfig);
    cachedConfigKey = key;
    return cachedInterface;
}

module.exports = async function (req, res) {
    try {
        const addonInterface = await getInterface();
        const router = getRouter(addonInterface);
        router(req, res, function () {
            res.statusCode = 404;
            res.end();
        });
    } catch (e) {
        console.error('[SERVERLESS] Error:', e);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Serverless addon error' }));
    }
};