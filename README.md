# alexa-matter-rooms

Asignación masiva de dispositivos (bridge Matter de Home Assistant → Alexa) a
sus salas/grupos correspondientes, sin pasar por la app móvil.

Usa `alexa-remote2` (la librería en la que se basan el "Alexa Media Player" de
Home Assistant y el adaptador de ioBroker), que habla con la misma API interna
("Phoenix") que usa la app de Alexa. **No es una API oficial de Amazon**: es
ingeniería inversa mantenida por la comunidad, así que puede romperse si
Amazon cambia algo, y usarla no es un uso "soportado" de la cuenta.

## Instalación

Dos formas de ejecutarlo, elige una:

### Opción A: Docker (recomendado, sin depender de tener Node instalado)

```bash
cp config.example.json config.json   # ajusta amazonPage si no es amazon.es
docker compose build
```

A partir de aquí, cada comando de este README de la forma `npm run xxx` /
`node scripts/xxx.js` se ejecuta igual pero anteponiendo
`docker compose run --rm alexa-matter`, por ejemplo:

```bash
docker compose run --rm alexa-matter npm run login
docker compose run --rm alexa-matter npm run discover
docker compose run --rm alexa-matter node scripts/apply.js
docker compose run --rm alexa-matter node scripts/apply.js --apply
```

`data/` y `config.json` están montados desde el host (ver `docker-compose.yml`),
así que la sesión, los volcados y `mapping.csv` persisten entre ejecuciones y
se editan directamente en el host con cualquier editor — no hace falta entrar
en el contenedor para eso. El puerto 3001 (proxy de login) también está
publicado al host.

### Opción B: Node local

```bash
npm install
cp config.example.json config.json
```

Edita `config.json` si tu cuenta de Amazon no es `amazon.es`.

## Flujo

### 1. Login (una vez, y cuando la sesión caduque)

```bash
npm run login
```

Arranca un proxy local. Abre la URL que te imprime en un navegador de un
PC/Mac **sin** la app de Alexa instalada, e inicia sesión con tu cuenta
(incluye 2FA si lo tienes activo). La sesión queda guardada en
`data/alexa-cookie.json`.

**`data/alexa-cookie.json` equivale a tener tu cuenta de Amazon abierta.**
No lo subas a git ni lo compartas (ya está en `.gitignore`).

### 2. Discover (solo lectura)

```bash
npm run discover
```

Descarga el estado actual de tu cuenta a `data/` (`entities.json`,
`groups.json`, `devicesV2.json`, `phoenixRaw.json`) y genera
`data/mapping.template.csv` con los dispositivos "locales" (bridge Matter de
Home Assistant + Echos: cualquier cosa con `legacyAppliance.driverIdentity.namespace
=== 'AAA'` en `devicesV2.json`, a diferencia de las integraciones por Alexa
Skill clásica que van con `namespace: 'SKILL'`), su sala actual (si la tiene,
mirando qué grupo tipo `SPACE` de `groups.json` contiene su `applianceId`) y
una sugerencia de `targetRoom`.

Cada vez que se ejecuta, además actualiza `data/room-snapshot.json`: un mapa
`nombre de dispositivo → última sala conocida`. Sirve para sobrevivir a un
borrado/reemparejamiento del bridge Matter (los `applianceId` internos
cambian, el nombre normalmente no): si un dispositivo reaparece sin sala,
`targetRoom` se autocompleta con lo último que sabíamos de él. Solo quedan en
blanco los dispositivos genuinamente nuevos que nunca se han visto.

### 3. Mapeo

```bash
cp data/mapping.template.csv data/mapping.csv
```

Rellena la columna `targetRoom` de cada fila con el nombre exacto de la sala
tal como aparece en Alexa (p. ej. `Salón`, `Cocina`). Deja en blanco las filas
que no quieras tocar.

### 4. Apply

```bash
node scripts/apply.js              # dry-run: solo muestra el plan
node scripts/apply.js --apply      # ejecuta los cambios
node scripts/apply.js --apply --create-missing   # además crea las salas que falten
```

El script re-lee los grupos en vivo, calcula qué dispositivos faltan en cada
sala y solo actualiza los grupos que realmente cambian (no toca el resto de
miembros). Siempre revisa el dry-run antes de `--apply`.

## Referencia rápida (Docker)

Con la imagen ya construida (`docker compose build`), los tres casos habituales:

**Sacar las asignaciones actuales de Alexa** (solo lectura, vuelca `data/`):
```bash
docker compose run --rm alexa-matter npm run discover
```

**Iniciar/renovar sesión en Amazon** (cuando `discover`/`apply` fallen por sesión caducada):
```bash
docker compose run --rm alexa-matter npm run login
# abre http://localhost:3001/ en el navegador y confirma en esta terminal cuando termine
```

**Asignar los dispositivos que haya ahora mismo a los grupos de una ejecución anterior**
(usa `data/room-snapshot.json`, el histórico nombre→sala que ya se ha ido guardando):
```bash
docker compose run --rm alexa-matter npm run discover      # refresca y autocompleta targetRoom desde el snapshot
cp data/mapping.template.csv data/mapping.csv              # (en el host; edita a mano lo que quede en blanco)
docker compose run --rm alexa-matter node scripts/apply.js            # dry-run: revisa el plan
docker compose run --rm alexa-matter node scripts/apply.js --apply    # aplica de verdad
```

## Repetir proceso o tras borrar y re-vincular el hub Matter

- Si la sesión sigue viva, basta con `npm run discover` → revisar
  `mapping.template.csv` (los dispositivos ya conocidos vienen con `targetRoom`
  autocompletado desde `data/room-snapshot.json`; solo hay que rellenar los
  nuevos) → `cp data/mapping.template.csv data/mapping.csv` → `apply.js`
  (dry-run) → `apply.js --apply`.
- Si la sesión ha caducado, `npm run login` primero.
- **No borres `data/room-snapshot.json`**: es la memoria que permite que,
  tras borrar y re-vincular el hub Matter, los dispositivos ya conocidos
  recuperen su sala automáticamente en el siguiente `discover`.

## Seguridad

- `config.json` y todo `data/` están en `.gitignore`.
- Amazon puede devolver `429 Too Many Requests` si se hacen muchas llamadas
  seguidas; `apply.js` ya mete una pequeña pausa entre peticiones.
