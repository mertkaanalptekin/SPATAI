"""Agisoft Metashape & RealityCapture project bundle writer.

Orientation conventions (documented in the bundle README as well):

* **Metashape** ``Yaw, Pitch, Roll``: yaw = compass heading of the optical axis, pitch = 0 means
  the camera looks straight *down* (nadir), 90 = horizontal, 180 = zenith. Hence
  ``ms_pitch = face_pitch + 90``.
* **RealityCapture** XMP: ``xcr:Rotation`` is the row-major world->camera matrix (camera x right,
  y down, z forward), ``xcr:Position`` the camera centre in the project CRS. We write projected
  UTM (EPSG reported in the manifest) so the metric frame is unambiguous.
"""

from __future__ import annotations

import csv
import io
import json
import math
import shutil
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional
from xml.sax.saxutils import quoteattr

import cv2
import numpy as np
import piexif
from numpy.typing import NDArray

from backend.models.schemas import CameraGeometryMode, ExportRequest, PanoMetadata, TargetSoftware
from backend.services.cubemap_projector import CubemapConverter, FaceSpec, faces_for_mode
from backend.services.dem_service import DemRaster, dem_to_obj, write_geotiff
from backend.services.geo import UTMFrame

METASHAPE_HEADER = [
    "#Label", "Longitude", "Latitude", "Altitude", "Yaw", "Pitch", "Roll",
    "Accuracy_XY", "Accuracy_Z", "Accuracy_YPR", "Validated_RMSE_m",
]
FLIGHTLOG_HEADER = ["#Name", "Latitude", "Longitude", "Altitude"]
SCRIPT_TEMPLATE = Path(__file__).resolve().parents[2] / "scripts" / "metashape_auto_import.py"

ProgressCb = Callable[[float, str], None]


@dataclass
class ExportItem:
    pano: PanoMetadata
    rgb: NDArray[np.uint8]  # full resolution equirectangular RGB
    fused_range: Optional[NDArray[np.float32]] = None  # metres (radial), work resolution
    mask: Optional[NDArray[np.uint8]] = None  # 255 valid / 0 masked, work resolution
    rmse_m: Optional[float] = None


@dataclass(frozen=True)
class CameraPose:
    label: str
    lat: float
    lon: float
    alt: float
    yaw: float  # absolute compass heading of the optical axis [0, 360)
    pitch: float  # + up, 0 = horizontal
    roll: float


def face_pose(pano: PanoMetadata, face: Optional[FaceSpec], label: str) -> CameraPose:
    rel_yaw = face.yaw_deg if face else 0.0
    rel_pitch = face.pitch_deg if face else 0.0
    return CameraPose(
        label=label,
        lat=pano.lat,
        lon=pano.lon,
        alt=pano.alt,
        yaw=(pano.heading + rel_yaw) % 360.0,
        # Street View / Mapillary panoramas are delivered levelled; the raw pano tilt is kept in the manifest
        pitch=rel_pitch,
        roll=pano.roll,
    )


def metashape_ypr(pose: CameraPose) -> tuple[float, float, float]:
    return pose.yaw, pose.pitch + 90.0, pose.roll


def world_to_camera_enu(yaw_deg: float, pitch_deg: float, roll_deg: float = 0.0) -> NDArray[np.float64]:
    """Row-major world(E,N,U) -> camera(x right, y down, z forward) rotation."""
    y, p, r = np.deg2rad([yaw_deg, pitch_deg, roll_deg])
    f = np.array([np.sin(y) * np.cos(p), np.cos(y) * np.cos(p), np.sin(p)])
    right = np.array([np.cos(y), -np.sin(y), 0.0])
    down = np.cross(f, right)
    # roll: positive = clockwise rotation of the camera about its optical axis (seen from behind)
    right_r = np.cos(r) * right + np.sin(r) * down
    down_r = -np.sin(r) * right + np.cos(r) * down
    return np.stack([right_r, down_r, f])


