# CLAUDE.md — Full-Stack Implementation Blueprint: Street View 360° & Dual-Depth Photogrammetry Pipeline (Metashape & RealityCapture)

## 1. Mission & Agent Instructions for Claude Code

You are building **GeoPano3D**, a full-stack web application and Python photogrammetry processing pipeline. The system enables users to select a geographic Area of Interest (AOI) on an interactive map, harvest 360° Google Street View panoramas and camera pose metadata, extract and cross-validate two distinct depth datasets (**Dataset A: Street View Native Planar Depth** and **Dataset B: Monocular AI Depth**), automatically generate sky and dynamic-object photogrammetry masks (`_mask.png`), project spherical panoramas into rectilinear pinhole cubemap faces, and package the outputs into turnkey project bundles for **Agisoft Metashape Pro** and **Capturing Reality (RealityCapture)**.

### Core Engineering Rules for Claude Code
1. **Language & Stack:** Python 3.11+ backend (FastAPI, NumPy, OpenCV, PyTorch, Transformers, Httpx, Pydantic v2, Shapely, PyProj) + React 18 / TypeScript / Vite / Tailwind CSS / Leaflet frontend.
2. **Strict Type Safety & Vectorization:** Use Python type hints everywhere. Never use nested Python `for` loops over image pixels; all raycasting, depth alignment, and equirectangular-to-cubemap projections must be fully vectorized with NumPy and `cv2.remap`.
3. **Test-Driven Verification:** After implementing each module, run `pytest tests/ -v` to verify mathematical and geometric invariants before proceeding to the next phase.
4. **Photogrammetric Rigor:** Never apply uncalibrated perspective crops without recording exact intrinsic focal length ($f_{35\text{mm}} = 18.0\text{ mm}$ for $\text{FOV} = 90^\circ$ square cubemap faces) and extrinsic Euler orientation angles ($\text{Yaw}, \text{Pitch}, \text{Roll}$) in the exported CSV and `.xmp` sidecar files.

## 2. Target Repository Structure

Create and maintain the following directory layout:

```text
geopano3d/
├── CLAUDE.md                                # This specification and build guide
├── .env.example                             # Environment variable template
├── pyproject.toml                           # Python dependencies & pytest config
├── backend/
│   ├── __init__.py
│   ├── main.py                              # FastAPI application entrypoint & CORS
│   ├── config.py                            # Pydantic Settings (API keys, paths, thresholds)
│   ├── models/
│   │   ├── __init__.py
│   │   └── schemas.py                       # Pydantic request/response & node schemas
│   ├── services/
│   │   ├── __init__.py
│   │   ├── aoi_sampler.py                   # Polygon road-network & grid coordinate sampler
│   │   ├── streetview_client.py             # Async Google Map Tiles API & photometa client
│   │   ├── tile_stitcher.py                 # 360° equirectangular multi-tile assembler
│   │   ├── depth_decoder.py                 # Dataset A: Street View base64/zlib planar depth parser
│   │   ├── ai_depth_estimator.py            # Dataset B: Depth Anything V2 inference wrapper
│   │   ├── dual_depth_validator.py          # RANSAC metric alignment, discrepancy & mask generator
│   │   ├── cubemap_projector.py             # Equirectangular to 6-face pinhole cubemap converter
│   │   └── exporters.py                     # Metashape CSV/script & RealityCapture FlightLog/XMP
│   └── api/
│       ├── __init__.py
│       └── routes.py                        # REST & WebSocket progress endpoints
├── scripts/
│   └── metashape_auto_import.py             # Template script bundled into exported Metashape zips
├── tests/
│   ├── test_depth_decoder.py                # Unit tests for binary depth parsing & raycasting
│   ├── test_dual_depth_validator.py         # Unit tests for RANSAC scale/shift & mask generation
│   ├── test_cubemap_projector.py            # Unit tests for pinhole projection & FOV geometry
│   └── test_exporters.py                    # Unit tests for Metashape CSV & RealityCapture XMP
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── App.tsx
        ├── api/client.ts                    # Typed API client for FastAPI backend
        └── components/
            ├── MapSelector.tsx              # Leaflet polygon/rectangle drawing & node markers
            ├── DualDepthInspector.tsx       # Interactive canvas for SV vs AI depth & scanline chart
            ├── CubemapPreview.tsx           # 6-face rectilinear pinhole viewer
            └── ExportBuilder.tsx            # Metashape & RealityCapture package configuration
```

