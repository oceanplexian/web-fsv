import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';

// Data source:
//   'demo'  (default) — serve the bundled Isla Nublar / InGen tree. No filesystem
//                       access, no secrets; this is what the hosted demo runs.
//   'files'           — walk the real local filesystem (run it on your own machine
//                       to fly through your own directories). FSV_SOURCE=files.
//   'hass'            — visualize your Home Assistant: areas become rooms, devices
//                       become tiles you can toggle. FSV_SOURCE=hass. See below.
const SOURCE = (process.env.FSV_SOURCE || 'demo').toLowerCase();

// Home Assistant connection (only used when FSV_SOURCE=hass). Bring your own
// instance + token — set these in the environment, never commit them:
//   HASS_URL    e.g. http://homeassistant.local:8123  (your HA base URL)
//   HASS_TOKEN  a long-lived access token (HA → your profile → Security)
const HASS_URL = (process.env.HASS_URL || 'http://homeassistant.local:8123').replace(/\/+$/, '');
const HASS_TOKEN = process.env.HASS_TOKEN || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xbm':  'text/plain; charset=utf-8',
  '.xpm':  'text/plain; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
};

// Map URL prefixes to filesystem dirs. All paths are self-contained inside the
// repo so the same layout ships in the Lambda container.
const STATIC_ROUTES = [
  { prefix: '/vendor/three/', dir: path.join(__dirname, 'node_modules', 'three') },
  { prefix: '/assets/',       dir: path.join(__dirname, 'assets') },
  { prefix: '/src/',          dir: path.join(__dirname, 'src') },
  { prefix: '/',              dir: path.join(__dirname, 'public') },
];

function classifyType(stat) {
  if (stat.isDirectory()) return 'dir';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isCharacterDevice()) return 'chardev';
  if (stat.isBlockDevice()) return 'blockdev';
  if (stat.isFile()) return 'file';
  return 'unknown';
}

async function scanTree(root, { maxDepth = 6, maxEntries = 50000 } = {}) {
  const counter = { n: 0 };
  async function walk(absPath, depth) {
    let stat;
    try { stat = await fs.lstat(absPath); }
    catch { return null; }
    counter.n++;
    if (counter.n > maxEntries) return null;
    const node = {
      name: path.basename(absPath) || absPath,
      type: classifyType(stat),
      size: stat.size,
      mtime: stat.mtimeMs,
    };
    if (node.type === 'dir' && depth < maxDepth) {
      let entries;
      try { entries = await fs.readdir(absPath); }
      catch { node.children = []; return node; }
      const children = [];
      for (const name of entries) {
        if (counter.n > maxEntries) break;
        const child = await walk(path.join(absPath, name), depth + 1);
        if (child) children.push(child);
      }
      node.children = children;
      // total_size = own size + sum of children
      node.totalSize = node.size + children.reduce(
        (s, c) => s + (c.totalSize ?? c.size ?? 0), 0
      );
    } else if (node.type === 'dir') {
      // Hit maxDepth — leave children unloaded but flag as expandable.
      node.children = [];
      node.totalSize = node.size;
      node.truncated = true;
    } else {
      node.totalSize = node.size;
    }
    return node;
  }
  const tree = await walk(root, 0);
  return { tree, scanned: counter.n, truncated: counter.n > maxEntries };
}

// ---- Demo source ----
// The bundled tree is loaded once and reused. Regenerate it with
// `node scripts/gen-demo-tree.mjs`.
let demoTreeCache = null;
async function loadDemoTree() {
  if (!demoTreeCache) {
    const raw = await fs.readFile(path.join(__dirname, 'data', 'demo-tree.json'), 'utf8');
    demoTreeCache = JSON.parse(raw);
  }
  return demoTreeCache;
}