def metashape_rows(poses: list[CameraPose], acc_xy: float, acc_z: float, acc_ypr: float, rmse: dict[str, float]):
    rows = []
    for p in poses:
        y, pi, r = metashape_ypr(p)
        e = rmse.get(p.label)
        rows.append([
            p.label, f"{p.lon:.8f}", f"{p.lat:.8f}", f"{p.alt:.3f}", f"{y:.3f}", f"{pi:.3f}", f"{r:.3f}",
            f"{acc_xy:.2f}", f"{acc_z:.2f}", f"{acc_ypr:.2f}", "" if e is None or not math.isfinite(e) else f"{e:.3f}",
        ])
    return rows


def write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


def xmp_sidecar(
    pose: CameraPose,
    utm: UTMFrame,
    focal35: float = 18.0,
    pose_prior: str = "initial",
    spherical: bool = False,
) -> str:
    x, y = utm.to_xy(pose.lon, pose.lat)
    rot = world_to_camera_enu(pose.yaw, pose.pitch, pose.roll)
    rot_s = " ".join(f"{v:.9f}" for v in rot.ravel())
    attrs = {
        "xcr:Version": "3",
        "xcr:PosePrior": pose_prior,
        "xcr:Coordinates": "absolute",
        "xcr:DistortionModel": "spherical" if spherical else "perspective",
        "xcr:FocalLength35mm": f"{focal35:.4f}",
        "xcr:Skew": "0",
        "xcr:AspectRatio": "1",
        "xcr:PrincipalPointU": "0",
        "xcr:PrincipalPointV": "0",
        "xcr:CalibrationPrior": "exact",
        "xcr:CalibrationGroup": "-1" if spherical else "1",
        "xcr:DistortionGroup": "-1" if spherical else "1",
        "xcr:InTexturing": "1",
        "xcr:InMeshing": "1",
        # informative (ignored by RC, handy for humans / other tools)
        "xcr:Latitude": f"{pose.lat:.8f}",
        "xcr:Longitude": f"{pose.lon:.8f}",
        "xcr:Altitude": f"{pose.alt:.3f}",
        "xcr:Yaw": f"{pose.yaw:.3f}",
        "xcr:Pitch": f"{pose.pitch:.3f}",
        "xcr:Roll": f"{pose.roll:.3f}",
    }
    attr_s = "\n    ".join(f"{k}={quoteattr(v)}" for k, v in attrs.items())
    return (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
        ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        '  <rdf:Description rdf:about=""\n'
        '    xmlns:xcr="http://www.capturingreality.com/ns/xcr/1.1#"\n'
        f"    {attr_s}>\n"
        f"   <xcr:Rotation>{rot_s}</xcr:Rotation>\n"
        f"   <xcr:Position>{float(x):.4f} {float(y):.4f} {pose.alt:.4f}</xcr:Position>\n"
        "   <xcr:DistortionCoeficients>0 0 0 0 0 0</xcr:DistortionCoeficients>\n"
        "  </rdf:Description>\n"
        " </rdf:RDF>\n"
        "</x:xmpmeta>\n"
    )


def _rational(x: float, den: int = 1_000_000) -> tuple[int, int]:
    return int(round(x * den)), den


def _dms(deg: float) -> tuple:
    deg = abs(deg)
    d = int(deg)
    m = int((deg - d) * 60)
    s = (deg - d - m / 60) * 3600
    return ((d, 1), (m, 1), _rational(s, 10000))