## 3. Environment & Dependencies

### 3.1 Backend Dependencies (`pyproject.toml`)

```toml
[project]
name = "geopano3d"
version = "1.0.0"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.111.0",
    "uvicorn[standard]>=0.30.0",
    "httpx[http2]>=0.27.0",
    "numpy>=1.26.4",
    "opencv-python-headless>=4.10.0.84",
    "Pillow>=10.3.0",
    "scipy>=1.13.0",
    "shapely>=2.0.4",
    "pyproj>=3.6.1",
    "piexif>=1.1.3",
    "pydantic>=2.7.0",
    "pydantic-settings>=2.3.0",
    "torch>=2.3.0",
    "transformers>=4.41.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.2.0",
    "pytest-asyncio>=0.23.7",
]
```

### 3.2 Environment Variables (`.env.example`)

```ini
GOOGLE_MAPS_API_KEY=your_google_maps_tile_api_key_here
OVERPASS_API_URL=https://overpass-api.de/api/interpreter
AI_DEPTH_MODEL_ID=depth-anything/Depth-Anything-V2-Small-hf
DEFAULT_DISCREPANCY_THRESHOLD_M=0.85
DEFAULT_CUBEMAP_FACE_SIZE=1024
EXPORT_WORK_DIR=./exports
```

## 4. Module-by-Module Technical Specifications

### 4.1 Data Schemas (`backend/models/schemas.py`)

Implement strict Pydantic v2 models for all pipeline stages:

```python
from enum import Enum
from typing import Dict, List, Optional, Tuple
from pydantic import BaseModel, Field

class SamplingMode(str, Enum):
    ROAD_NETWORK = "road"
    GRID = "grid"

class TargetSoftware(str, Enum):
    METASHAPE = "metashape"
    REALITY_CAPTURE = "realitycapture"
    BOTH = "both"

class CameraGeometryMode(str, Enum):
    CUBEMAP_4 = "cubemap4"          # front, right, back, left (recommended)
    CUBEMAP_6 = "cubemap6"          # includes zenith (up) and nadir (down)
    EQUIRECTANGULAR = "equirectangular"

class AOIRequest(BaseModel):
    polygon_latlon: List[Tuple[float, float]] = Field(..., min_length=3)
    step_meters: float = Field(default=8.0, ge=3.0, le=50.0)
    sampling_mode: SamplingMode = SamplingMode.ROAD_NETWORK

class PanoMetadata(BaseModel):
    pano_id: str
    lat: float
    lon: float
    alt: float = 0.0
    heading: float = 0.0            # degrees clockwise from North [0, 360)
    pitch: float = 0.0              # degrees [-90, 90]
    roll: float = 0.0               # degrees [-180, 180]
    capture_date: Optional[str] = None
    raw_depth_b64: Optional[str] = None

class DepthValidationMetrics(BaseModel):
    scale_factor: float
    shift_m: float
    rmse_m: float
    mae_m: float
    abs_rel: float
    inlier_ratio_pct: float
    valid_surface_pct: float
```

### 4.2 Module 1: AOI Geospatial Sampler (`backend/services/aoi_sampler.py`)

