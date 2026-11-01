/** Shared cube-sphere addressing. World Y is north; longitude +90 is +Z. */
export const W = 1, E = 2, S = 4, N = 8;
export const EDGE = Object.freeze({ W, E, S, N });
export const EDGES = Object.freeze([W, E, S, N]);
export const FACES = Object.freeze(['+X', '-X', '+Y', '-Y', '+Z', '-Z']);

export function validateTile(tile) {
  if (!tile || !Number.isInteger(tile.face) || tile.face < 0 || tile.face > 5 ||
      !Number.isInteger(tile.level) || tile.level < 0 || tile.level > 30) {
    throw new RangeError('Invalid cube tile face or level');
  }
  const count = 2 ** tile.level;
  if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y) || tile.x < 0 ||
      tile.y < 0 || tile.x >= count || tile.y >= count) {
    throw new RangeError('Invalid cube tile address');
  }
}

export function faceDirection(face, u, v) {
  if (!Number.isInteger(face) || face < 0 || face > 5 || !Number.isFinite(u) || !Number.isFinite(v)) {
    throw new RangeError('Invalid cube face coordinates');
  }
  // Allow tiny out-of-face coordinates for neighbor lookup. Identical physical
  // edge samples produce the identical world vector before normalization.
  let p;
  switch (face) {
    case 0: p = [1, v, -u]; break;
    case 1: p = [-1, v, u]; break;
    case 2: p = [u, 1, -v]; break;
    case 3: p = [u, -1, v]; break;
    case 4: p = [u, v, 1]; break;
    default: p = [-u, v, -1];
  }
  const inv = 1 / Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
  return p.map(x => x === 0 ? 0 : x * inv);
}

/** Project a ray onto a specified face; useful for either side of a cube seam. */
export function projectDirection(face, dir) {
  const [x, y, z] = dir;
  let denominator, u, v;
  switch (face) {
    case 0: denominator = x; u = -z; v = y; break;
    case 1: denominator = -x; u = z; v = y; break;
    case 2: denominator = y; u = x; v = -z; break;
    case 3: denominator = -y; u = x; v = z; break;
    case 4: denominator = z; u = x; v = y; break;
    case 5: denominator = -z; u = -x; v = y; break;
    default: throw new RangeError('Invalid cube face');
  }
  if (!(denominator > 0) || ![x, y, z].every(Number.isFinite)) return null;
  return { face, u: u / denominator, v: v / denominator };
}

export function directionFace(dir) {
  if (!dir || dir.length !== 3 || !dir.every(Number.isFinite)) throw new RangeError('Invalid direction');
  const [x, y, z] = dir;
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (Math.max(ax, ay, az) === 0) throw new RangeError('Zero direction');
  const face = ax >= ay && ax >= az ? (x >= 0 ? 0 : 1) : ay >= az ? (y >= 0 ? 2 : 3) : (z >= 0 ? 4 : 5);
  return projectDirection(face, dir);
}

export function tileKey(tile) { return `${tile.face}/${tile.level}/${tile.x}/${tile.y}`; }
export function tileBounds(tile) {
  validateTile(tile);
  const step = 2 / 2 ** tile.level;
  return { u0: -1 + tile.x * step, u1: -1 + (tile.x + 1) * step,
    v0: -1 + tile.y * step, v1: -1 + (tile.y + 1) * step };
}
export function tileChildren(tile) {
  validateTile(tile);
  if (tile.level === 30) throw new RangeError('Maximum addressing level reached');
  return [0, 1, 2, 3].map(q => ({ face: tile.face, level: tile.level + 1,
    x: tile.x * 2 + (q & 1), y: tile.y * 2 + (q >> 1) }));
}
export function neighbourSample(tile, edge) {
  const b = tileBounds(tile), epsilon = Math.max((b.u1 - b.u0) * 1e-6, Number.EPSILON * 16);
  let u = (b.u0 + b.u1) / 2, v = (b.v0 + b.v1) / 2;
  if (edge === W) u = b.u0 - epsilon;
  else if (edge === E) u = b.u1 + epsilon;
  else if (edge === S) v = b.v0 - epsilon;
  else if (edge === N) v = b.v1 + epsilon;
  else throw new RangeError('Invalid edge');
  return directionFace(faceDirection(tile.face, u, v));
}
