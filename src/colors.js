// Node-type colors. fsv defaults are gray dirs / yellow files; we tint
// directories blue to match the FSN "Jurassic Park" aesthetic.

export const NODE_COLORS = {
  dir:      0xc8463a, // platform coral/red (Jurassic Park FSN)
  file:     0x6ec0d6, // cyan file tile (Jurassic Park FSN)
  symlink:  0xffffff,
  fifo:     0x66cc66,
  socket:   0xff8a3d,
  chardev:  0x66ddee,
  blockdev: 0x6aa6ff,
  unknown:  0xc24545,
};

// Per-extension overrides — kept restrained so the cyan-on-coral FSN aesthetic dominates.
const EXT_GROUPS = [
  { color: 0xf2c14e, exts: ['exe', 'sh', 'bin', 'app']                          }, // executables (yellow accent)
  { color: 0x96e0a8, exts: ['md', 'rst', 'txt', 'log']                          }, // text (mint)
  { color: 0xe07ad4, exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'tiff'] }, // images (magenta)
];

const EXT_LOOKUP = (() => {
  const m = new Map();
  for (const g of EXT_GROUPS) for (const e of g.exts) m.set(e, g.color);
  return m;
})();

// Home Assistant entity-tile color reflects on/off-ish state at a glance.
const HA_ON  = 0xb6f56b; // bright green-yellow — "active"
const HA_OFF = 0x2f5566; // muted dark cyan — "inactive"
const HA_ALERT = 0xff9966; // orange — playing/heating/cooling/cleaning
const HA_DEAD = 0x4a4a4a; // grey — unavailable
export function colorForHaEntity(node) {
  const s = String(node.haState ?? '').toLowerCase();
  if (!s || s === 'unavailable' || s === 'unknown') return HA_DEAD;
  if (s === 'on' || s === 'open' || s === 'unlocked' || s === 'home') return HA_ON;
  if (s === 'off' || s === 'closed' || s === 'locked') return HA_OFF;
  if (s === 'playing' || s === 'cleaning' || s === 'heat' || s === 'cool' || s === 'auto') return HA_ALERT;
  if (s === 'paused' || s === 'idle' || s === 'docked') return HA_OFF;
  // Numeric / scene timestamp / etc — neutral cyan.
  return NODE_COLORS.file;
}

export function colorFor(node) {
  if (node.haEntityId) return colorForHaEntity(node);
  if (node.type !== 'file') return NODE_COLORS[node.type] ?? NODE_COLORS.unknown;
  const dot = node.name.lastIndexOf('.');
  if (dot > 0) {
    const ext = node.name.slice(dot + 1).toLowerCase();
    if (EXT_LOOKUP.has(ext)) return EXT_LOOKUP.get(ext);
  }
  return NODE_COLORS.file;
}