- **Input:** `AOIRequest` containing `polygon_latlon` in `EPSG:4326` and `step_meters`.
- **Algorithm:**
  1. Construct a `shapely.geometry.Polygon` from the input coordinates.
  2. Transform the polygon to a local metric UTM projection via `pyproj.Transformer` to measure exact distances in meters.
  3. If `sampling_mode == SamplingMode.ROAD_NETWORK`:
     - Query the Overpass API for `way["highway"~"^(primary|secondary|tertiary|residential|unclassified|pedestrian)$"]` inside the polygon bounding box.
     - Clip each road `LineString` to the polygon boundary and interpolate sample points every `step_meters` along each line.
  4. If `sampling_mode == SamplingMode.GRID`:
     - Generate a 2D Cartesian grid spaced by `step_meters` inside the UTM polygon bounds, filter points via `polygon.contains(pt)`, and transform back to `(lat, lon)`.

### 4.3 Module 2: Street View Tile & Metadata Client (`backend/services/streetview_client.py` & `tile_stitcher.py`)

- **Metadata Discovery:**
  - Use Google Map Tiles API Street View endpoints (`https://tile.googleapis.com/v1/streetview/panoIds` and `/v1/streetview/metadata`) to resolve each candidate `(lat, lon)` into a unique `PanoMetadata` record, deduplicating by `pano_id`.
- **360° Equirectangular Stitching:**
  - Street View panoramas are tiled at zoom levels $z \in \{3, 4, 5\}$.
  - At zoom $z$, tile size is $512 \times 512$, grid dimensions are $\text{cols} = 2^z$, $\text{rows} = 2^{z-1}$ (or $7 \times 4$ at $z=3$, $13 \times 7$ at $z=4$, $26 \times 13$ at $z=5$).
  - Download all tiles concurrently using `httpx.AsyncClient(http2=True)` with a semaphore (`asyncio.Semaphore(16)`), paste them into a single `np.uint8` canvas, and crop to the exact $2:1$ equirectangular aspect ratio.

### 4.4 Module 3: Dataset A — Street View Native Planar Depth Parser (`backend/services/depth_decoder.py`)

Google Street View's internal depth map is a base64 URL-safe, zlib-compressed binary buffer encoding 3D plane equations derived from LiDAR / stereo sweeps.

- **Binary Format Specification:**
  1. Replace `-` with `+` and `_` with `/`, pad string length to a multiple of 4 with `=`, base64-decode, and decompress via `zlib.decompress(raw_bytes)`.
  2. Unpack the 8-byte little-endian header:
     ```python
     header_size, num_planes, width, height, offset = struct.unpack("<BHHHB", data[:8])
     ```
  3. Extract the pixel-to-plane index array of shape `(height, width)`:
     ```python
     n_pixels = width * height
     plane_indices = np.frombuffer(data, dtype=np.uint8, count=n_pixels, offset=offset).reshape((height, width))
     ```
     Note: `plane_indices == 0` always represents sky or infinitely distant pixels.
  4. Extract the plane parameters array of shape `(num_planes, 4)` starting at `offset + n_pixels`:
     ```python
     planes = np.frombuffer(data, dtype="<f4", count=num_planes * 4, offset=offset + n_pixels).reshape((num_planes, 4))
     ```
     Each row $k$ contains $[n_x, n_y, n_z, d]$ satisfying the plane equation $\mathbf{n}_k \cdot \mathbf{x} - d_k = 0$.
- **Vectorized Spherical Raycasting:**
  1. For normalized pixel coordinates $u = \frac{x + 0.5}{W} \in (0, 1)$ and $v = \frac{y + 0.5}{H} \in (0, 1)$:
     $$\theta = (1.0 - u) \cdot 2\pi - \frac{\pi}{2}, \quad \phi = (1.0 - v) \cdot \pi$$
  2. Construct unit ray vectors $\mathbf{r}(y, x)$:
     $$r_x = \sin\phi \cos\theta, \quad r_y = \sin\phi \sin\theta, \quad r_z = \cos\phi$$
  3. Compute ray intersection distance $D_{\text{sv}}(y, x)$ in meters:
     $$D_{\text{sv}}(y, x) = \frac{d_{\text{idx}(y,x)}}{\mathbf{r}(y, x) \cdot \mathbf{n}_{\text{idx}(y,x)}}$$
  4. Set pixels where `plane_indices == 0`, denominator $\le 10^{-5}$, or $D_{\text{sv}} \notin [0.5, 250.0]$ to `np.nan`.

