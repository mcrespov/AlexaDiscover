'use strict';
const fs = require('fs');
const path = require('path');
const Alexa = require('alexa-remote2');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const COOKIE_FILE = path.join(DATA_DIR, 'alexa-cookie.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'room-snapshot.json');

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        throw new Error('Falta config.json. Copia config.example.json a config.json y ajusta amazonPage a tu dominio de Amazon (amazon.es, amazon.de, amazon.com, ...).');
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function loadCookie() {
    if (!fs.existsSync(COOKIE_FILE)) return null;
    return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
}

function saveCookie(cookieData) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookieData, null, 2));
}

function baseAlexaOptions(config) {
    return {
        proxyOnly: true,
        proxyOwnIp: config.proxyOwnIp || 'localhost',
        proxyPort: config.proxyPort || 3001,
        proxyLogLevel: 'warn',
        bluetooth: false,
        useWsMqtt: false,
        amazonPage: config.amazonPage || 'amazon.es',
        acceptLanguage: config.acceptLanguage || 'es-ES',
        cookieRefreshInterval: 0,
    };
}

// Para uso en discover.js / apply.js: requiere que ya exista sesion guardada (npm run login).
function initAlexa() {
    const config = loadConfig();
    const savedCookie = loadCookie();

    if (!savedCookie) {
        throw new Error('No hay sesion guardada todavia. Ejecuta primero: npm run login');
    }

    const alexa = new Alexa();

    return new Promise((resolve, reject) => {
        alexa.on('cookie', () => saveCookie(alexa.cookieData));

        alexa.init(Object.assign(baseAlexaOptions(config), { cookie: savedCookie }), (err) => {
            if (err) return reject(err);
            resolve(alexa);
        });
    });
}

// name -> { room, manufacturer, updatedAt } : ultima sala conocida por nombre
// de dispositivo, para sobrevivir a un borrado/reemparejamiento del bridge
// Matter (los IDs internos cambian, el nombre normalmente no).
function loadSnapshot() {
    if (!fs.existsSync(SNAPSHOT_FILE)) return {};
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
}

function saveSnapshot(snapshot) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
}

function writeJson(fileName, data) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, fileName);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
}

module.exports = {
    ROOT, DATA_DIR, COOKIE_FILE, CONFIG_FILE, SNAPSHOT_FILE,
    loadConfig, loadCookie, saveCookie, baseAlexaOptions, initAlexa, writeJson,
    loadSnapshot, saveSnapshot,
};
