# GeoPano3D: street-level 360° + DEM → photogrammetry bundles

GeoPano3D turns an area you draw on a map into a ready-to-run project for **Agisoft Metashape Pro** and **RealityCapture**:

1. **Sample**: points every *N* m along OSM roads (Overpass) or on a metric grid.
2. **Harvest**: 360° panoramas + poses from Google Street View (Map Tiles API), Mapillary, your own uploads, or a built-in synthetic street.
3. **Dual depth**: *Dataset A* = Street View planar depth (or a road-plane metric prior) × *Dataset B* = Depth-Anything-V2 monocular depth, fitted with RANSAC/IQR, then cross-validated.
4. **Mask**: sky, cars, pedestrians and reflections → `_mask.png`; fused metric depth → 16-bit z-depth PNGs.
5. **Project**: undistorted 90° pinhole faces (f35 = 18 mm), with exact intrinsics in EXIF, XMP and CSV.
6. **DEM**: the highest-resolution terrain available (USGS 3DEP 1 m, Copernicus 30 m, AWS Terrarium), exported as GeoTIFF + terrain mesh. It is also used to give every camera an orthometric altitude.
7. **Export**: a `.zip` with images, masks, depth, `reference_metashape.csv`, `flightlog_realitycapture.csv`, per-image `.xmp`, an auto-import script and a full manifest.

The full spec and the deviations from it are in [`CLAUDE.md`](CLAUDE.md).

## Quick start

```bash
pip install -e ".[dev]"            # add ",ai" for real Depth-Anything-V2 (torch + transformers)
cp .env.example .env               # all keys optional
pytest tests/ -v
uvicorn backend.main:app --reload  # API on :8000
```

```bash
cd frontend && npm install && npm run dev   # UI on :5173 (proxies /api to :8000)
```

Or run `npm run build` once; FastAPI then serves the UI itself at http://localhost:8000.

**Without any keys** everything still works. The AOI resolves to a procedural street canyon whose textures are tied to world coordinates. Every panorama ships true planar depth in the Street View binary format, plus transient cars and pedestrians. Without torch, the AI stage uses a deterministic fallback (oracle depth under an unknown affine transform for synthetic scenes, a geometric prior otherwise).

## Imagery sources & licensing ⚠️

| Source | Key | Depth (Dataset A) | Licence for 3D reconstruction |
| --- | --- | --- | --- |
| `google` | `GOOGLE_MAPS_API_KEY` (Map Tiles API) | not exposed by the official API → road-plane prior | **Restricted.** Google Maps Platform terms prohibit creating 3D models or derived datasets from Street View content. Check your agreement before reconstructing. |
| `mapillary` | `MAPILLARY_ACCESS_TOKEN` | road-plane prior | CC-BY-SA 4.0: derived 3D works allowed with attribution |
| `local` | – (`POST /api/pano/upload`) | optional `raw_depth_b64` | yours (Insta360 / GoPro Max / Ricoh Theta captures) |
| `synthetic` | – | exact | free |

GeoPano3D only uses documented endpoints. It never scrapes Google's internal `photometa` service. If you legitimately hold a Street View depth buffer, pass it as `raw_depth_b64` and the planar decoder (`depth_decoder.py`) is used.

## DEM

`DEM_SOURCE=auto` picks the best source available:

1. **OpenTopography** (`OPENTOPOGRAPHY_API_KEY`, free): USGS 3DEP **1 m** → 10 m in the USA, then Copernicus GLO-30. Rasters in any CRS are reprojected to EPSG:4326.
2. **AWS Terrain Tiles (Terrarium z15)**: no key. About 3–5 m/px, a composite of national lidar DTMs, 3DEP and SRTM.

Higher-resolution national lidar (e.g. 0.5 m) can be read with `dem_service.read_geotiff()` in any EPSG CRS. The bundle contains `dem/dem_epsg4326.tif`, `dem/terrain_local_enu.obj` and `dem/hillshade.png`. Heights are orthometric, so the Metashape script uses EPSG::9707 (WGS 84 + EGM96).

## Using the bundle

* **Metashape**: *Tools → Run Script → `metashape_auto_import.py`*. It creates a fixed 18 mm frame sensor (or a spherical sensor), puts each panorama's faces into a **Camera Station**, sets reference positions and orientations with accuracies, loads the masks, imports the DEM, then runs mask-filtered matching, alignment and optimisation. Set `RUN_DENSE = True` to also build the mesh.
* **RealityCapture**: set the project CRS to the UTM EPSG printed in `README.txt`, then drag in `images/`. The XMP sidecars carry exact calibration and a pose prior (`initial` by default; `locked` / `exact` are selectable).

## API

| Method | Endpoint | |
| --- | --- | --- |
| GET | `/api/health` | device, AI backend, configured sources |
| POST | `/api/aoi/sample` | AOI → deduplicated `PanoMetadata` (+ DEM altitudes) |
| POST | `/api/pano/upload` | register your own equirectangular image |
| POST | `/api/pano/{id}/process` | tiles → A → B → validation (`ai_mode`: `cubemap` \| `panorama`) |
| POST | `/api/pano/{id}/revalidate` | new τ / α without re-inference |
| GET | `/api/pano/{id}/layers/{rgb\|sv_depth\|ai_depth\|fused_depth\|discrepancy\|confidence\|mask}` | PNG |
| GET | `/api/pano/{id}/arrays` | float32 planes for the pixel inspector / scanline |
| GET | `/api/pano/{id}/cubemap/{face}?layer=` | 90° pinhole face |
| POST | `/api/dem` | best DEM + hillshade for a polygon |
| POST | `/api/export/preview` | text of generated CSV / XMP / script |
| POST | `/api/export/package` → GET `/api/jobs/{id}` or WS `/api/ws/jobs/{id}` → GET `/api/export/download/{id}` | zip job |