### 4.5 Module 4: Dataset B — Monocular AI Depth Estimator (`backend/services/ai_depth_estimator.py`)

- Load `depth-anything/Depth-Anything-V2-Small-hf` (or `Large-hf`) via `transformers.AutoImageProcessor` and `AutoModelForDepthEstimation`.
- Support CUDA, Apple Silicon (`mps`), and CPU execution automatically.
- Important: Because Vision Transformers exhibit distortion at the poles of equirectangular images, provide two inference modes:
  1. **Panorama Mode:** Run inference on the equirectangular image and convert predicted disparity/inverse-depth into relative metric depth $D_{\text{ai\_raw}}$.
  2. **Per-Cubemap-Face Mode (Preferred for High Precision):** Project both RGB and $D_{\text{sv}}$ into rectilinear $90^\circ$ pinhole cubemap faces first, then run `Depth-Anything-V2` on each undistorted rectilinear face.

### 4.6 Module 5: Dual-Depth Cross-Validation & Masking Engine (`backend/services/dual_depth_validator.py`)

This is the core quality-control module that fuses **Dataset A** (true metric scale, low-frequency planes) and **Dataset B** (uncalibrated scale, high-frequency architectural detail) to verify geometric accuracy and mask transient obstacles.

- **Step 1 — Upsampling & Joint Valid Mask:**
  - Resize $D_{\text{sv}}$ to match $D_{\text{ai\_raw}}$ dimensions `(H, W)` using `cv2.INTER_NEAREST` (never use linear interpolation across `NaN` sky boundaries).
  - Define the joint valid mask:
    $$M_{\text{joint}} = \text{isfinite}(D_{\text{sv}}) \land (1.0 < D_{\text{sv}} < d_{\max}) \land \text{isfinite}(D_{\text{ai\_raw}}) \land (D_{\text{ai\_raw}} > 10^{-4})$$
- **Step 2 — Robust Metric Scale ($s$) & Shift ($t$) Alignment:**
  - Because $D_{\text{ai\_raw}}$ may be affine-shifted relative depth, solve for $(s, t)$ using IQR/RANSAC-filtered Least Squares over inlier pixels:
    $$\min_{s, t} \sum_{(y, x) \in M_{\text{inliers}}} \left( D_{\text{sv}}(y, x) - \left(s \cdot D_{\text{ai\_raw}}(y, x) + t\right) \right)^2$$
  - Compute metric-aligned AI depth:
    $$D_{\text{ai\_metric}} = \text{clip}\left(s \cdot D_{\text{ai\_raw}} + t,\ 0.5,\ d_{\max}\right)$$
- **Step 3 — Cross-Validation Discrepancy & Confidence Map:**
  - Compute absolute metric discrepancy in meters:
    $$\Delta(y, x) = \left| D_{\text{sv}}(y, x) - D_{\text{ai\_metric}}(y, x) \right|$$
  - Compute per-pixel confidence score $C(y, x) \in [0, 1]$ given threshold $\tau$ (default $\tau = 0.85\text{ m}$):
    $$C(y, x) = \exp\left(-\frac{\Delta(y, x)^2}{2 \tau^2}\right)$$
- **Step 4 — Fused Metric Depth & Photogrammetry Mask (`_mask.png`):**
  - Pixels where $\Delta(y, x) \le \tau$ and $(y, x) \in M_{\text{joint}}$ are classified as **Verified Static Surfaces** (`inlier_pixels`).
  - Pixels where $\Delta(y, x) > \tau$ or `plane_indices == 0` correspond to:
    - Sky domes (`plane_indices == 0`)
    - Moving cars, buses, and pedestrians (present in RGB / $D_{\text{ai\_metric}}$ at short range, absent in $D_{\text{sv}}$ background wall plane)
    - Specular window reflections and tree canopy noise
  - Generate the binary photogrammetry mask (`np.uint8`):
    ```python
    mask = np.where(inlier_pixels, 255, 0).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    ```
  - Generate the fused metric depth map (`np.float32`, meters) combining AI architectural detail with SV planar stability:
    $$D_{\text{fused}}(y, x) = \begin{cases} \alpha \cdot D_{\text{ai\_metric}}(y, x) + (1 - \alpha) \cdot D_{\text{sv}}(y, x) & \text{if } \text{mask}(y, x) == 255 \\ \text{NaN} & \text{otherwise} \end{cases}$$
    where default $\alpha = 0.75$.