def exif_bytes(pose: CameraPose, focal35: Optional[float], width: int, height: int) -> bytes:
    """EXIF with GPS + focal so both tools pick up priors even without the CSV/XMP."""
    zeroth = {piexif.ImageIFD.Make: b"GeoPano3D", piexif.ImageIFD.Model: b"virtual-pinhole"}
    exif: dict = {piexif.ExifIFD.PixelXDimension: width, piexif.ExifIFD.PixelYDimension: height}
    if focal35:
        exif[piexif.ExifIFD.FocalLengthIn35mmFilm] = int(round(focal35))
        exif[piexif.ExifIFD.FocalLength] = _rational(focal35, 1000)
        # 36 mm-wide virtual sensor -> focal-plane resolution makes f in mm exact
        exif[piexif.ExifIFD.FocalPlaneXResolution] = _rational(width / 36.0, 1000)
        exif[piexif.ExifIFD.FocalPlaneYResolution] = _rational(height / 36.0, 1000)
        exif[piexif.ExifIFD.FocalPlaneResolutionUnit] = 4  # mm
    gps = {
        piexif.GPSIFD.GPSVersionID: (2, 3, 0, 0),
        piexif.GPSIFD.GPSLatitudeRef: b"N" if pose.lat >= 0 else b"S",
        piexif.GPSIFD.GPSLatitude: _dms(pose.lat),
        piexif.GPSIFD.GPSLongitudeRef: b"E" if pose.lon >= 0 else b"W",
        piexif.GPSIFD.GPSLongitude: _dms(pose.lon),
        piexif.GPSIFD.GPSAltitudeRef: 0 if pose.alt >= 0 else 1,
        piexif.GPSIFD.GPSAltitude: _rational(abs(pose.alt), 1000),
        piexif.GPSIFD.GPSImgDirectionRef: b"T",
        piexif.GPSIFD.GPSImgDirection: _rational(pose.yaw, 1000),
    }
    return piexif.dump({"0th": zeroth, "Exif": exif, "GPS": gps})