// ---- Home Assistant source ----
// Talks to the HA REST API with a long-lived access token. Credentials come
// entirely from HASS_URL / HASS_TOKEN in the environment — nothing is stored,
// hardcoded, or read from any keychain.
async function haFetch(pathname, init = {}) {
  if (!HASS_TOKEN) {
    throw new Error(
      'HASS_TOKEN is not set. In Home Assistant, open your profile → Security → ' +
      'Long-lived access tokens, create one, then run with ' +
      'FSV_SOURCE=hass HASS_URL=http://your-ha:8123 HASS_TOKEN=...'
    );
  }
  const r = await fetch(HASS_URL + pathname, {
    ...init,
    headers: {
      Authorization: `Bearer ${HASS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    throw new Error(`HA ${r.status} on ${pathname}: ${(await r.text()).slice(0, 200)}`);
  }
  return r;
}

// "Activity" score per entity, drives the file-tile size so active devices read
// as larger. 0–100 scale.
function haActivityScore(state, attrs) {
  const s = String(state ?? '').toLowerCase();
  if (attrs && typeof attrs.brightness === 'number') {
    return Math.max(8, Math.round((attrs.brightness / 255) * 100));
  }
  if (attrs && typeof attrs.percentage === 'number') {
    return Math.max(8, Math.round(attrs.percentage));
  }
  if (s === 'playing') return 100;
  if (s === 'paused') return 60;
  if (s === 'cleaning') return 100;
  if (s === 'docked' || s === 'idle' || s === 'home') return 30;
  if (s === 'on' || s === 'open' || s === 'unlocked') return 80;
  if (s === 'off' || s === 'closed' || s === 'locked') return 12;
  // Numeric sensor: log-scaled so a "200" sensor doesn't dwarf an on/off light.
  const n = Number(s);
  if (Number.isFinite(n)) return Math.max(8, Math.min(80, Math.round(20 + Math.log10(Math.abs(n) + 1) * 18)));
  return 18;
}

async function fetchHassTree() {
  const states = await (await haFetch('/api/states')).json();
  if (!Array.isArray(states)) throw new Error('HA /api/states returned a non-array');

  // Resolve each entity's area + device via the template API. area_name() walks
  // the device registry, so it works for entities that don't carry area_id in
  // their state attributes.
  const tmpl =
    '{% set ns = namespace(out=[]) %}' +
    '{% for s in states %}' +
    '{% set ns.out = ns.out + [[s.entity_id, ' +
    "area_name(s.entity_id) or '', device_id(s.entity_id) or '']] %}" +
    '{% endfor %}{{ ns.out | tojson }}';
  const areaMap = {}, deviceMap = {};
  try {
    const rendered = await (await haFetch('/api/template', {
      method: 'POST', body: JSON.stringify({ template: tmpl }),
    })).text();
    for (const [eid, area, dev] of JSON.parse(rendered)) {
      areaMap[eid] = area || null;
      deviceMap[eid] = dev || null;
    }
  } catch { /* templates disabled — fall back to no area grouping */ }

  for (const s of states) {
    s.area = areaMap[s.entity_id] ?? null;
    s.device_id = deviceMap[s.entity_id] ?? null;
  }

  // Only show user-controllable things. Skip firmware/diagnostic/sensor noise.
  const ACTIONABLE = new Set([
    'light', 'switch', 'fan', 'cover', 'lock', 'climate', 'vacuum',
    'media_player', 'scene', 'script', 'automation', 'input_button', 'remote',
  ]);
  // Higher = preferred when several entities share one physical device.
  const PRIORITY = {
    climate: 100, vacuum: 95, lock: 90, cover: 85,
    fan: 80, light: 75, media_player: 70, switch: 60,
    remote: 50, scene: 40, script: 35, automation: 30, input_button: 20,
  };

  const filtered = states.filter(e => ACTIONABLE.has(e.entity_id.split('.')[0]));

  // Dedup by device_id within an area — keep the highest-priority entity per device.
  const bestByDevice = new Map();
  const noDevice = [];
  for (const e of filtered) {
    if (!e.device_id) { noDevice.push(e); continue; }
    const cur = bestByDevice.get(e.device_id);
    const score = PRIORITY[e.entity_id.split('.')[0]] ?? 0;
    if (!cur || score > cur.score) bestByDevice.set(e.device_id, { e, score });
  }
  const deduped = [...[...bestByDevice.values()].map(x => x.e), ...noDevice];

  function entityNode(e) {
    const score = haActivityScore(e.state, e.attributes);
    return {
      name: e.attributes?.friendly_name || e.entity_id,
      type: 'file',
      size: score,
      totalSize: score,
      haEntityId: e.entity_id,
      haState: e.state,
      haArea: e.area || null,
    };
  }

  // Group entities with an area into rooms; without-area go on the root platform.
  const byArea = new Map();
  const globals = [];
  for (const e of deduped) {
    if (!e.area) { globals.push(e); continue; }
    if (!byArea.has(e.area)) byArea.set(e.area, []);
    byArea.get(e.area).push(e);
  }
  const areaNodes = [...byArea.keys()].sort((a, b) => a.localeCompare(b)).map(area => {
    const fileChildren = byArea.get(area).map(entityNode);
    return {
      name: area, type: 'dir', size: 0,
      totalSize: fileChildren.reduce((s, c) => s + c.size, 0),
      children: fileChildren,
    };
  });
  const globalFiles = globals.map(entityNode);
  const tree = {
    name: 'Home Assistant',
    type: 'dir',
    size: 0,
    totalSize: areaNodes.reduce((s, a) => s + a.totalSize, 0) +
               globalFiles.reduce((s, c) => s + c.size, 0),
    children: [...globalFiles, ...areaNodes],
  };
  return { tree, scanned: states.length, truncated: false, root: 'Home Assistant' };
}

async function serveStatic(req, res, urlPath) {
  for (const { prefix, dir } of STATIC_ROUTES) {
    if (!urlPath.startsWith(prefix)) continue;
    let rel = urlPath.slice(prefix.length) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const absPath = path.normalize(path.join(dir, decodeURIComponent(rel)));
    if (!absPath.startsWith(dir)) { res.writeHead(403); return res.end('forbidden'); }
    try {
      const data = await fs.readFile(absPath);
      const ct = MIME[path.extname(absPath)] || 'application/octet-stream';
      const headers = { 'content-type': ct };
      // Long-cache immutable vendored libs + media; keep our own source uncached
      // so edits are always live during local development.
      if (prefix === '/vendor/three/' || prefix === '/assets/') {
        headers['cache-control'] = 'public, max-age=86400';
      } else {
        headers['cache-control'] = 'no-store, no-cache, must-revalidate';
      }
      res.writeHead(200, headers);
      return res.end(data);
    } catch {
      continue; // try next route
    }
  }
  res.writeHead(404); res.end('not found');
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  if (url.pathname === '/config') {
    return sendJson(res, 200, { source: SOURCE });
  }

  // ---- Home Assistant control endpoints (only in hass mode) ----
  if (url.pathname === '/ha/states') {
    if (SOURCE !== 'hass') return sendJson(res, 400, { error: 'not in hass mode' });
    try {
      const states = await (await haFetch('/api/states')).json();
      const map = {};
      for (const s of states) map[s.entity_id] = s.state;
      return sendJson(res, 200, map);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (url.pathname === '/ha/toggle' && req.method === 'POST') {
    if (SOURCE !== 'hass') return sendJson(res, 400, { error: 'not in hass mode' });
    const entityId = url.searchParams.get('entity');
    if (!entityId || !entityId.includes('.')) {
      return sendJson(res, 400, { error: 'entity required' });
    }
    const domain = entityId.split('.')[0];
    // Pick the right service per domain. homeassistant.toggle handles most
    // on/off domains; one-shots (scene/script/input_button) need explicit calls.
    let service;
    if (domain === 'scene') service = 'scene.turn_on';
    else if (domain === 'script') service = 'script.turn_on';
    else if (domain === 'input_button') service = 'input_button.press';
    else if (domain === 'automation') service = 'automation.toggle';
    else if (domain === 'vacuum') service = 'vacuum.start';
    else if (domain === 'media_player') service = 'media_player.media_play_pause';
    else service = 'homeassistant.toggle';
    try {
      const [dom, svc] = service.split('.');
      const response = await (await haFetch(`/api/services/${dom}/${svc}`, {
        method: 'POST', body: JSON.stringify({ entity_id: entityId }),
      })).text();
      return sendJson(res, 200, { ok: true, service, entity: entityId, response });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (url.pathname === '/scan') {
    try {
      let result;
      if (SOURCE === 'hass') {
        result = await fetchHassTree();
      } else if (SOURCE === 'files') {
        const targetRaw = url.searchParams.get('path') || os.homedir();
        const target = path.resolve(targetRaw.replace(/^~(?=$|\/)/, os.homedir()));
        const maxDepth = Math.min(Number(url.searchParams.get('maxDepth') || 6), 12);
        const maxEntries = Math.min(Number(url.searchParams.get('maxEntries') || 50000), 200000);
        result = await scanTree(target, { maxDepth, maxEntries });
        result.root = target;
      } else {
        // demo: always return the bundled tree, ignoring the requested path.
        result = await loadDemoTree();
      }
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`fsv-web listening on http://${HOST}:${PORT}  (source: ${SOURCE})`);
});
