// Baking helpers: many small static parts → one merged mesh per material bucket, coloured per vertex.
// Keeps the draw-call count flat however much detail a prop has.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** geometry/material reused by many objects: scene dispose skips it */
export const shared = <T extends THREE.BufferGeometry>(g: T) => { g.userData.shared = true; return g; };
export const sharedMat = <T extends THREE.Material>(m: T) => { m.userData.shared = true; return m; };

/** bake: transform each part into the parent's space, paint it with a vertex colour and merge per bucket */
export class Baker {
  private parts = new Map<string, THREE.BufferGeometry[]>();
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private e = new THREE.Euler();
  add(bucket: string, geo: THREE.BufferGeometry, color: number, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1], quat?: THREE.Quaternion) {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone());
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    this.m.compose(new THREE.Vector3(...pos), quat || this.q.setFromEuler(this.e.set(...rot)), new THREE.Vector3(...scale));
    g.applyMatrix4(this.m);
    const c = new THREE.Color(color).convertSRGBToLinear();
    const n = g.getAttribute('position').count; const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const l = this.parts.get(bucket) || []; l.push(g); this.parts.set(bucket, l);
  }
  get empty() { return this.parts.size === 0; }
  build(markShared = true) {
    const out: Record<string, THREE.BufferGeometry> = {};
    for (const [k, l] of this.parts) { const g = mergeGeometries(l, false)!; out[k] = markShared ? shared(g) : g; l.forEach((x) => x.dispose()); }
    this.parts.clear();
    return out;
  }
}

