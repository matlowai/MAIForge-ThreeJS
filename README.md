# MAIForge Three.js engine adapter

A self-contained browser client for [MAIForge](https://github.com/matlowai/MAIForge)
worlds. Three.js supplies the rendering and browser interaction; MAIForge retains
world generation, scientific models, stable identities and gameplay authority.
No other game engine, private data directory, model pack or texture pack is needed.

## Run

Use Node.js 22.12 or newer. From this repository:

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. The included verified reference world is about
3 MB of numeric fields; runtime code, textures and fonts require no CDN. Initial
installation downloads the locked npm dependencies. For a static deployment:

```sh
npm test
npm run build
npm run preview
```

`dist/` can be hosted under a subdirectory. Serve over HTTP(S), not `file://`.
WebGL2 is required. The GPU and actual depth mode appear in the performance panel.

## Explore

Drag to orbit, scroll to descend, or use Planet / 1,000 km / Surface. Near the
ground, drag to look, WASD to move, Q/E to change altitude; Shift moves faster.
Right-drag pans. Click terrain to inspect the source fields. H opens help.
Low/Balanced/High control the mesh and pixel budgets. Climate/Rock/Height are
visualizations of supplied fields, not additional simulation.

## What is implemented

- A six-face spherical quadtree, balanced across face boundaries, with stitched
  coarse/fine edges. Existing parent coverage remains until children are ready.
- Camera-relative positions and patch-local float geometry for planetary scale.
- Reversed depth where available, with logarithmic depth as a fallback.
- Two terrain workers, source-bound requests and bounded tile caches.
- Extra refinement around the camera, with clearance checked against the actual
  rendered triangles. This is an inspection camera, not authoritative physics.
- Generated field textures, mipmaps and world-anchored visual grain. Turning the
  camera changes representation; it does not regenerate the underlying world.
- Hash-checked native data, explicit units, pole/wrap rules and source resolution.

This first release is a rendering foundation, not a complete gameplay engine.
There is no native edit/collision service, tree renderer or multiplayer layer yet.
LOD changes retain coverage and stitched edges, but do not yet geomorph; visible
popping can remain. Performance depends on the GPU and viewport.

## Data fidelity

The bundled world has 576 × 288 native cells, approximately **69.5 km spacing**.
You can descend to a few metres above its interpolated surface, but finer mesh
triangles and procedural grain do not supply missing fine geological history.
Water stages come from the native hydrology. The colour palette is an appearance
prior; it is not a physically calibrated material or ecosystem map.

The core includes exporters for canonical native process blocks (about 543 m
spacing for this reference). `NativeRegion` validates complete bounded regions.
An experimental optional path also requires a complete same-model `NativeProxy`;
it is **disabled in the bundled world**. Its bounded global proxy export did not
finish within its compute budget. A coarse input field and the relaxed native
terrain can differ by kilometres, so they must not be silently treated as one
accurate LOD hierarchy. Regional edge blending is only a display approximation.

No runtime Rust service is needed for the bundled example. Generating a new world
or native detail uses the public MAIForge Rust pipeline. See
[the data contract](docs/DATA.md) and [adapter interface](docs/ADAPTER.md).

## License

Project code and the bundled project-generated fields are AGPL-3.0-only; see
LICENSE, DATA_NOTICES.md and THIRD_PARTY_NOTICES.md. If AGPL does not fit,
[please say hello to MATLOWAI](https://github.com/matlowai/MAIForge/issues).
**Separate licenses may be free or negotiated to suit the people and project.**
Individuals, hobbyists and small teams are welcome. Alternative permissions need
an explicit written agreement; third-party rights remain applicable.

Contributions require the acknowledgement in CONTRIBUTING.md and the PR template.
