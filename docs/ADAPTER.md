# Adapter boundary

Import `PlanetEngine`, `WorldData` and `GeoCamera` from `src/index.js` in a Vite
or equivalent ES module project. The runnable app is `src/main.js`; the engine
has no dependency on its HTML controls.

```js
import { PlanetEngine } from './src/index.js';
const engine = new PlanetEngine(canvas, {
  onStats: stats => updatePerformance(stats),
  onError: message => showError(message),
});
await engine.connect('/data/my-world/manifest.json');
engine.controls.preset('surface');
engine.addEventListener('pick', event => inspect(event.detail.sample));
// When unmounting:
engine.dispose();
```

Create a new instance to replace a connected world. `setQuality`, `setMode`,
`setWireframe` and `stats` provide presentation controls. `WorldData.sample`
returns native overview fields and separately named render/native-region fields
when available. `sampleHeight` is the renderer's surface approximation; do not use
it as a finite-material or authoritative gameplay query.

Core responsibilities: generation, geological rules, material identities,
water-state provenance, edits and canonical physical queries. Adapter
responsibilities: loading and validating supplied data, render geometry, origin
conversion, GPU materials, browser input, inspection and display LOD.

A future native/WASM service can provide canonical process blocks through the
same source-bound data seam. No HTTP/WASM service is implemented here. Keep
source hashes and model versions consistent; an engine adapter must not supply
missing historical simulation by inventing visual detail.
