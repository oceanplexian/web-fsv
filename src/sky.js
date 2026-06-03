// Jurassic-Park-FSN sky: black above, thin neon-green sunset band on the horizon,
// fading to black ground. Done as a single shader on a sky sphere (back faces).
import * as THREE from '/vendor/three/build/three.module.js';

export function makeSky() {
  const geo = new THREE.SphereGeometry(800, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      skyColor:    { value: new THREE.Color(0x000000) },
      horizonHi:   { value: new THREE.Color(0x4fbf3f) }, // bright neon green at the horizon
      horizonLo:   { value: new THREE.Color(0x0a1a0a) }, // dim green just below
      groundColor: { value: new THREE.Color(0x000000) },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPosition = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 skyColor;
      uniform vec3 horizonHi;
      uniform vec3 horizonLo;
      uniform vec3 groundColor;
      varying vec3 vWorldPosition;
      void main() {
        // h ∈ [-1, 1], 0 = horizon, 1 = zenith
        float h = normalize(vWorldPosition).y;
        vec3 col;
        if (h >= 0.0) {
          // sky: bright band right at horizon, fades to black quickly
          float band = exp(-h * 18.0);          // tight band above horizon
          col = mix(skyColor, horizonHi, band);
        } else {
          // ground side: thin dim band, then black
          float band = exp(h * 22.0);           // tight band below horizon
          col = mix(groundColor, horizonLo, band);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  return new THREE.Mesh(geo, mat);
}

export function makeGround() {
  // Pure black ground — matches the real fsv MapV.
  const geo = new THREE.PlaneGeometry(2000, 2000);
  const mat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.05;
  return mesh;
}
