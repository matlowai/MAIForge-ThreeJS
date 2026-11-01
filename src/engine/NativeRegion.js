const TAU = 2 * Math.PI;
const MODEL = 'planet-catchment-flow-hillslope/6';
const RESOLUTION = 128;
const APRON = 1;
const N = RESOLUTION + 2 * APRON;
const HEIGHT_BYTES = N * N * 4;
const MAX_BLOCKS = 256;
const MAX_REGION_BYTES = 128 * 1024;
const MAX_BLOCK_MANIFEST_BYTES = 64 * 1024;
const INTERNAL = Symbol('validated native region');
const mod = (x, n) => ((x % n) + n) % n;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const digestPattern = /^blake3:[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{64}$/;
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
function freeze(v) {
  if (v && typeof v === 'object') { for (const x of Object.values(v)) freeze(x); Object.freeze(v); }
  return v;
}
function jsonCopy(v) { return JSON.parse(JSON.stringify(v)); }
function fail(message) { throw new Error(`Native region: ${message}`); }
function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
function integer(v) { return Number.isSafeInteger(v); }
function close(a, b) { return finite(a) && finite(b) && Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(b)); }
function copyBuffer(b, maximum, label) {
  if (!(b instanceof ArrayBuffer) || b.byteLength > maximum || b.byteLength === 0) fail(`invalid ${label} buffer`);
  return b.slice(0); // Own the bytes before any async verification or caller mutation.
}
function parse(b, label) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)); }
  catch { return fail(`invalid ${label} JSON`); }
}
async function sha(b) {
  if (!globalThis.crypto?.subtle) fail('SHA256 requires a secure browser context');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), v => v.toString(16).padStart(2, '0')).join('');
}
function relative(path) {
  if (typeof path !== 'string' || !path || path.length > 256 || path.split('/').some(p => !/^[A-Za-z0-9_.-]+$/.test(p) || p === '.' || p === '..')) fail('unsafe relative resource path');
  return path;
}
function parentIdentity(p) {
  if (p?.schema !== 'maiforge.viewer-world/v1' || typeof p.id !== 'string' || !p.id
    || !integer(p.grid?.rows) || !integer(p.grid?.cols) || p.grid.rows < 4 || p.grid.cols < 4
    || !finite(p.radiusM) || p.radiusM <= 0 || !finite(p.epochMy) || p.epochMy < 0 || !integer(p.seed) || p.seed < 0
    || !digestPattern.test(p.sourceArtifacts?.terrain) || !digestPattern.test(p.sourceArtifacts?.hydrology)) fail('invalid parent world identity');
  return { id: p.id, seed: p.seed, epochMy: p.epochMy, radiusM: p.radiusM, nativeGrid: [p.grid.rows, p.grid.cols],
    sourceArtifacts: { terrain: p.sourceArtifacts.terrain, hydrology: p.sourceArtifacts.hydrology } };
}
function validateRegion(m, parent) {
  if (m?.schema !== 'maiforge.viewer-native-region/v1' || m.model !== MODEL || !digestPattern.test(m.id)) fail('unsupported schema/model/identity');
  if (!same(m.nativeGrid, parent.nativeGrid) || !same(m.processGrid, parent.nativeGrid.map(v => v * RESOLUTION))
    || m.seed !== parent.seed || m.epochMy !== parent.epochMy || m.radiusM !== parent.radiusM
    || !same(m.sourceArtifacts, parent.sourceArtifacts) || m.resolution !== RESOLUTION || m.apron !== APRON) fail('source pin, grid, epoch or resolution mismatch');
  if (!close(m.sourceResolutionM, m.radiusM * Math.PI / m.processGrid[0])) fail('invalid source spacing');
  const rect = m.coarseRectangle;
  if (!rect || !['rowStart', 'colStart', 'rowCount', 'colCount'].every(k => integer(rect[k]))
    || rect.rowStart < 0 || rect.rowCount < 1 || rect.colCount < 1 || rect.rowStart + rect.rowCount > m.nativeGrid[0]
    || rect.colStart < -m.nativeGrid[1] || rect.colStart >= m.nativeGrid[1] || rect.colCount > m.nativeGrid[1] / 2
    || rect.rowCount * rect.colCount > MAX_BLOCKS || !Array.isArray(m.blocks) || m.blocks.length !== rect.rowCount * rect.colCount) fail('invalid or incomplete rectangular coverage');
  if (!Number.isSafeInteger(m.processGrid[0] * m.processGrid[1])) fail('process address exceeds exact integer range');
  const expected = new Set();
  for (let y = 0; y < rect.rowCount; y++) for (let x = 0; x < rect.colCount; x++) expected.add((rect.rowStart + y) * m.nativeGrid[1] + mod(rect.colStart + x, m.nativeGrid[1]));
  const seen = new Set(), files = new Set();
  for (const b of m.blocks) {
    if (!integer(b?.cell) || !expected.has(b.cell) || seen.has(b.cell) || !shaPattern.test(b.sha256)) fail('duplicate, missing or unexpected block address');
    relative(b.file); if (files.has(b.file)) fail('duplicate block resource'); seen.add(b.cell); files.add(b.file);
  }
  if (seen.size !== expected.size) fail('incomplete coverage');
  validateSource(m.source, parent);
}
function validateSource(source, parent) {
  const s = source?.input;
  if (s?.schema !== 'maiforge.native-endpoint/v1' || s.seed !== parent.seed || s.epochMy !== parent.epochMy
    || s.radiusM !== parent.radiusM || !same(s.grid, parent.nativeGrid)
    || s.terrainArtifact !== parent.sourceArtifacts.terrain || s.hydrologyArtifact !== parent.sourceArtifacts.hydrology
    || !shaPattern.test(s.subgridSha256) || !digestPattern.test(s.stratigraphy)
    || source.hydrology?.artifact !== parent.sourceArtifacts.hydrology
    || source.initial_elevation_law !== 'native-centre-observations/monotone-c1/1') fail('invalid native source association');
}
function validateBlock(b, descriptor, region, parent) {
  if (b?.schema !== 'maiforge.native-process-block/v1' || b.model !== MODEL || !digestPattern.test(b.id) || b.cell !== descriptor.cell
    || !same(b.nativeGrid, region.nativeGrid) || !same(b.processGrid, region.processGrid) || b.radiusM !== region.radiusM
    || b.resolution !== RESOLUTION || b.apron !== APRON || !same(b.shape, [N, N])
    || b.grid?.rows !== N || b.grid?.cols !== N || b.grid?.order !== 'south-first' || b.grid?.sampling !== 'process-cell-centres'
    || !close(b.sourceResolutionM, region.sourceResolutionM)) fail('block shape/model mismatch');
  const row = Math.floor(b.cell / region.nativeGrid[1]), col = b.cell % region.nativeGrid[1];
  if (!same(b.originPost, [col * RESOLUTION - APRON, row * RESOLUTION - APRON])) fail('incorrect native block origin');
  if (!Array.isArray(b.poleHeightM) || b.poleHeightM.length !== 2 || !b.poleHeightM.every(finite)) fail('invalid pole convention');
  validateSource(b.source, parent); if (!same(b.source, region.source)) fail('mixed native block sources');
  const f = b.fields?.elevation;
  if (!f || Object.keys(b.fields).length !== 1 || f.type !== 'f32le' || f.unit !== 'm' || f.bytes !== HEIGHT_BYTES
    || !shaPattern.test(f.sha256) || !finite(f.maxQuantizationErrorM) || f.maxQuantizationErrorM < 0
    || typeof f.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(f.file)) fail('invalid solid-height descriptor');
  return f;
}
async function read(url, limit, fetchImpl) {
  const response = await fetchImpl(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'force-cache' });
  if (!response.ok) fail(`resource request failed (${response.status})`);
  const length = response.headers?.get?.('content-length');
  if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) fail('resource exceeds declared size bound');
  if (response.body?.getReader) {
    const reader = response.body.getReader(); const chunks = []; let total = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength;
      if (total > limit) { await reader.cancel(); fail('resource exceeds size bound'); } chunks.push(value); }
    const out = new Uint8Array(total); let offset = 0; for (const c of chunks) { out.set(c, offset); offset += c.byteLength; } return out.buffer;
  }
  return copyBuffer(await response.arrayBuffer(), limit, 'resource');
}

