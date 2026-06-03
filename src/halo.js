// FSN selection halo: very transparent volumetric cone + wireframe rings/ribs.
// Wider at the bottom (the selected item), narrowing toward the top.
import * as THREE from '/vendor/three/build/three.module.js';

const HALO_HEIGHT = 45;   // tall enough to read as a beam shooting upward
const TOP_R = 0.15;       // very narrow at top
const BOT_R = 1.0;        // wide at the item
const RING_SEGS = 64; // smoother silhouette

export function makeHalo() {
  const group = new THREE.Group();

  // Soft volume — almost invisible head-on, brighter at silhouette edges (Fresnel).
  const volGeo = new THREE.CylinderGeometry(TOP_R, BOT_R, HALO_HEIGHT, RING_SEGS, 1, true);
  const volMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      color:   { value: new THREE.Color(0x7af0ff) },
      time:    { value: 0 },
      opacity: { value: 1 },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying float vY;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mv.xyz);
        vY = position.y;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 color;
      uniform float time;
      uniform float opacity;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying float vY;
      // Cheap deterministic hash — same inputs always give the same output,
      // so the flicker is consistent per-frame across pixels in a slice.
      float hash(float x) { return fract(sin(x * 12.9898) * 43758.5453); }
      void main() {
        float fres = 1.0 - abs(dot(vNormal, vViewDir));
        float edge = pow(fres, 5.0);
        float t = (vY + ${(HALO_HEIGHT/2).toFixed(1)}) / ${HALO_HEIGHT.toFixed(1)};
        float body = mix(1.0, 0.6, t);

        // Three layered sine waves at different rates → irregular pulse.
        float w1 = sin(time * 2.3);
        float w2 = sin(time * 7.1 + 1.7);
        float w3 = sin(time * 17.0 + 3.4);
        float pulse = 0.78 + 0.10 * w1 + 0.07 * w2 + 0.05 * w3;

        // Occasional sharp dropout — held for ~10 frames at a time so it reads
        // as an electrical glitch, not per-frame noise.
        float bucket = floor(time * 6.0);
        float glitch = step(0.92, hash(bucket)); // 8% of buckets glitch
        float dim = mix(1.0, 0.25, glitch);

        // Per-vertical-band tear: sharp dim line that drifts down the cone.
        float band = sin((vY * 0.6) + time * 5.0);
        float tear = 1.0 - 0.35 * smoothstep(0.92, 1.0, band);

        float a = (edge * 1.10 + 0.07) * body * pulse * dim * tear * opacity;
        gl_FragColor = vec4(color, a);
      }
    `,
  });
  group.add(new THREE.Mesh(volGeo, volMat));

  group.visible = false;
  group.renderOrder = 999;
  group.userData.volMat = volMat;
  return group;
}

export function positionHalo(halo, box) {
  if (!box) { halo.visible = false; return; }
  const cx = box.x + box.w / 2;
  const cz = box.z + box.d / 2;
  const topY = box.yBase + box.height;
  const span = Math.min(box.w, box.d);
  const xz = Math.max(0.4, Math.min(2.5, span * 0.35));
  halo.scale.set(xz, 1, xz);
  halo.position.set(cx, topY + HALO_HEIGHT / 2 - 0.05, cz);
  halo.visible = true;
}