### 4.7 Module 6: Equirectangular-to-Cubemap Pinhole Projector (`backend/services/cubemap_projector.py`)

Standard SfM/MVS solvers (especially RealityCapture) perform best with undistorted perspective images rather than $360^\circ$ spherical projections.

| Face Name | Relative Yaw ($\Delta \psi$) | Relative Pitch ($\Delta \theta$) | FOV | 35mm Equivalent Focal Length | Default Export |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `front` | $0.0^\circ$ | $0.0^\circ$ | $90.0^\circ$ | $18.0000\text{ mm}$ | Yes |
| `right` | $90.0^\circ$ | $0.0^\circ$ | $90.0^\circ$ | $18.0000\text{ mm}$ | Yes |
| `back` | $180.0^\circ$ | $0.0^\circ$ | $90.0^\circ$ | $18.0000\text{ mm}$ | Yes |
| `left` | $270.0^\circ$ | $0.0^\circ$ | $90.0^\circ$ | $18.0000\text{ mm}$ | Yes |
| `up` | $0.0^\circ$ | $+90.0^\circ$ | $90.0^\circ$ | $18.0000\text{ mm}$ | Optional (`cubemap6`) |
| `down` | $0.0^\circ$ | $-90.0^\circ$ | $90.0^\circ$ | $18.0000\text{ mm}$ | Optional (`cubemap6`) |

- **Exact Projection Implementation:**
  - Given face resolution $S \times S$ (default $1024 \times 1024$ or $2048 \times 2048$) and $\text{FOV} = 90^\circ$, focal length in pixels is $f = 0.5 \cdot S / \tan(45^\circ) = 0.5 \cdot S$.
  - Construct pixel grid $u, v \in [-S/2 + 0.5,\ S/2 - 0.5]$, set $x = u$, $y = -v$, $z = f$, and normalize $\mathbf{d} = [x, y, z]^T / \|\mathbf{d}\|$.
  - Rotate ray directions by $R = R_y(\text{yaw}) \cdot R_x(\text{pitch})$, convert world ray $(w_x, w_y, w_z)$ to spherical $(\text{lon}, \text{lat}) = (\text{atan2}(w_x, w_z),\ \arcsin(w_y))$, map to equirectangular pixel coordinates `(map_x, map_y)`, and sample via `cv2.remap`.
  - Use `cv2.INTER_LINEAR` for RGB imagery and `cv2.INTER_NEAREST` for depth maps and binary masks (`_mask.png`).

### 4.8 Module 7: Agisoft Metashape & RealityCapture Exporters (`backend/services/exporters.py`)

When exporting a project, generate the following directory tree and zip archive:

```text
<project_name>/
├── images/
│   ├── <pano_id>_front.jpg
│   ├── <pano_id>_front.xmp                 # RealityCapture locked camera prior
│   └── ...
├── masks/
│   ├── <pano_id>_front_mask.png            # 8-bit binary mask (255=valid, 0=masked)
│   └── ...
├── depth_validated/
│   ├── <pano_id>_front_depth_mm.png        # 16-bit unsigned integer depth in millimeters
│   └── ...
├── reference_metashape.csv                 # Agisoft Metashape Reference table (EPSG:4326)
├── flightlog_realitycapture.csv            # RealityCapture Flight Log CSV
├── metashape_auto_import.py                # Automated Metashape Pro Python script
└── pipeline_manifest.json                  # Full validation metrics & audit log
```

