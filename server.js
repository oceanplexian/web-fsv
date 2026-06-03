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
//                       to fly through your own directories). Opt in with FSV_SOURCE=files.
const SOURCE = (process.env.FSV_SOURCE || 'demo').toLowerCase();

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  if (url.pathname === '/config') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ source: SOURCE }));
    return;
  }

  if (url.pathname === '/scan') {
    try {
      let result;
      if (SOURCE === 'files') {
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
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`fsv-web listening on http://${HOST}:${PORT}  (source: ${SOURCE})`);
});
