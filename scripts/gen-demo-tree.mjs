// Generates data/demo-tree.json — the bundled filesystem the hosted demo renders.
//
// It's the InGen / Isla Nublar control system from Jurassic Park: the SGI-UNIX
// box Nedry sabotaged and Lex "knew this" navigated in fsn. Deterministic
// (seeded PRNG) so the committed JSON is stable across regenerations.
//
//   node scripts/gen-demo-tree.mjs
//
// Node shape matches the server's /scan response so the frontend treats it
// identically to a real filesystem walk:
//   { name, type, size, totalSize, children? }

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── seeded PRNG (mulberry32) — stable output, no Math.random ────────────────
let _seed = 0x1a2b3c4d;
function rng() {
  _seed |= 0; _seed = (_seed + 0x6d2b79f5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rint = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const KB = 1024, MB = 1024 * 1024;
// Log-uniform size in a [lo,hi] byte range — gives the treemap real variety.
const rsize = (lo, hi) => Math.round(Math.exp(Math.log(lo) + rng() * (Math.log(hi) - Math.log(lo))));

// ── builders ────────────────────────────────────────────────────────────────
function file(name, size, type = 'file') {
  return { name, type, size: Math.max(1, Math.round(size)) };
}
function dir(name, children = []) {
  return { name, type: 'dir', size: 0, children };
}
// Bulk helper: n files named `${stem}${i}${ext}` with sizes in [lo,hi].
function files(stem, n, ext, lo, hi, startAt = 1) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(file(`${stem}${startAt + i}${ext}`, rsize(lo, hi)));
  return out;
}

// ── the tree ─────────────────────────────────────────────────────────────────
// Hand-authored structure, movie-accurate where it counts (whte_rabbt.obj,
// the magic word, the 12 perimeter fence grids, the embryo cold storage).
const PADDOCKS = [
  'tyrannosaurus', 'velociraptor', 'dilophosaurus', 'triceratops',
  'brachiosaurus', 'gallimimus', 'parasaurolophus', 'metriacanthosaurus',
];

function paddock(species) {
  const feeds = files('cam_', rint(2, 5), '.feed', 4 * MB, 90 * MB);
  return dir(species, [
    file('paddock.cfg', rsize(2 * KB, 12 * KB)),
    file('fence_voltage.cfg', rsize(1 * KB, 4 * KB)),
    file('feeding_schedule.dat', rsize(8 * KB, 60 * KB)),
    file('motion_sensor.log', rsize(40 * KB, 4 * MB)),
    file('vitals_telemetry.dat', rsize(120 * KB, 18 * MB)),
    file('tranquilizer_protocol.sh', rsize(2 * KB, 9 * KB)),
    ...(species === 'velociraptor'
      ? [file('clever_girl.log', rsize(10 * KB, 200 * KB)),
         file('pack_behavior.dat', rsize(200 * KB, 9 * MB)),
         file('they_remember.txt', rsize(400, 2 * KB))]
      : []),
    ...(species === 'tyrannosaurus'
      ? [file('rex_paddock_10000v.cfg', rsize(1 * KB, 3 * KB)),
         file('goat_dispenser.bin', rsize(20 * KB, 200 * KB))]
      : []),
    dir('cameras', feeds),
  ]);
}

const tree = dir('isla-nublar:/', [
  dir('usr', [
    dir('local', [
      dir('ingen', [
        dir('park', [
          dir('paddocks', PADDOCKS.map(paddock)),
          dir('vehicles', [
            file('explorer_01.tour', rsize(200 * KB, 3 * MB)),
            file('explorer_02.tour', rsize(200 * KB, 3 * MB)),
            file('jeep_29.gps', rsize(20 * KB, 400 * KB)),
            file('tour_track.dat', rsize(1 * MB, 30 * MB)),
            file('night_vision.bin', rsize(400 * KB, 8 * MB)),
            ...files('ride_vehicle_', 6, '.cfg', 1 * KB, 6 * KB),
          ]),
          dir('visitor_center', [
            file('life_support.cfg', rsize(4 * KB, 20 * KB)),
            file('kitchen_freezer.cam', rsize(8 * MB, 70 * MB)),
            file('rotunda_lights.cfg', rsize(1 * KB, 5 * KB)),
            file('gift_shop_inventory.db', rsize(300 * KB, 12 * MB)),
            file('lab_door.lock', rsize(256, 2 * KB)),
            file('dna_animation.mov', rsize(30 * MB, 220 * MB)),
            file('mr_dna.mov', rsize(20 * MB, 120 * MB)),
          ]),
          dir('aviary', files('pteranodon_', 8, '.track', 60 * KB, 6 * MB)),
          dir('lagoon', [
            file('mosasaurus.sonar', rsize(2 * MB, 40 * MB)),
            file('feeding_platform.cfg', rsize(1 * KB, 8 * KB)),
          ]),
        ]),
        dir('security', [
          dir('fences', [
            // The 12 perimeter grids. 10–12 are the ones that went down.
            ...Array.from({ length: 9 }, (_, i) =>
              file(`perimeter_grid_${String(i + 1).padStart(2, '0')}.cfg`, rsize(1 * KB, 4 * KB))),
            file('perimeter_grid_10.OFFLINE', rsize(1 * KB, 4 * KB)),
            file('perimeter_grid_11.OFFLINE', rsize(1 * KB, 4 * KB)),
            file('perimeter_grid_12.OFFLINE', rsize(1 * KB, 4 * KB)),
            file('main_grid.cfg', rsize(8 * KB, 40 * KB)),
          ]),
          dir('doors', [
            ...files('door_', 24, '.lock', 256, 4 * KB),
            file('all_doors_master.lock', rsize(2 * KB, 12 * KB)),
          ]),
          dir('cameras', files('cam_', 18, '.feed', 2 * MB, 60 * MB)),
          dir('keycards', [
            file('hammond.key', rsize(512, 2 * KB)),
            file('muldoon.key', rsize(512, 2 * KB)),
            file('arnold.key', rsize(512, 2 * KB)),
            file('nedry.key.REVOKED', rsize(512, 2 * KB)),
            file('wu.key', rsize(512, 2 * KB)),
          ]),
          file('access_control.db', rsize(2 * MB, 40 * MB)),
        ]),
        dir('genetics', [
          dir('embryos', [
            dir('cold_storage', [
              ...files('cryo_rack_', 12, '.dat', 4 * MB, 80 * MB),
              file('barbasol.can', rsize(50 * MB, 180 * MB)), // Dodgson's "we have Dodgson here!"
              file('viable_count.txt', rsize(256, 1 * KB)),
            ]),
            dir('dna_sequences', [
              ...PADDOCKS.map((s) => file(`${s}.seq`, rsize(8 * MB, 120 * MB))),
              file('frog_dna_complete.seq', rsize(40 * MB, 90 * MB)), // life, uh, finds a way
              file('amber_extract.raw', rsize(20 * MB, 200 * MB)),
            ]),
          ]),
          dir('lab', [
            file('sequencer_run.log', rsize(2 * MB, 40 * MB)),
            file('gene_splicer.cfg', rsize(8 * KB, 60 * KB)),
            file('chaos_theory_objection.txt', rsize(4 * KB, 40 * KB)),
            file('spared_no_expense.txt', rsize(400, 4 * KB)),
            ...files('specimen_', 15, '.sample', 200 * KB, 30 * MB),
          ]),
        ]),
        dir('bin', [
          file('nedry', rsize(80 * KB, 600 * KB), 'file'),
          file('whte_rabbt.obj', rsize(2 * MB, 40 * MB)), // ...you didn't say the magic word
          file('setup_phones.sh', rsize(2 * KB, 9 * KB)),
          file('magic_word.sh', rsize(512, 2 * KB)),
          file('park_control', rsize(400 * KB, 3 * MB)),
          file('fsn', rsize(1 * MB, 8 * MB)), // it's a UNIX system! I know this!
        ]),
      ]),
      dir('bin', files('tool_', 14, '', 8 * KB, 900 * KB)),
      dir('lib', files('lib', 22, '.so', 20 * KB, 6 * MB)),
      dir('share', [
        dir('man', files('man', 9, '.gz', 2 * KB, 80 * KB)),
        dir('fonts', files('font_', 7, '.bdf', 8 * KB, 200 * KB)),
      ]),
    ]),
    dir('include', files('header_', 18, '.h', 1 * KB, 40 * KB)),
    dir('man', files('man', 12, '.1', 1 * KB, 30 * KB)),
  ]),
  dir('home', [
    dir('nedry', [
      file('whte_rabbt.obj', rsize(2 * MB, 40 * MB)),
      file('jurassic_park_ad.mov', rsize(40 * MB, 240 * MB)),
      file('dodgson_deal.eml', rsize(2 * KB, 30 * KB)),
      file('i_hate_this_hacker_crap.txt', rsize(400, 4 * KB)),
      file('costanza_payoff.dat', rsize(40 * KB, 2 * MB)),
      file('barbasol_cryocan.dwg', rsize(400 * KB, 6 * MB)),
      file('.plan', rsize(128, 600)),
      dir('downloads', files('frame_', 20, '.tga', 200 * KB, 4 * MB)),
    ]),
    dir('hammond', [
      file('welcome_to_jurassic_park.mov', rsize(60 * MB, 260 * MB)),
      file('spared_no_expense.txt', rsize(400, 3 * KB)),
      file('flea_circus_notes.txt', rsize(2 * KB, 20 * KB)),
      file('investor_tour.ppt', rsize(2 * MB, 30 * MB)),
    ]),
    dir('arnold', [
      file('hold_onto_your_butts.sh', rsize(512, 3 * KB)),
      file('system_reboot.sh', rsize(2 * KB, 12 * KB)),
      file('cigarette_count.log', rsize(256, 2 * KB)),
      ...files('maintenance_', 9, '.log', 20 * KB, 2 * MB),
    ]),
    dir('muldoon', [
      file('clever_girl.txt', rsize(256, 2 * KB)),
      file('raptor_containment.report', rsize(40 * KB, 800 * KB)),
      file('shoot_her.cfg', rsize(256, 1 * KB)),
    ]),
    dir('sattler', [file('plant_survey.db', rsize(1 * MB, 20 * MB)), file('that_is_one_big_pile.txt', rsize(256, 2 * KB))]),
    dir('grant', [file('raptor_dig_montana.dat', rsize(2 * MB, 40 * MB)), file('velociraptor_paper.pdf', rsize(400 * KB, 8 * MB))]),
    dir('malcolm', [
      file('chaos_theory.pdf', rsize(800 * KB, 12 * MB)),
      file('life_finds_a_way.txt', rsize(2 * KB, 18 * KB)),
      file('strange_attractor.dat', rsize(200 * KB, 6 * MB)),
    ]),
    dir('wu', files('protein_fold_', 11, '.dat', 1 * MB, 60 * MB)),
  ]),
  dir('etc', [
    file('passwd', rsize(1 * KB, 4 * KB)),
    file('shadow', rsize(1 * KB, 4 * KB)),
    file('hosts', rsize(256, 2 * KB)),
    file('fstab', rsize(256, 2 * KB)),
    file('fence.conf', rsize(2 * KB, 12 * KB)),
    file('ah_ah_ah.policy', rsize(512, 3 * KB)),
    dir('rc.d', files('rc', 8, '.sh', 512, 8 * KB)),
  ]),
  dir('var', [
    dir('log', [
      file('system.log', rsize(4 * MB, 90 * MB)),
      file('fence_failures.log', rsize(200 * KB, 12 * MB)),
      file('raptor_escapes.log', rsize(20 * KB, 800 * KB)),
      file('nedry_access.log', rsize(400 * KB, 8 * MB)),
      file('dennis_logout.log', rsize(2 * KB, 40 * KB)),
      file('power_grid.log', rsize(1 * MB, 30 * MB)),
    ]),
    dir('spool', files('job_', 14, '.queue', 4 * KB, 2 * MB)),
    dir('tmp', files('tmp_', 9, '.tmp', 1 * KB, 4 * MB)),
  ]),
  dir('dev', [
    // Device files — chardev / blockdev / fifo / socket give the scene
    // off-palette tiles, the way a real /dev does.
    file('sgi0', 0, 'chardev'),
    file('console', 0, 'chardev'),
    file('mag_tape0', 0, 'chardev'),
    file('dsk0', 0, 'blockdev'),
    file('dsk1', 0, 'blockdev'),
    file('cdrom', 0, 'blockdev'),
    file('null', 0, 'chardev'),
    file('fence_relay', 0, 'fifo'),
    file('door_bus', 0, 'fifo'),
    file('control_sock', 0, 'socket'),
  ]),
  dir('sgi', [
    dir('fsn', [
      file('fsn', rsize(1 * MB, 6 * MB)),
      file('fsn.rgb', rsize(200 * KB, 3 * MB)),
      file('README', rsize(2 * KB, 12 * KB)),
    ]),
    dir('demos', files('demo_', 12, '.rgb', 400 * KB, 12 * MB)),
    dir('irix', files('irix_', 16, '.o', 40 * KB, 4 * MB)),
  ]),
  dir('tmp', [
    file('nedry_was_here', rsize(256, 4 * KB), 'symlink'),
    ...files('core.', 5, '', 2 * MB, 80 * MB),
  ]),
]);

// ── finalize: compute totalSize bottom-up + count nodes ──────────────────────
let scanned = 0;
function finalize(node) {
  scanned++;
  if (node.type === 'dir') {
    let total = node.size || 0;
    for (const c of node.children || []) total += finalize(c);
    node.totalSize = total;
    return total;
  }
  node.totalSize = node.size;
  return node.size;
}
finalize(tree);

const payload = { tree, scanned, truncated: false, root: tree.name };
const outPath = path.join(__dirname, '..', 'data', 'demo-tree.json');
writeFileSync(outPath, JSON.stringify(payload));
console.log(`wrote ${outPath}: ${scanned} nodes, ${(JSON.stringify(payload).length / 1024).toFixed(0)} KB`);