#### 1. Agisoft Metashape Reference CSV (`reference_metashape.csv`)
For each exported image (either 360° equirectangular or each cubemap face where `abs_yaw = (node.heading + rel_yaw) % 360.0`):
```csv
#Label,Longitude,Latitude,Altitude,Yaw,Pitch,Roll,Accuracy_XY,Accuracy_Z,Accuracy_YPR,Validated_RMSE_m
sv_galata_001_front.jpg,28.97412800,41.02564200,38.400,118.500,1.200,0.000,1.20,1.80,2.00,0.312
```

#### 2. RealityCapture Sidecar XMP (`images/<pano_id>_<face>.xmp`)
Every cubemap image must have a companion `.xmp` sidecar that locks the 35mm equivalent focal length to `18.0000` ($\text{FOV}=90^\circ$) and sets `xcr:PosePrior="locked"`:
```xml
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xcr="http://www.capturingreality.com/ns/xcr/1.1#"
    xcr:Version="3"
    xcr:PosePrior="locked"
    xcr:Coordinates="absolute"
    xcr:DistortionModel="perspective"
    xcr:FocalLength35mm="18.0000"
    xcr:Skew="0"
    xcr:AspectRatio="1"
    xcr:PrincipalPointU="0"
    xcr:PrincipalPointV="0"
    xcr:Latitude="41.02564200"
    xcr:Longitude="28.97412800"
    xcr:Altitude="38.400"
    xcr:Yaw="118.500"
    xcr:Pitch="1.200"
    xcr:Roll="0.000">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
```

#### 3. Agisoft Metashape Auto-Import Script (`metashape_auto_import.py`)
Bundle a ready-to-run script for Agisoft Metashape Pro (*Tools -> Run Script*) that:
1. Creates a chunk with `chunk.crs = Metashape.CoordinateSystem("EPSG::4326")`.
2. Loads all images from `images/` and sets `sensor.type = Metashape.Sensor.Type.Frame` and `sensor.focal_length = 18.0` (or `Metashape.Sensor.Type.Spherical` in equirectangular mode).
3. Imports camera positions and orientations from `reference_metashape.csv` via `chunk.importReference(..., columns="nxyzabc", delimiter=",", skip_rows=1)`.
4. Imports the dual-depth cross-validation masks from `masks/{filename}_mask.png` via `chunk.generateMasks(..., masking_mode=Metashape.MaskingModeFile)`.
5. Runs `chunk.matchPhotos(filter_mask=True, generic_preselection=True, reference_preselection=True)` and `chunk.alignCameras()`.

## 5. FastAPI Endpoints & Frontend Architecture

### 5.1 REST API Endpoints (`backend/api/routes.py`)

| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Returns backend status, GPU/CPU device info, and loaded AI depth model status |
| `POST` | `/api/aoi/sample` | Accepts `AOIRequest` polygon, queries Overpass/Grid + Street View metadata, returns deduplicated list of `PanoMetadata` nodes |
| `POST` | `/api/pano/{pano_id}/process` | Downloads 360° tiles, decodes Dataset A planar depth, runs Dataset B AI depth, executes `DualDepthValidator`, and caches results |
| `GET` | `/api/pano/{pano_id}/layers/{layer_type}` | Streams PNG visualization of `rgb`, `sv_depth`, `ai_depth`, `fused_depth`, `discrepancy`, or `mask` |
| `GET` | `/api/pano/{pano_id}/cubemap/{face}` | Streams projected $90^\circ$ pinhole cubemap face (`front`, `right`, `back`, `left`, `up`, `down`) |
| `POST` | `/api/export/package` | Generates full Metashape & RealityCapture directory structure and returns a downloadable `.zip` stream |

### 5.2 Web UI Views (`frontend/src/components/`)

