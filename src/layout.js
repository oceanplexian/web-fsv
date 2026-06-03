// Flat radial-tree layout (matches the original fsv MapV "platforms with
// connecting lines" arrangement, not nested-on-top).
//
// - Every directory becomes its own coral platform sitting at y=0.
// - Files are bin-packed (squarified treemap) onto the top of THEIR OWN
//   directory's platform — never on an ancestor.
// - Sub-directories radiate outward from their parent in a ring, with the
//   ring radius chosen so child platforms don't overlap the parent.
// - Cyan lines are emitted from parent center to child center for the scene
//   to draw.

import { colorFor, NODE_COLORS } from './colors.js';

const PLATFORM_HEIGHT = 0.6;
const FILE_BASE_HEIGHT = 0.45;
const MIN_PLATFORM_SIDE = 4.0;
const PLATFORM_PAD = 1.0;       // inner padding (visible coral border)
const FILE_GAP = 0.18;          // gap between adjacent file tiles
const RING_GAP = 8.0;           // air between parent edge and child platform
const SCALE_PER_DEPTH = 0.85;   // child platforms shrink with depth
const MIN_WEDGE = 0.04;         // rad — prevents div-by-zero on tiny slices
const MAX_RADIUS_RATIO = 35;    // cap ring radius vs parent (prevents runaway)
export const LABEL_STRIP_FRAC = 0.16;  // bottom fraction reserved for the dir label
export const LABEL_STRIP_MAX = 1.2;

export function buildLayout(root) {
  const boxes = [];
  const links = [];
  computePlatformSizes(root, 0);
  computeSubtreeWeights(root);
  layoutDirNode(root, 0, 0, 0, null, 0, 2 * Math.PI, boxes, links, null);
  // Multi-ring keeps individual parents compact, but the wedge constraint
  // doesn't strictly contain grandchildren in world space — depth-1 subtrees
  // can geometrically intrude on each other. Push apart by subtree.
  resolveSubtreeOverlaps(boxes);
  return { boxes, links };
}

