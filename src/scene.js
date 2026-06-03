// Builds the visible Three.js scene from a layout returned by buildLayout().
import * as THREE from '/vendor/three/build/three.module.js';
import { makeLabel, makeBillboardLabel } from './labels.js';

const sharedBoxGeo = new THREE.BoxGeometry(1, 1, 1);

// Truncated (un-expanded) directories render in a dimmer coral so they're
// visually distinct from fully-loaded ones — click to lazy-expand.
const TRUNCATED_COLOR = 0x6e2a23;

function platformMaterial(color, truncated) {
  return new THREE.MeshLambertMaterial({
    color: truncated ? TRUNCATED_COLOR : color,
    emissive: 0x000000,
  });
}

export function buildScene({ boxes, links }, { showLabels = true } = {}) {
  const group = new THREE.Group();
  const pickables = [];

  for (const b of boxes) {
    const truncated = b.kind === 'platform' && b.node.truncated;
    const mat = platformMaterial(b.color, truncated);
    const mesh = new THREE.Mesh(sharedBoxGeo, mat);
    mesh.scale.set(b.w, b.height, b.d);
    mesh.position.set(b.x + b.w / 2, b.yBase + b.height / 2, b.z + b.d / 2);
    mesh.userData.box = b;
    b.mesh = mesh;     // back-ref so callers can recolor / flash this tile later
    group.add(mesh);
    pickables.push(mesh);

    if (showLabels) {
      let label = null;
      if (b.kind === 'platform') {
        // Original fsv places dir labels at world z=0 (the ground plane). In
        // our flat layout, that means flat on the floor in front of the
        // platform — visible from the low camera angle.
        if (b.w > 1.5) {
          const labelHeight = Math.min(1.1, Math.max(0.45, b.w * 0.10));
          label = makeLabel(b.node.name, {
            height: labelHeight,
            color: '#7af0ff',
            maxWidth: b.w * 1.4,
          });
          if (label) {
            label.position.set(
              b.x + b.w * 0.5,
              0.04,                                  // just above the ground
              b.z + b.d + labelHeight * 0.6 + 0.3   // just outside the +z edge
            );
          }
        }
      } else {
        // Dark text directly on top of cyan file tile, clipped to fit.
        if (b.w > 0.55 && b.d > 0.25) {
          const labelHeight = Math.min(0.32, Math.min(b.w, b.d) * 0.55);
          label = makeLabel(b.node.name, {
            height: labelHeight,
            color: '#0a1820',
            maxWidth: b.w * 0.92,
          });
          if (label) {
            label.position.set(
              b.x + b.w / 2,
              b.yBase + b.height + 0.012,
              b.z + b.d / 2
            );
          }
        }
      }
      if (label) group.add(label);
    }
  }

// Connector lines: straight, flat on the ground (FSN MapV doesn't arc them).
  if (links?.length) {
    const positions = [];
    const Y = 0.02;
    for (const link of links) {
      const fromCx = link.from.x + link.from.w / 2;
      const fromCz = link.from.z + link.from.d / 2;
      const toCx   = link.to.x + link.to.w / 2;
      const toCz   = link.to.z + link.to.d / 2;
      positions.push(fromCx, Y, fromCz, toCx, Y, toCz);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x7af0ff, transparent: true, opacity: 0.65 });
    group.add(new THREE.LineSegments(geo, mat));
  }

  return { group, pickables };
}