1. **Map & AOI Selector (`MapSelector.tsx`):**
   - Leaflet map with OpenStreetMap and Esri World Imagery satellite layers.
   - Interactive polygon drawing tool, sampling step selector ($5\text{ m} - 25\text{ m}$), and road-network vs. grid toggle.
   - Displays discovered `pano_id` nodes as directional markers with heading vectors and per-node RMSE badges.
2. **Dual-Depth Cross-Validation Lab (`DualDepthInspector.tsx`):**
   - Layer switcher between RGB, Street View Planar Depth, AI Monocular Depth, Fused Metric Depth, Discrepancy Map ($|D_{\text{sv}} - D_{\text{ai}}|$), and Binary Photogrammetry Mask (`_mask.png`).
   - Interactive sliders for Discrepancy Threshold ($\tau \in [0.25\text{ m}, 2.50\text{ m}]$), Fusion Weight ($\alpha \in [0, 1]$), and horizontal scanline row ($Y$).
   - Hover pixel inspector displaying real-time $(X, Y)$, $D_{\text{sv}}$, $D_{\text{ai}}$, $|\Delta d|$, and mask status (`255 Valid` vs. `0 Masked`).
   - Synchronized horizontal scanline profile chart comparing $D_{\text{sv}}$ and $D_{\text{ai}}$ across $-180^\circ$ to $+180^\circ$.
3. **Cubemap Pinhole Viewer (`CubemapPreview.tsx`):**
   - Displays all 6 rectilinear pinhole faces (`Front`, `Right`, `Back`, `Left`, `Up`, `Down`) for RGB, Fused Depth, and Mask layers.
4. **Photogrammetry Export Builder (`ExportBuilder.tsx`):**
   - Target selector (`Agisoft Metashape Pro`, `RealityCapture`, or `Both`), camera geometry selector (`4-Face Horizontal Cubemap`, `6-Face Full Cubemap`, `360° Equirectangular`), live file preview (`reference_metashape.csv`, `flightlog_realitycapture.csv`, `.xmp`, `metashape_auto_import.py`), and one-click `.zip` package download.

## 6. Phased Execution Plan & Verification Prompts for Claude Code

Follow these phases sequentially. Run `pytest` at the end of each backend phase before advancing.

### Phase 1: Project Scaffolding & Core Math Modules
- Create `pyproject.toml`, directory tree, and `backend/models/schemas.py`.
- Implement `backend/services/depth_decoder.py` (`StreetViewDepthDecoder`) and `backend/services/dual_depth_validator.py` (`DualDepthValidator`).
- Write `tests/test_depth_decoder.py` (construct a synthetic binary depth buffer, compress with `zlib` + `base64`, decode, and assert raycast plane distances match analytical values within $10^{-3}\text{ m}$) and `tests/test_dual_depth_validator.py` (verify RANSAC recovers known synthetic scale $s=12.5$ and shift $t=1.4\text{ m}$ and masks a synthetic moving vehicle anomaly where $\Delta > \tau$).
- Run: `pytest tests/test_depth_decoder.py tests/test_dual_depth_validator.py -v`

### Phase 2: Cubemap Projection & Photogrammetry Exporters
- Implement `backend/services/cubemap_projector.py` (`CubemapConverter`) and `backend/services/exporters.py` (`PhotogrammetryPackager`).
- Create `scripts/metashape_auto_import.py`.
- Write `tests/test_cubemap_projector.py` (verify output shape `(S, S, 3)` and verify center pixel of `front`, `right`, `back`, `left` maps to exact equirectangular longitudes $0^\circ, 90^\circ, 180^\circ, 270^\circ$) and `tests/test_exporters.py` (verify CSV headers, coordinate formatting, and valid XML structure in `.xmp` sidecars).
- Run: `pytest tests/ -v`

### Phase 3: Geospatial Sampling, Tile Stitching & FastAPI Endpoints
- Implement `backend/services/aoi_sampler.py`, `backend/services/streetview_client.py`, `backend/services/tile_stitcher.py`, and `backend/services/ai_depth_estimator.py` (include a deterministic fallback/mock mode when no GPU or Google API key is configured so local testing and UI previews always work out-of-the-box).
- Wire all endpoints in `backend/api/routes.py` and `backend/main.py`.

