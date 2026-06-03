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

export function colorFor(node) {
  if (node.type !== 'file') return NODE_COLORS[node.type] ?? NODE_COLORS.unknown;
  const dot = node.name.lastIndexOf('.');
  if (dot > 0) {
    const ext = node.name.slice(dot + 1).toLowerCase();
    if (EXT_LOOKUP.has(ext)) return EXT_LOOKUP.get(ext);
  }
  return NODE_COLORS.file;
}
