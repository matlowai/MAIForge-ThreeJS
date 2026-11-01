# Native world data

`public/data/reference/manifest.json` declares the bundled numeric fields, units,
SHA-256 hashes, source artifact identities, native grid and interpolation rule.
The loader checks hashes before using fields. Grid rows run south to north;
longitude wraps; cell-centred bilinear interpolation converges to polar-row means.
Coordinates use +Y north, +X longitude zero, +Z longitude +90 degrees, metres.

Required fields: solid elevation, rendered surface height including native water
stages, lithology code and water kind. Optional temperature and precipitation
remain absent when not produced. A missing field is not filled with synthetic
climate. The material codes and water stages are coarse contextual observations.

From MAIForge's root, export a verified native world:

```sh
bash scripts/export_viewer.sh path/to/native-world viewer/public/data/user/my-world
```

Then open `?world=./data/user/my-world/manifest.json`. The loader permits an
explicit world URL; the remote server must permit CORS. Credentials are omitted.
Do not put secrets in public manifests or resources. `public/data/user/` is
ignored by Git; deliberately copy only reviewed public data for deployment.

The core examples `maiforge_native_block`, `maiforge_native_region` and
`maiforge_native_proxy` expose development paths for process-grid heights.
`NativeRegion` preserves raw heights, validates canonical shared aprons, and
revalidates transferred worker bytes. `NativeProxy` decodes explicitly positioned
sparse residual controls of the same model. Optional manifest paths `nativeRegion`
and `nativeProxy` must both be present; a complete matched pair is required.
These features are experimental and are not enabled in the bundled reference.

The global reference is a retained generated endpoint with source hashes. Its
exact historic recipe is not claimed reproducible from the current source.
Fresh public example data can be exported through the same pipeline; a rendered
result does not imply acceptance of every scientific diagnostic.
