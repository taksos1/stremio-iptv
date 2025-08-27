require('dotenv').config();
const crypto = require('crypto');

function getSecret() {
    const secret = process.env.CONFIG_SECRET;
    if (!secret || secret.length < 16) return null; // weak / absent -> treat as no encryption
    return crypto.createHash('sha256').update(secret).digest(); // 32 bytes key
}

function encryptConfig(jsonStr) {
    const key = getSecret();
    if (!key) return null; // caller decides fallback
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, tag, ciphertext]);
    return 'enc:' + payload.toString('base64');
}

function decryptConfig(token) {
    const key = getSecret();
    if (!key) throw new Error('CONFIG_SECRET not set, cannot decrypt');
    if (!token.startsWith('enc:')) throw new Error('Not an encrypted token');
    const b64 = token.slice(4);
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 12 + 16 + 1) throw new Error('Invalid encrypted payload length');

    const iv = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const ciphertext = buf.slice(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
}

function tryParseConfigToken(token) {
    if (token.startsWith('enc:')) {
        const jsonStr = decryptConfig(token);
        return JSON.parse(jsonStr);
    }
    // Plain base64 JSON fallback
    let jsonStr;
    try {
        jsonStr = Buffer.from(token, 'base64').toString();
        return JSON.parse(jsonStr);
    } catch (e) {
        throw new Error('Invalid config token');
    }
}

module.exports = {
    encryptConfig,
    decryptConfig,
    tryParseConfigToken
};