### Phase 4: React + TypeScript Frontend Studio
- Scaffold `frontend/` with Vite, React, TypeScript, Tailwind CSS, Leaflet, and Chart.js.
- Implement `MapSelector.tsx`, `DualDepthInspector.tsx`, `CubemapPreview.tsx`, and `ExportBuilder.tsx`.
- Verify end-to-end communication between the Vite frontend and FastAPI backend.
## 7. Implementation Notes & Deliberate Deviations (keep in sync with the code)

The repository root *is* `geopano3d/`. Everything in §2 exists, plus:
`backend/services/{geo.py, dem_service.py, synthetic_scene.py, pipeline.py}` and `tests/test_api_e2e.py`.

Running for end users: `start.bat` / `start.command` / `start.sh` → `launch.py` (stdlib only: venv, deps from pyproject, UI rebuild when `frontend/dist/.source-hash` is stale, port pick, browser). `frontend/dist/` is committed so Node.js isn't required; rebuild with `npm run build` after UI changes. Keys/options are edited in the UI (`GET/PUT /api/settings` → `.env`, hot-reloads the `Pipeline`). Docker: `Dockerfile` + `docker-compose.yml` (settings + exports in `./data`).

| Topic | Spec | Implemented | Why |
| :--- | :--- | :--- | :--- |
| Metric reference | SV planar depth only | SV planar depth **or** road-plane prior (camera height 2.5 m) | The public Map Tiles API exposes no depth; the prior still recovers metric scale via RANSAC on road pixels. Ground-prior mode masks sky only (it cannot tell cars from facade bases). |
| AI alignment space | depth | `depth` **and** `disparity` | DA-V2 relative models are affine in inverse depth; fitting in depth space is biased. |
| Per-face AI | described | implemented: per-face align → z→range → stitched back with `CubemapConverter.faces_to_equirect` | |
| Validated RMSE | – | `rmse_m` = kept (mask=255) surfaces; `rmse_all_m` = all joint pixels | Exported `Validated_RMSE_m` should describe what is reconstructed. |
| Fusion | blend wherever mask=255 | blend only where Δ ≤ τ, otherwise AI | Morphological closing re-admits a few Δ>τ pixels. |
| Raycast | `d / (r·n)` | `abs(d / (r·n))`, invalid if `abs(r·n) ≤ 1e-5` | Plane normal sign is inconsistent in real buffers (matches reference decoders). |
| Metashape pitch | `1.200` for horizontal | `pitch + 90` (0 = nadir) | Metashape YPR convention. |
| Metashape CRS | EPSG::4326 | EPSG::9707 (WGS84 + EGM96), fallback 4326 | DEM-derived heights are orthometric. |
| Metashape reference | `importReference` | parsed in-script by filename stem + Camera **Station** groups per pano | Robust to label/extension conventions; faces share an optical centre. |
| RC XMP | Yaw/Pitch/Roll attrs, `locked` | `xcr:Rotation` (world→cam, row-major) + `xcr:Position` in UTM; `initial` by default (configurable) | RC ignores YPR attributes; SV GNSS (1–5 m) is too poor to lock. YPR attrs kept as informative. |
| Depth PNGs | mm | mm **z-depth** (range × cos to optical axis) | What MVS tools expect from pinhole depth maps. |
| Geometry modes | 4/6/equirect | + `ring8` (8 × 90° views every 45°) | 50 % overlap inside each station → far more tie points. |
| DEM | – | OpenTopography (3DEP 1 m/10 m US, COP30) → AWS Terrarium z15; GeoTIFF + local-ENU OBJ + hillshade in bundle; fills pano altitudes | User request: highest-resolution DEM. |
| Sources | Google | Google Map Tiles, Mapillary (CC-BY-SA), local upload, synthetic | Licensing + offline demo/tests. |

Run: `pytest tests/ -v` (33 tests, no network / GPU needed).