/** Immutable raw native solid geometry. No overview blending, water-surface
 * substitution, parallax displacement or physical-authority decision occurs here. */
export class NativeRegion {
  #regionBytes; #records;
  constructor(token, manifest, regionBytes, records, parent, stats) {
    if (token !== INTERNAL) fail('use load() or fromPayload()');
    this.#regionBytes = regionBytes; this.#records = records;
    this.manifest = freeze(jsonCopy(manifest)); this.id = manifest.id; this.parentId = parent.id;
    this.radiusM = manifest.radiusM; this.resolutionM = manifest.sourceResolutionM;
    const r = manifest.coarseRectangle;
    this.centre = Object.freeze({ latitude: ((r.rowStart + r.rowCount / 2) / manifest.nativeGrid[0] - 0.5) * Math.PI,
      longitude: mod((r.colStart + r.colCount / 2) / manifest.nativeGrid[1] * TAU, TAU) - Math.PI });
    this.heightRange = Object.freeze([stats.minimum, stats.maximum]);
    this.validation = Object.freeze({ blocks: records.size, sharedNodeComparisons: stats.shared, maximumSharedNodeDifferenceM: 0 });
    Object.freeze(this);
  }
  static async load(url, parentManifest, { fetchImpl = globalThis.fetch, onProgress = () => {} } = {}) {
    const parentSnapshot = jsonCopy(parentManifest); const parent = parentIdentity(parentSnapshot); const base = new URL(url, globalThis.location?.href ?? 'http://localhost/');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) fail('expected an HTTP(S) data URL without credentials');
    const regionBytes = await read(base, MAX_REGION_BYTES, fetchImpl); const region = parse(regionBytes, 'region'); validateRegion(region, parent);
    const blocks = new Array(region.blocks.length); let next = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(4, blocks.length) }, async () => {
      for (;;) { const i = next++; if (i >= blocks.length) return; const d = region.blocks[i];
        const blockURL = new URL(relative(d.file), base); const manifestBytes = await read(blockURL, MAX_BLOCK_MANIFEST_BYTES, fetchImpl);
        if (await sha(manifestBytes) !== d.sha256) fail(`block manifest hash mismatch (${d.cell})`);
        const block = parse(manifestBytes, 'block'); const field = validateBlock(block, d, region, parent);
        const heightBytes = await read(new URL(field.file, blockURL), HEIGHT_BYTES, fetchImpl);
        blocks[i] = { cell: d.cell, manifestBytes, heightBytes }; onProgress(++done / blocks.length);
      }
    }));
    return NativeRegion.fromPayload({ regionManifestBytes: regionBytes, blocks }, parentSnapshot);
  }
  static async fromPayload(payload, parentManifest) {
    const parent = parentIdentity(jsonCopy(parentManifest));
    if (!Array.isArray(payload?.blocks) || payload.blocks.length < 1 || payload.blocks.length > MAX_BLOCKS) fail('invalid worker block collection');
    const regionBytes = copyBuffer(payload.regionManifestBytes, MAX_REGION_BYTES, 'region manifest');
    const entries = payload.blocks.map(b => ({ cell: b.cell, manifestBytes: copyBuffer(b.manifestBytes, MAX_BLOCK_MANIFEST_BYTES, 'block manifest'),
      heightBytes: copyBuffer(b.heightBytes, HEIGHT_BYTES, 'height') }));
    const region = parse(regionBytes, 'region'); validateRegion(region, parent);
    if (entries.length !== region.blocks.length) fail('incomplete worker coverage');
    const descriptors = new Map(region.blocks.map(b => [b.cell, b])), records = new Map();
    let minimum = Infinity, maximum = -Infinity, shared = 0; const boundary = new Map(); let poles = null;
    for (const e of entries) {
      const d = descriptors.get(e.cell); if (!d || records.has(e.cell)) fail('duplicate or unrequested worker block');
      if (await sha(e.manifestBytes) !== d.sha256) fail(`block manifest hash mismatch (${e.cell})`);
      const b = parse(e.manifestBytes, 'block'); const f = validateBlock(b, d, region, parent);
      if (e.heightBytes.byteLength !== f.bytes || await sha(e.heightBytes) !== f.sha256) fail(`height hash/length mismatch (${e.cell})`);
      if (poles !== null && !same(poles, b.poleHeightM)) fail('inconsistent native pole values'); poles = b.poleHeightM;
      const view = new DataView(e.heightBytes); const values = new Float32Array(N * N);
      for (let i = 0; i < values.length; i++) {
        const value = view.getFloat32(i * 4, true); if (!finite(value) || value + region.radiusM <= 0) fail('nonfinite or invalid radial height');
        values[i] = value; minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
        const x = i % N, y = Math.floor(i / N);
        // Only these two-node boundary rings can overlap neighbouring blocks.
        if (x < 2 || x >= N - 2 || y < 2 || y >= N - 2) {
          const gx = mod(b.originPost[0] + x, region.processGrid[1]), gy = clamp(b.originPost[1] + y, 0, region.processGrid[0] - 1);
          const key = gy * region.processGrid[1] + gx, bits = view.getUint32(i * 4, true);
          if (boundary.has(key)) { shared++; if (boundary.get(key) !== bits) fail('shared native apron values disagree'); } else boundary.set(key, bits);
        }
      }
      records.set(e.cell, { manifest: b, manifestBytes: e.manifestBytes, heightBytes: e.heightBytes, values });
    }
    const footprint = region.coarseRectangle;
    if (footprint.rowStart === 0) { minimum = Math.min(minimum, poles[0]); maximum = Math.max(maximum, poles[0]); }
    if (footprint.rowStart + footprint.rowCount === region.nativeGrid[0]) { minimum = Math.min(minimum, poles[1]); maximum = Math.max(maximum, poles[1]); }
    return new NativeRegion(INTERNAL, region, regionBytes, records, parent, { minimum, maximum, shared });
  }
  workerPayload() {
    return { regionManifestBytes: this.#regionBytes.slice(0), blocks: Array.from(this.#records, ([cell, b]) => ({ cell,
      manifestBytes: b.manifestBytes.slice(0), heightBytes: b.heightBytes.slice(0) })) };
  }
  #position(lon, lat) {
    if (!finite(lon) || !finite(lat) || Math.abs(lat) > Math.PI / 2) return null;
    const [rows, cols] = this.manifest.nativeGrid, r = this.manifest.coarseRectangle;
    let x = mod((lon / TAU + 0.5) * cols - r.colStart, cols);
    const y = (lat / Math.PI + 0.5) * rows, epsilon = 1e-10;
    if (cols - x < epsilon) x = 0;
    if ((lat === -Math.PI / 2 && r.rowStart === 0) || (lat === Math.PI / 2 && r.rowStart + r.rowCount === rows)) x = r.colCount / 2;
    if (x > r.colCount + epsilon || y < r.rowStart - epsilon || y > r.rowStart + r.rowCount + epsilon) return null;
    return [clamp(x, 0, r.colCount), clamp(y, r.rowStart, r.rowStart + r.rowCount)];
  }
  contains(lon, lat) { return this.#position(lon, lat) !== null; }
  sample(lon, lat) {
    const p = this.#position(lon, lat); if (!p) return null;
    const r = this.manifest.coarseRectangle, [rows, cols] = this.manifest.nativeGrid;
    const cx = Math.min(Math.floor(p[0]), r.colCount - 1), cy = Math.min(Math.floor(p[1] - r.rowStart), r.rowCount - 1);
    const cell = (r.rowStart + cy) * cols + mod(r.colStart + cx, cols); const b = this.#records.get(cell); if (!b) fail('coverage lost after validation');
    const x = (p[0] - cx) * RESOLUTION + 0.5, y = (p[1] - r.rowStart - cy) * RESOLUTION + 0.5;
    const ix = clamp(Math.floor(x), 0, N - 2), iy = clamp(Math.floor(y), 0, N - 2), fx = x - ix, fy = y - iy;
    const row = yy => b.values[yy * N + ix] * (1 - fx) + b.values[yy * N + ix + 1] * fx;
    let value = row(iy) * (1 - fy) + row(iy + 1) * fy;
    const globalY = (lat / Math.PI + 0.5) * rows * RESOLUTION - 0.5;
    if (globalY < 0) value = b.manifest.poleHeightM[0] * (-2 * globalY) + value * (1 + 2 * globalY);
    if (globalY > rows * RESOLUTION - 1) { const w = 2 * (globalY - rows * RESOLUTION + 1); value = value * (1 - w) + b.manifest.poleHeightM[1] * w; }
    return value;
  }
  /** Presentation-only node composition, e.g. native water stage on wet nodes.
   * Raw sample() and stored solid heights are never changed. */
  sampleRenderSurface(lon, lat, nodeToSurface, poleSurfaceHeightM = null) {
    if (typeof nodeToSurface !== 'function') fail('render node transform is required');
    const p = this.#position(lon, lat); if (!p) return null;
    const r = this.manifest.coarseRectangle, [rows, cols] = this.manifest.nativeGrid;
    const cx = Math.min(Math.floor(p[0]), r.colCount - 1), cy = Math.min(Math.floor(p[1] - r.rowStart), r.rowCount - 1);
    const cell = (r.rowStart + cy) * cols + mod(r.colStart + cx, cols), b = this.#records.get(cell);
    const x = (p[0] - cx) * RESOLUTION + 0.5, y = (p[1] - r.rowStart - cy) * RESOLUTION + 0.5;
    const ix = clamp(Math.floor(x), 0, N - 2), iy = clamp(Math.floor(y), 0, N - 2), fx = x - ix, fy = y - iy;
    const at = (xx, yy) => {
      const gx = mod(b.manifest.originPost[0] + xx, this.manifest.processGrid[1]);
      const gy = clamp(b.manifest.originPost[1] + yy, 0, this.manifest.processGrid[0] - 1);
      const owner = Math.floor(gy / RESOLUTION) * cols + Math.floor(gx / RESOLUTION);
      const value = nodeToSurface(b.values[yy * N + xx], owner);
      if (!finite(value) || value + this.radiusM <= 0) fail('invalid render node result');
      return value;
    };
    const row = yy => at(ix, yy) * (1 - fx) + at(ix + 1, yy) * fx;
    let value = row(iy) * (1 - fy) + row(iy + 1) * fy;
    const poles = poleSurfaceHeightM ?? b.manifest.poleHeightM;
    if (!Array.isArray(poles) || poles.length !== 2 || !poles.every(finite)) fail('invalid render pole values');
    const globalY = (lat / Math.PI + 0.5) * rows * RESOLUTION - 0.5;
    if (globalY < 0) value = poles[0] * (-2 * globalY) + value * (1 + 2 * globalY);
    if (globalY > rows * RESOLUTION - 1) { const w = 2 * (globalY - rows * RESOLUTION + 1); value = value * (1 - w) + poles[1] * w; }
    return value;
  }
  /** Spherical footprint distances for a smooth per-edge rendering guard.
   * They do not depend on terrain elevation or imply physical contact authority. */
  boundaryDistancesM(lon, lat) {
    const p = this.#position(lon, lat); if (!p) return Object.freeze({ south: 0, north: 0, west: 0, east: 0 });
    const [rows, cols] = this.manifest.nativeGrid, r = this.manifest.coarseRectangle;
    const south = (r.rowStart / rows - 0.5) * Math.PI, north = ((r.rowStart + r.rowCount) / rows - 0.5) * Math.PI;
    const meridian = delta => {
      if (delta <= 1e-14) return 0;
      const optimum = Math.atan2(Math.sin(lat), Math.cos(lat) * Math.cos(delta));
      const candidates = [south, north]; if (optimum >= south && optimum <= north) candidates.push(optimum);
      return Math.min(...candidates.map(t => {
        const h = Math.sin((lat - t) / 2) ** 2 + Math.cos(lat) * Math.cos(t) * Math.sin(delta / 2) ** 2;
        return 2 * Math.asin(Math.sqrt(clamp(h, 0, 1))) * this.radiusM;
      }));
    };
    return Object.freeze({ south: Math.max(0, lat - south) * this.radiusM, north: Math.max(0, north - lat) * this.radiusM,
      west: meridian(p[0] / cols * TAU), east: meridian((r.colCount - p[0]) / cols * TAU) });
  }
  /** Minimum distance to the footprint boundary; zero outside. A minimum is not
   * C1 on corner bisectors: use per-edge distances for a C1 proxy weight. */
  distanceToBoundaryM(lon, lat) { return Math.min(...Object.values(this.boundaryDistancesM(lon, lat))); }
}