def encode_jpeg(rgb: NDArray[np.uint8], quality: int, exif: Optional[bytes] = None) -> bytes:
    ok, buf = cv2.imencode(".jpg", rgb[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    data = buf.tobytes()
    if exif:
        out = io.BytesIO()
        piexif.insert(exif, data, out)
        data = out.getvalue()
    return data


def depth_to_mm_png(depth_m: NDArray[np.float32]) -> NDArray[np.uint16]:
    mm = np.where(np.isfinite(depth_m), np.round(depth_m * 1000.0), 0)
    return np.clip(mm, 0, 65535).astype(np.uint16)


def _bundle_readme(req: ExportRequest, utm: UTMFrame, dem: Optional[DemRaster]) -> str:
    return f"""GeoPano3D photogrammetry bundle: {req.project_name}
=================================================

Camera geometry : {req.geometry.value}
Pinhole faces   : {req.face_size}x{req.face_size} px, FOV 90 deg, f35 = 18.0 mm, no distortion
Pose prior      : {req.pose_prior.value} (XY +-{req.accuracy_xy_m} m, Z +-{req.accuracy_z_m} m, YPR +-{req.accuracy_ypr_deg} deg)
Heights         : {dem.vertical_datum if dem else "as delivered by the imagery source"} (metres)
DEM             : {dem.source + f", {dem.resolution_m:.2f} m" if dem else "not included"}

Agisoft Metashape Pro
  Tools > Run Script > metashape_auto_import.py   (creates stations, sets references, masks, aligns)
  Manual alternative: File > Import > Reference > reference_metashape.csv
    columns "nxyzabc" + accuracies, delimiter ",", CRS WGS 84 + EGM96 height (EPSG:9707)
    Metashape pitch convention: 0 = nadir, 90 = horizontal.
  Masks: Import Masks > From File > masks/{{filename}}_mask.png

RealityCapture
  1. Set Project / Output coordinate system to WGS 84 / UTM (EPSG:{utm.epsg}).
  2. Drag the images/ folder in: every image carries an .xmp sidecar with exact calibration
     (f35 = 18 mm, CalibrationPrior=exact) and a {req.pose_prior.value} pose (UTM metres).
  3. Optionally import flightlog_realitycapture.csv (Name, Lat, Lon, Alt) as Flight log (EPSG:4326).
  4. Masks: images/<name>.jpg <-> masks/<name>_mask.png (rename to <name>.mask.png if your RC
     version expects that suffix; `python -c` one-liner in pipeline_manifest.json -> notes).

depth_validated/*.png : 16-bit unsigned z-depth in millimetres (0 = unknown / masked),
  fused from Street View planar depth (or road-plane prior) and Depth-Anything-V2.
"""


class PhotogrammetryPackager:
    def __init__(self, work_dir: Path) -> None:
        self.work_dir = Path(work_dir)
        self.work_dir.mkdir(parents=True, exist_ok=True)

    def build(
        self,
        req: ExportRequest,
        items: Iterable[ExportItem],
        dem: Optional[DemRaster] = None,
        progress: Optional[ProgressCb] = None,
        center_latlon: Optional[tuple[float, float]] = None,
        n_items: Optional[int] = None,
    ) -> tuple[Path, dict]:
        """``items`` may be a lazy iterator (each panorama is processed, written and released)."""
        progress = progress or (lambda f, m: None)
        if center_latlon is None or n_items is None:
            items = list(items)
            n_items = len(items)
            center_latlon = (
                float(np.mean([it.pano.lat for it in items])),
                float(np.mean([it.pano.lon for it in items])),
            )
        stamp = time.strftime("%Y%m%d_%H%M%S")
        root = self.work_dir / f"{req.project_name}_{stamp}"
        if root.exists():
            shutil.rmtree(root)
        img_dir, mask_dir, depth_dir = root / "images", root / "masks", root / "depth_validated"
        for d in (img_dir, mask_dir, depth_dir):
            d.mkdir(parents=True)

        spherical = req.geometry == CameraGeometryMode.EQUIRECTANGULAR
        faces = faces_for_mode(req.geometry)
        conv = CubemapConverter(req.face_size, 90.0)
        focal35 = None if spherical else conv.focal_35mm
        want_xmp = req.target in (TargetSoftware.REALITY_CAPTURE, TargetSoftware.BOTH)
        lat_c, lon_c = center_latlon
        utm = UTMFrame.for_point(lat_c, lon_c)
        written: list[tuple[PanoMetadata, Optional[float]]] = []

        poses: list[CameraPose] = []
        rmse: dict[str, float] = {}
        images_manifest: list[dict] = []
        n_total = max(1, n_items)
        for i, it in enumerate(items):
            pid = _safe(it.pano.pano_id)
            views: list[tuple[Optional[FaceSpec], str]] = (
                [(None, f"{pid}.jpg")] if spherical else [(f, f"{pid}_{f.name}.jpg") for f in faces]
            )
            for face, fname in views:
                stem = fname[:-4]
                pose = face_pose(it.pano, face, fname)
                if face is None:
                    img = it.rgb
                else:
                    img = conv.project(it.rgb, face, "linear")
                h, w = img.shape[:2]
                (img_dir / fname).write_bytes(
                    encode_jpeg(img, req.jpeg_quality, exif_bytes(pose, focal35, w, h))
                )
                if want_xmp:
                    (img_dir / f"{stem}.xmp").write_text(
                        xmp_sidecar(pose, utm, focal35 or 18.0, req.pose_prior.value, spherical), encoding="utf-8"
                    )
                if req.include_masks and it.mask is not None:
                    m = (
                        cv2.resize(it.mask, (w, h), interpolation=cv2.INTER_NEAREST)
                        if face is None
                        else conv.project(it.mask, face, "nearest")
                    )
                    cv2.imwrite(str(mask_dir / f"{stem}_mask.png"), m)
                if req.include_depth and it.fused_range is not None:
                    if face is None:
                        z = cv2.resize(it.fused_range, (w, h), interpolation=cv2.INTER_NEAREST)
                    else:
                        z = conv.project_range_to_zdepth(it.fused_range, face)
                    cv2.imwrite(str(depth_dir / f"{stem}_depth_mm.png"), depth_to_mm_png(z))
                poses.append(pose)
                if it.rmse_m is not None:
                    rmse[fname] = it.rmse_m
                images_manifest.append(
                    {"file": fname, "pano_id": it.pano.pano_id, "face": face.name if face else "equirect",
                     "yaw": pose.yaw, "pitch": pose.pitch, "roll": pose.roll}
                )
            written.append((it.pano, it.rmse_m))
            progress(0.05 + 0.8 * (i + 1) / n_total, f"wrote {it.pano.pano_id}")

        if req.target in (TargetSoftware.METASHAPE, TargetSoftware.BOTH):
            write_csv(
                root / "reference_metashape.csv",
                METASHAPE_HEADER,
                metashape_rows(poses, req.accuracy_xy_m, req.accuracy_z_m, req.accuracy_ypr_deg, rmse),
            )
            shutil.copy(SCRIPT_TEMPLATE, root / "metashape_auto_import.py")
        if want_xmp:
            write_csv(
                root / "flightlog_realitycapture.csv",
                FLIGHTLOG_HEADER,
                [[p.label, f"{p.lat:.8f}", f"{p.lon:.8f}", f"{p.alt:.3f}"] for p in poses],
            )

        dem_info = None
        if dem is not None and req.include_dem:
            (root / "dem").mkdir()
            write_geotiff(root / "dem" / "dem_epsg4326.tif", dem)
            dem_to_obj(root / "dem" / "terrain_local_enu.obj", dem, lat_c, lon_c)
            cv2.imwrite(str(root / "dem" / "hillshade.png"), dem.hillshade())
            dem_info = {"source": dem.source, "resolution_m": dem.resolution_m, "bounds_swne": dem.bounds,
                        "vertical_datum": dem.vertical_datum, "obj_origin_latlon": [lat_c, lon_c]}
        progress(0.9, "writing manifest")

        manifest = {
            "generator": "GeoPano3D 1.0.0",
            "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "export": {
                **json.loads(req.model_dump_json()),
                "focal_px": conv.focal_px,
                "focal_35mm": focal35,
                "utm_epsg": utm.epsg,
                "metashape_pitch_convention": "0 = nadir, 90 = horizontal (ms_pitch = pitch + 90)",
            },
            "panoramas": [
                {**json.loads(p.model_dump_json(exclude={"raw_depth_b64"})), "validated_rmse_m": e}
                for p, e in written
            ],
            "images": images_manifest,
            "dem": dem_info,
            "notes": {
                "rc_mask_rename": "python -c \"import os;[os.rename('masks/'+f,'images/'+f.replace('_mask.png','.mask.png')) for f in os.listdir('masks')]\"",
            },
        }
        (root / "pipeline_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        (root / "README.txt").write_text(_bundle_readme(req, utm, dem if req.include_dem else None), encoding="utf-8")

        zip_path = self.work_dir / f"{root.name}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=4) as zf:
            for p in sorted(root.rglob("*")):
                if p.is_file():
                    zf.write(p, Path(req.project_name) / p.relative_to(root))
        shutil.rmtree(root, ignore_errors=True)
        progress(1.0, "done")
        return zip_path, manifest


def _safe(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name)[:80]


def preview_files(req: ExportRequest, panos: list[PanoMetadata], rmse: dict[str, float]) -> dict[str, str]:
    """Text previews of the generated metadata files for the UI (no imagery is rendered)."""
    spherical = req.geometry == CameraGeometryMode.EQUIRECTANGULAR
    faces = faces_for_mode(req.geometry)
    utm = UTMFrame.for_point(float(np.mean([p.lat for p in panos])), float(np.mean([p.lon for p in panos])))
    poses: list[CameraPose] = []
    per_file_rmse: dict[str, float] = {}
    for p in panos:
        pid = _safe(p.pano_id)
        views = [(None, f"{pid}.jpg")] if spherical else [(f, f"{pid}_{f.name}.jpg") for f in faces]
        for face, fname in views:
            poses.append(face_pose(p, face, fname))
            if p.pano_id in rmse:
                per_file_rmse[fname] = rmse[p.pano_id]
    out: dict[str, str] = {}
    if req.target in (TargetSoftware.METASHAPE, TargetSoftware.BOTH):
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(METASHAPE_HEADER)
        w.writerows(metashape_rows(poses, req.accuracy_xy_m, req.accuracy_z_m, req.accuracy_ypr_deg, per_file_rmse))
        out["reference_metashape.csv"] = buf.getvalue()
        out["metashape_auto_import.py"] = SCRIPT_TEMPLATE.read_text(encoding="utf-8")
    if req.target in (TargetSoftware.REALITY_CAPTURE, TargetSoftware.BOTH):
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(FLIGHTLOG_HEADER)
        w.writerows([[p.label, f"{p.lat:.8f}", f"{p.lon:.8f}", f"{p.alt:.3f}"] for p in poses])
        out["flightlog_realitycapture.csv"] = buf.getvalue()
        if poses:
            out[poses[0].label[:-4] + ".xmp"] = xmp_sidecar(poses[0], utm, 18.0, req.pose_prior.value, spherical)
    return out