function resolveSubtreeOverlaps(boxes) {
  const anchors = boxes.filter(b => b.kind === 'platform' && b.depth === 1 && b._members);
  if (!anchors.length) return;

  function recomputeBBox(a) {
    let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
    for (const m of a._members) {
      if (m.x < minX) minX = m.x;
      if (m.x + m.w > maxX) maxX = m.x + m.w;
      if (m.z < minZ) minZ = m.z;
      if (m.z + m.d > maxZ) maxZ = m.z + m.d;
    }
    a._cx = (minX + maxX) / 2;
    a._cz = (minZ + maxZ) / 2;
    a._rx = (maxX - minX) / 2;
    a._rz = (maxZ - minZ) / 2;
  }
  for (const a of anchors) recomputeBBox(a);

  const PAD = 0.8;
  const MAX_ITER = 40;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let moved = false;
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const A = anchors[i], B = anchors[j];
        const dx = B._cx - A._cx, dz = B._cz - A._cz;
        // Per-axis overlap
        const xOverlap = (A._rx + B._rx + PAD) - Math.abs(dx);
        const zOverlap = (A._rz + B._rz + PAD) - Math.abs(dz);
        if (xOverlap <= 0 || zOverlap <= 0) continue; // separated
        // Push along the axis of *smaller* overlap (cheapest separation)
        let pushX = 0, pushZ = 0;
        if (xOverlap < zOverlap) {
          pushX = (xOverlap / 2) * Math.sign(dx || 1);
        } else {
          pushZ = (zOverlap / 2) * Math.sign(dz || 1);
        }
        for (const m of A._members) { m.x -= pushX; m.z -= pushZ; }
        for (const m of B._members) { m.x += pushX; m.z += pushZ; }
        A._cx -= pushX; A._cz -= pushZ;
        B._cx += pushX; B._cz += pushZ;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

// Each directory's "weight" is the count of platforms it would produce, so
// densely-populated subtrees get wider angular slices than sparse ones.
function computeSubtreeWeights(dir) {
  if (dir.type !== 'dir') return 0;
  const subDirs = (dir.children || []).filter(c => c.type === 'dir');
  if (!subDirs.length) { dir._weight = 1; return 1; }
  let total = 0;
  for (const sd of subDirs) total += computeSubtreeWeights(sd);
  dir._weight = Math.max(1, total);
  return dir._weight;
}

// Sizing rule (bounded!): a platform's side scales with log of file count, not
// raw byte sum. A naive sum-of-sizes scheme makes one fat directory (e.g. .git)
// dwarf the root and explode the world. The treemap inside each platform is
// normalized in `packFiles`, so the platform's outer size only needs to look
// good — it doesn't need to encode total bytes.
const MAX_PLATFORM_SIDE = 22.0;
function computePlatformSizes(dir, depth) {
  if (dir.type !== 'dir') return;
  const scale = Math.pow(SCALE_PER_DEPTH, depth);
  const files = (dir.children || []).filter(c => c.type !== 'dir');
  const fileCount = Math.max(files.length, 1);
  const baseSide = Math.min(
    MAX_PLATFORM_SIDE,
    MIN_PLATFORM_SIDE + Math.log10(fileCount + 1) * 5.0
  );
  dir._platformW = baseSide * scale;
  dir._platformD = baseSide * scale;
  for (const c of dir.children || []) computePlatformSizes(c, depth + 1);
}

function layoutDirNode(dir, cx, cz, depth, parentPlatform, wedgeStart, wedgeEnd, boxes, links, anchor) {
  const w = dir._platformW, d = dir._platformD;
  const platform = {
    node: dir,
    x: cx - w / 2, z: cz - d / 2, w, d,
    yBase: 0,
    height: PLATFORM_HEIGHT,
    color: NODE_COLORS.dir,
    kind: 'platform',
    depth,
  };
  boxes.push(platform);
  if (parentPlatform) links.push({ from: parentPlatform, to: platform });

  // Every depth-1 platform anchors its own subtree — every box created below
  // it is added to its members list so the overlap resolver can shift the
  // whole branch as one rigid unit.
  if (depth === 1) anchor = platform;
  if (anchor) {
    (anchor._members ||= []).push(platform);
  }

  const files = (dir.children || []).filter(c => c.type !== 'dir');
  if (files.length) packFiles(files, platform, boxes, anchor);

  const subDirs = (dir.children || []).filter(c => c.type === 'dir');
  if (!subDirs.length) return;

  const myMaxR = Math.max(w, d) / 2;
  const wedgeSize = wedgeEnd - wedgeStart;

  // Heaviest subtrees get inner rings (fewer hops to reach from root).
  const sorted = subDirs.slice().sort((a, b) => (b._weight || 1) - (a._weight || 1));

  // Pack children into concentric rings. Each ring radius is bounded — when a
  // ring fills up at some R, the rest spill onto a slightly larger one.
  let placed = 0;
  let ringIdx = 0;
  let prevR = myMaxR + RING_GAP;

  while (placed < sorted.length) {
    const remaining = sorted.slice(placed);
    const ringChildMaxR = remaining.reduce(
      (m, c) => Math.max(m, Math.max(c._platformW, c._platformD) / 2), 0
    );
    const ringR = ringIdx === 0
      ? myMaxR + ringChildMaxR + RING_GAP
      : prevR + ringChildMaxR * 2 + RING_GAP;

    // How many children physically fit on this ring within `wedgeSize`?
    const perChildAngular = 2 * Math.atan(ringChildMaxR / ringR) + 0.04;
    const capacity = Math.max(1, Math.floor(wedgeSize / perChildAngular));
    const slice = Math.min(capacity, remaining.length);
    const ringChildren = remaining.slice(0, slice);

    // Uniform angular slots within a ring guarantee no sibling overlap. Heavy
    // subtrees still get more breathing room overall because the heaviest are
    // sorted onto inner rings first.
    const slotSize = wedgeSize / slice;
    let cursor = wedgeStart;
    for (const c of ringChildren) {
      const angle = cursor + slotSize / 2;
      const sx = cx + Math.cos(angle) * ringR;
      const sz = cz + Math.sin(angle) * ringR;
      layoutDirNode(c, sx, sz, depth + 1, platform, cursor, cursor + slotSize, boxes, links, anchor);
      cursor += slotSize;
    }

    placed += slice;
    prevR = ringR;
    ringIdx++;
    if (ringIdx > 10) break; // safety
  }
}

function packFiles(files, platform, boxes, anchor) {
  // Labels now live on the ground in front of the platform (fsv MapV style),
  // so files get the full platform top.
  const inner = {
    x: platform.x + PLATFORM_PAD,
    y: platform.z + PLATFORM_PAD,
    w: platform.w - PLATFORM_PAD * 2,
    h: platform.d - PLATFORM_PAD * 2,
  };
  const tagged = files.map(f => ({ node: f, _area: Math.max(Math.sqrt(Math.max(f.size, 1)), 0.6) }));
  squarify(tagged, inner);
  const topY = platform.yBase + platform.height;
  for (const t of tagged) {
    if (!t._rect) continue;
    const r = t._rect;
    const w = r.w - FILE_GAP, d = r.h - FILE_GAP;
    if (w <= 0.05 || d <= 0.05) continue;
    const heightRaw = FILE_BASE_HEIGHT + Math.log10(t.node.size + 1) * 0.18;
    const h = Math.max(0.1, Math.min(heightRaw, Math.min(w, d) * 0.7));
    const fileBox = {
      node: t.node,
      x: r.x + FILE_GAP / 2, z: r.y + FILE_GAP / 2, w, d,
      yBase: topY,
      height: h,
      color: colorFor(t.node),
      kind: 'file',
      depth: platform.depth + 1,
    };
    boxes.push(fileBox);
    if (anchor) anchor._members.push(fileBox);
  }
}

// --- squarified treemap (Bruls et al.) -----------------------------------

function worst(row, w) {
  let sum = 0, rmax = -Infinity, rmin = Infinity;
  for (const n of row) {
    sum += n._area;
    if (n._area > rmax) rmax = n._area;
    if (n._area < rmin) rmin = n._area;
  }
  const sumSq = sum * sum, wSq = w * w;
  return Math.max((wSq * rmax) / sumSq, sumSq / (wSq * rmin));
}

function layoutRow(row, rect, horizontal) {
  let sum = 0;
  for (const n of row) sum += n._area;
  if (horizontal) {
    const rh = sum / rect.w;
    let x = rect.x;
    for (const n of row) {
      const w = n._area / rh;
      n._rect = { x, y: rect.y, w, h: rh };
      x += w;
    }
    rect.y += rh; rect.h -= rh;
  } else {
    const rw = sum / rect.h;
    let y = rect.y;
    for (const n of row) {
      const h = n._area / rw;
      n._rect = { x: rect.x, y, w: rw, h };
      y += h;
    }
    rect.x += rw; rect.w -= rw;
  }
}

function squarify(nodes, rect) {
  const remaining = nodes.slice().sort((a, b) => b._area - a._area);
  let totalArea = 0;
  for (const n of remaining) totalArea += n._area;
  if (!totalArea) return;
  const scale = (rect.w * rect.h) / totalArea;
  for (const n of remaining) n._area *= scale;

  let row = [];
  while (remaining.length) {
    const horizontal = rect.w >= rect.h;
    const w = horizontal ? rect.w : rect.h;
    const next = remaining[0];
    const nextRow = [...row, next];
    if (row.length === 0 || worst(nextRow, w) <= worst(row, w)) {
      row.push(next);
      remaining.shift();
    } else {
      layoutRow(row, rect, rect.w >= rect.h);
      row = [];
    }
  }
  if (row.length) layoutRow(row, rect, rect.w >= rect.h);
}
