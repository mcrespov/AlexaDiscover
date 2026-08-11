'use strict';
// Login interactivo unico. Arranca un proxy local: abres la URL en el navegador,
// inicias sesion en Amazon (con 2FA si aplica) y la sesion queda guardada en
// data/alexa-cookie.json para que discover.js / apply.js la reutilicen.
//
// IMPORTANT: data/alexa-cookie.json equivale a tener la sesion abierta de tu
// cuenta Amazon. Tratalo como una contrasena: no lo subas a git ni lo compartas.

const Alexa = require('alexa-remote2');
const { loadConfig, baseAlexaOptions, saveCookie } = require('./common');

const config = loadConfig();
const alexa = new Alexa();

alexa.on('cookie', () => saveCookie(alexa.cookieData));

console.log('Arrancando el proxy de login de Amazon...');

let urlPrinted = false;

alexa.init(baseAlexaOptions(config), (err) => {
    if (err) {
        const msg = err.message || String(err);
        const match = msg.match(/https?:\/\/\S+?\//);
        if (match && !urlPrinted) {
            urlPrinted = true;
            console.log('\n>>> Abre esta URL en un navegador de un PC/Mac SIN la app de Alexa instalada:');
            console.log('>>> ' + match[0] + '\n');
            console.log('>>> Inicia sesion con tu cuenta de Amazon (incluye 2FA si lo tienes activo).');
            console.log('Esperando a que completes el login...');
            return; // seguimos esperando, esto NO es un fallo definitivo
        }
        console.error('\nFallo el login:', msg);
        process.exit(1);
        return;
    }

    saveCookie(alexa.cookieData);
    console.log('\nLogin completado. Sesion guardada en data/alexa-cookie.json');
    console.log('Siguiente paso: npm run discover');
    process.exit(0);
});
