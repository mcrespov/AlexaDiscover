'use strict';
// Aplica data/mapping.csv (columnas: applianceId,name,currentGroups,targetRoom)
// asignando cada dispositivo a su grupo/sala en Alexa via PUT /api/phoenix/group/{id}.
//
// SIN --apply: solo calcula y muestra el plan (dry-run), no escribe nada.
// CON --apply: ejecuta los cambios de verdad.
// CON --create-missing: crea (POST) las salas del CSV que no existan aun como grupo.
//
// IMPORTANTE: el esquema de /api/phoenix/group (campos applianceIds/groupId/name)
// viene de ingenieria inversa de la app (no es una API documentada por Amazon).
// Antes de usar este script en serio, confirma en data/groups.json que esos
// campos existen tal cual para tu cuenta.

const fs = require('fs');
const path = require('path');
const { initAlexa, DATA_DIR } = require('./common');

const APPLY = process.argv.includes('--apply');
const CREATE_MISSING = process.argv.includes('--create-missing');
const MAPPING_FILE = path.join(DATA_DIR, 'mapping.csv');
const DELAY_MS = 800; // margen contra rate-limiting (429) de Amazon

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseCsv(text) {
    return text.trim().split('\n').map(line => {
        // parser simple: suficiente para nuestro CSV propio (sin comas dentro de campos salvo entre comillas)
        const out = [];
        let cur = '', inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (inQuotes) {
                if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
                else if (c === '"') inQuotes = false;
                else cur += c;
            } else {
                if (c === '"') inQuotes = true;
                else if (c === ',') { out.push(cur); cur = ''; }
                else cur += c;
            }
        }
        out.push(cur);
        return out;
    });
}

function httpsGet(alexa, path_, flags) {
    return new Promise((resolve, reject) => {
        alexa.httpsGet(path_, (err, res) => (err ? reject(err) : resolve(res)), flags);
    });
}

(async () => {
    if (!fs.existsSync(MAPPING_FILE)) {
        console.error(`No existe ${path.relative(process.cwd(), MAPPING_FILE)}.`);
        console.error('Copia data/mapping.template.csv (generado por npm run discover) a data/mapping.csv y rellena la columna targetRoom.');
        process.exit(1);
    }

    const rows = parseCsv(fs.readFileSync(MAPPING_FILE, 'utf8'));
    const header = rows.shift();
    const idx = {
        applianceId: header.indexOf('applianceId'),
        name: header.indexOf('name'),
        targetRoom: header.indexOf('targetRoom'),
    };
    if (idx.applianceId < 0 || idx.targetRoom < 0) {
        console.error('mapping.csv debe tener columnas applianceId y targetRoom.');
        process.exit(1);
    }

    const entries = rows
        .map(r => ({ applianceId: r[idx.applianceId], name: r[idx.name], targetRoom: (r[idx.targetRoom] || '').trim() }))
        .filter(e => e.applianceId && e.targetRoom);

    if (!entries.length) {
        console.log('No hay filas con targetRoom rellenado en mapping.csv. Nada que hacer.');
        process.exit(0);
    }

    const alexa = await initAlexa();
    console.log('Conectado. Releyendo grupos actuales...');
    const groupsRes = await new Promise((resolve, reject) =>
        alexa.getSmarthomeGroups((err, res) => (err ? reject(err) : resolve(res)))
    );
    const groups = groupsRes && groupsRes.applianceGroups;

    if (!Array.isArray(groups)) {
        console.error('getSmarthomeGroups no devolvio "applianceGroups" como se esperaba. Revisa data/groups.json (npm run discover) antes de continuar.');
        console.error('Respuesta recibida:', JSON.stringify(groupsRes).slice(0, 500));
        process.exit(1);
    }
    for (const g of groups) {
        if (!('groupId' in g) || !('applianceIds' in g) || !('name' in g)) {
            console.error('Los grupos de tu cuenta no tienen los campos esperados (groupId/applianceIds/name).');
            console.error('Ejemplo recibido:', JSON.stringify(g, null, 2).slice(0, 800));
            console.error('Hay que ajustar este script a tu esquema real antes de aplicar cambios.');
            process.exit(1);
        }
    }

    const groupByName = new Map(groups.map(g => [g.name.trim().toLowerCase(), g]));

    // agrupamos: sala -> set de applianceIds a asegurar presentes
    const wanted = new Map(); // roomNameLower -> { displayName, applianceIds:Set }
    const missingRooms = new Set();
    for (const e of entries) {
        const key = e.targetRoom.toLowerCase();
        if (!groupByName.has(key)) missingRooms.add(e.targetRoom);
        if (!wanted.has(key)) wanted.set(key, { displayName: e.targetRoom, applianceIds: new Set() });
        wanted.get(key).applianceIds.add(e.applianceId);
    }

    if (missingRooms.size && !CREATE_MISSING) {
        console.log('\nSalas en mapping.csv que NO existen como grupo en tu cuenta (no se tocaran):');
        for (const r of missingRooms) console.log(`  - ${r}`);
        console.log('Vuelve a ejecutar con --create-missing si quieres que este script las cree.\n');
    }

    const plan = [];
    for (const [key, { displayName, applianceIds }] of wanted) {
        const existingGroup = groupByName.get(key);
        if (!existingGroup) {
            if (!CREATE_MISSING) continue;
            plan.push({ type: 'create', name: displayName, add: [...applianceIds] });
            continue;
        }
        const current = new Set(existingGroup.applianceIds || []);
        const toAdd = [...applianceIds].filter(id => !current.has(id));
        if (toAdd.length) {
            plan.push({ type: 'update', group: existingGroup, add: toAdd });
        }
    }

    if (!plan.length) {
        console.log('No hay cambios pendientes: todo lo que pide mapping.csv ya esta reflejado en Alexa.');
        process.exit(0);
    }

    console.log(`\nPlan (${APPLY ? 'EJECUTANDO' : 'DRY-RUN, nada se escribe'}):`);
    for (const step of plan) {
        if (step.type === 'create') {
            console.log(`  [crear grupo] "${step.name}" con ${step.add.length} dispositivo(s)`);
        } else {
            console.log(`  [actualizar] "${step.group.name}" (${step.group.groupId}): +${step.add.length} dispositivo(s)`);
        }
    }

    if (!APPLY) {
        console.log('\nRevisa el plan. Si es correcto, repite con: node scripts/apply.js --apply');
        process.exit(0);
    }

    console.log('');
    for (const step of plan) {
        try {
            if (step.type === 'create') {
                await httpsGet(alexa, '/api/phoenix/group', {
                    method: 'POST',
                    data: JSON.stringify({ groupId: null, name: step.name, applianceIds: step.add, defaults: [] }),
                });
                console.log(`OK crear "${step.name}"`);
            } else {
                const body = {
                    groupId: step.group.groupId,
                    name: step.group.name,
                    defaults: step.group.defaults || [],
                    applianceIds: [...new Set([...(step.group.applianceIds || []), ...step.add])],
                };
                await httpsGet(alexa, `/api/phoenix/group/${step.group.groupId}`, {
                    method: 'PUT',
                    data: JSON.stringify(body),
                });
                console.log(`OK actualizar "${step.group.name}" (+${step.add.length})`);
            }
        } catch (err) {
            console.log(`FALLO en "${step.type === 'create' ? step.name : step.group.name}": ${err.message || err}`);
        }
        await sleep(DELAY_MS);
    }

    console.log('\nHecho. Ejecuta npm run discover otra vez para verificar el resultado.');
    process.exit(0);
})();
