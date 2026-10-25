// A small procedural HDR "photo studio" baked to a PMREM environment: dark gradient dome with a warm floor
// bounce, a large warm key softbox and two cool rim strips placed where the viewer's lights are, a dim cool
// fill card and a soft top light. Gives physically plausible ambient, believable reflections on gold and
// leather, and catchlights in the eyes. Directions are in the three.js world (Y up), seen from the stage.
import * as THREE from "three";

export function makeStudioEnvironment(renderer: THREE.WebGLRenderer, stage = new THREE.Vector3(0.6, 0.9, 0)): THREE.Texture {
  const env = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(30, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() { vDir = normalize( position ); gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          float y = vDir.y;
          vec3 top = vec3( 0.075, 0.09, 0.125 );
          vec3 hor = vec3( 0.03, 0.034, 0.042 );
          vec3 floorC = vec3( 0.045, 0.034, 0.026 );
          vec3 c = y > 0.0 ? mix( hor, top, pow( y, 0.7 ) ) : mix( hor, floorC, pow( -y, 0.5 ) );
          gl_FragColor = vec4( c, 1.0 );
        }`,
    }),
  );
  env.add(dome);

  const panel = (dir: THREE.Vector3Like, w: number, h: number, color: THREE.Color, dist = 12) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, toneMapped: false }));
    const d = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
    m.position.copy(d.multiplyScalar(dist));
    m.lookAt(0, 0, 0);
    env.add(m);
    return m;
  };
  const from = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).sub(stage);
  // key softbox (matches the viewer's key light direction), warm ~4800 K
  panel(from(3.0, 4.0, 3.0), 6, 6, new THREE.Color(1.0, 0.84, 0.68).multiplyScalar(4.2));
  // rim strips behind, cool
  panel(from(-2.6, 2.6, -3.2), 1.6, 8, new THREE.Color(0.55, 0.72, 1.0).multiplyScalar(5.0));
  panel(from(3.4, 2.2, -2.6), 1.6, 8, new THREE.Color(0.68, 0.66, 1.0).multiplyScalar(4.0));
  // fill card camera-left, cool and dim
  panel(from(-3.0, 1.5, 2.6), 8, 5, new THREE.Color(0.6, 0.7, 1.0).multiplyScalar(0.7));
  // soft overhead
  const top = panel(new THREE.Vector3(0, 1, 0.15), 7, 7, new THREE.Color(1, 0.97, 0.94).multiplyScalar(1.2));
  top.rotation.set(Math.PI / 2, 0, 0);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.0, 0.1, 100);
  pmrem.dispose();
  env.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
  });
  return rt.texture;
}
