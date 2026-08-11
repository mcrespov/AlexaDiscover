'use strict';
// Vuelca en data/ el estado actual de tu cuenta Alexa: dispositivos, grupos
// y el arbol de salas. Es de solo lectura (ninguna llamada modifica nada).
// Sirve para (a) entender el esquema real que usa tu cuenta antes de escribir
// la logica de apply.js, y (b) generar la plantilla mapping.csv para rellenar.

const fs = require('fs');
const path = require('path');
const { initAlexa, writeJson, DATA_DIR, loadSnapshot, saveSnapshot } = require('./common');

// Quita acentos/diacriticos y normaliza mayusculas/espacios, para poder
// emparejar "Termometro" con "Termómetro" tras un reemparejamiento del bridge.
function normalizeName(s) {
    return (s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

// Busca `name` en el snapshot: primero exacto, si no por nombre normalizado.
function findSnapshotEntry(snapshot, name) {
    if (snapshot[name]) return { key: name, entry: snapshot[name], exact: true };
    const norm = normalizeName(name);
    const key = Object.keys(snapshot).find(k => normalizeName(k) === norm);
    return key ? { key, entry: snapshot[key], exact: false } : null;
}

function call(alexa, method, ...args) {
    return new Promise((resolve, reject) => {
        alexa[method](...args, (err, res) => (err ? reject(err) : resolve(res)));
    });
}

// getSmarthomeGroups/getSmarthomeEntities no aceptan args extra, pero httpsGet si.
function httpsGet(alexa, path_) {
    return new Promise((resolve, reject) => {
        alexa.httpsGet(path_, (err, res) => (err ? reject(err) : resolve(res)));
    });
}

(async () => {
    let alexa;
    try {
        alexa = await initAlexa();
    } catch (err) {
        console.error('Error de conexion:', err.message || err);
        process.exit(1);
    }

    console.log('Conectado. Descargando datos...');

    const results = {};
    const steps = [
        ['entities', () => call(alexa, 'getSmarthomeEntities')],
        ['groups', () => call(alexa, 'getSmarthomeGroups')],
        ['devicesV2', () => call(alexa, 'getSmarthomeDevicesV2')],
        ['phoenixRaw', () => httpsGet(alexa, '/api/phoenix')],
    ];

    for (const [name, fn] of steps) {
        try {
            results[name] = await fn();
            const file = writeJson(`${name}.json`, results[name]);
            console.log(`OK  ${name} -> ${path.relative(process.cwd(), file)}`);
        } catch (err) {
            console.log(`FALLO ${name}: ${err.message || err}`);
        }
    }

    // Dispositivos "locales" (Matter/Zigbee2MQTT/etc. vistos por Alexa via el
    // bridge local, driverIdentity.namespace === 'AAA') se distinguen de los
    // que llegan por una Alexa Smart Home Skill clasica (namespace 'SKILL').
    // Es el filtro fiable: el bridge Matter de Home Assistant cae aqui.
    const devices = Array.isArray(results.devicesV2) ? results.devicesV2 : [];
    const localDevices = devices.filter(d => {
        const la = d.legacyAppliance;
        return la && la.driverIdentity && la.driverIdentity.namespace === 'AAA';
    });

    // La entidad del propio bridge (applianceTypes incluye "HUB") no es un
    // dispositivo asignable a una sala: es el puente en si. Ademas Alexa la
    // devuelve con un friendlyName erroneo (el de uno de sus hijos), asi que
    // se excluye del CSV/snapshot y se deja aparte solo como referencia.
    const bridgeDevices = localDevices.filter(d => !(d.legacyAppliance.applianceTypes || []).includes('HUB'));
    const hubDevices = localDevices.filter(d => (d.legacyAppliance.applianceTypes || []).includes('HUB'));

    // Mapa applianceId -> [nombres de sala] a partir de los grupos tipo SPACE.
    const rooms = ((results.groups && results.groups.applianceGroups) || []).filter(g => g.type === 'SPACE');
    const roomsByApplianceId = new Map();
    for (const room of rooms) {
        for (const id of room.applianceIds || []) {
            if (!roomsByApplianceId.has(id)) roomsByApplianceId.set(id, []);
            roomsByApplianceId.get(id).push(room.name);
        }
    }

    if (hubDevices.length) {
        const hubInfo = hubDevices.map(d => {
            const la = d.legacyAppliance;
            return {
                applianceId: la.applianceId,
                alexaLabel: d.friendlyName || '',
                manufacturer: la.manufacturerName || '',
                currentRoom: (roomsByApplianceId.get(la.applianceId) || []).join(';'),
            };
        });
        writeJson('hub-info.json', hubInfo);
        console.log(`\nEntidad(es) HUB del bridge excluida(s) del mapeo (ver data/hub-info.json):`);
        for (const h of hubInfo) console.log(`  - ${h.applianceId} (etiqueta en Alexa: "${h.alexaLabel}", sala actual: ${h.currentRoom || '(ninguna)'})`);

        // Limpieza: si una etiqueta erronea de un HUB se guardo antes en el
        // snapshot como si fuera un dispositivo real, se retira.
        const snap = loadSnapshot();
        let cleaned = false;
        for (const h of hubInfo) {
            if (h.alexaLabel && snap[h.alexaLabel]) {
                delete snap[h.alexaLabel];
                cleaned = true;
            }
        }
        if (cleaned) {
            saveSnapshot(snap);
            console.log('Se ha limpiado del historico (room-snapshot.json) la etiqueta erronea del HUB.');
        }
    }

    // El snapshot recuerda, por NOMBRE de dispositivo, la ultima sala conocida.
    // Sobrevive a un borrado/reemparejamiento del bridge Matter (los applianceId
    // cambian, el nombre normalmente no). Cada discover actualiza lo que ve
    // asignado ahora mismo, y rellena targetRoom con el historico para lo que
    // reaparezca sin sala todavia.
    const snapshot = loadSnapshot();
    const now = new Date().toISOString();

    const rows = [['applianceId', 'name', 'manufacturer', 'currentRoom', 'targetRoom']];
    let fromHistory = 0;
    let fromFuzzyMatch = 0;
    const fuzzyMatches = [];
    for (const d of bridgeDevices) {
        const la = d.legacyAppliance;
        const name = d.friendlyName || '';
        const current = roomsByApplianceId.get(la.applianceId) || [];

        if (current.length === 1) {
            // Si el nombre cambio ligeramente (tildes, mayusculas...) respecto a
            // lo guardado, se sustituye la entrada antigua por la nueva grafia
            // en vez de acumular una clave duplicada.
            const existing = findSnapshotEntry(snapshot, name);
            if (existing && !existing.exact && existing.key !== name) delete snapshot[existing.key];
            snapshot[name] = { room: current[0], manufacturer: la.manufacturerName || '', updatedAt: now };
        }

        let targetRoom = current.length === 1 ? current[0] : '';
        if (!targetRoom) {
            const match = findSnapshotEntry(snapshot, name);
            if (match) {
                targetRoom = match.entry.room;
                fromHistory++;
                if (!match.exact) {
                    fromFuzzyMatch++;
                    fuzzyMatches.push(`${name}  <-  ${match.key}`);
                }
            }
        }

        rows.push([la.applianceId, name, la.manufacturerName || '', current.join(';'), targetRoom]);
    }
    saveSnapshot(snapshot);

    const mappingFile = path.join(DATA_DIR, 'mapping.template.csv');
    fs.writeFileSync(mappingFile, rows.map(r => r.map(csvEscape).join(',')).join('\n'));
    console.log(`\nPlantilla de mapeo generada en ${path.relative(process.cwd(), mappingFile)} (${rows.length - 1} dispositivos del bridge local detectados de ${devices.length} totales)`);
    console.log(`Salas (grupos tipo SPACE) encontradas: ${rooms.map(r => r.name).join(', ')}`);
    if (fromHistory) console.log(`targetRoom autocompletado desde el historico (data/room-snapshot.json) para ${fromHistory} dispositivo(s) sin sala actual.`);
    if (fromFuzzyMatch) {
        console.log(`De esos, ${fromFuzzyMatch} se emparejaron ignorando tildes/mayusculas (revisa que sean el mismo dispositivo):`);
        for (const m of fuzzyMatches) console.log(`  - ${m}`);
    }

    const noRoom = bridgeDevices.filter(d => {
        const la = d.legacyAppliance;
        const current = roomsByApplianceId.get(la.applianceId) || [];
        return current.length === 0 && !findSnapshotEntry(snapshot, d.friendlyName || '');
    });
    if (noRoom.length) {
        console.log(`\nSin sala asignada ni en el historico (${noRoom.length}) -- hay que asignarlas a mano en mapping.csv:`);
        for (const d of noRoom) console.log(`  - ${d.friendlyName}`);
    }

    process.exit(0);
})();

function csvEscape(value) {
    const s = String(value == null ? '' : value);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
