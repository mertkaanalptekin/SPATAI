"""GeoPano3D -> Agisoft Metashape Pro auto-import (Tools > Run Script, or `metashape.sh -r <this file>`).

Expects to sit in the root of an exported GeoPano3D bundle:

    images/  masks/  depth_validated/  dem/  reference_metashape.csv  pipeline_manifest.json

What it does
  1. creates a chunk in WGS84 (+EGM96 geoid heights when available: EPSG::9707, else EPSG::4326)
  2. adds all images; Frame sensor with f35 = 18 mm (exact, fixed) or a Spherical sensor
  3. groups the faces of every panorama into a *Camera Station* (shared optical centre)
  4. sets camera reference positions / orientations / accuracies from reference_metashape.csv
  5. imports dual-depth masks from masks/{filename}_mask.png
  6. optionally imports the DEM, then matches (mask-filtered) and aligns
Set RUN_DENSE = True to continue with depth maps + mesh.
"""

import csv
import json
import os

import Metashape  # noqa: F401  (provided by Metashape's embedded Python)

RUN_ALIGNMENT = True
RUN_DENSE = False
USE_STATIONS = True

ROOT = os.path.dirname(os.path.abspath(__file__))


def _enum(*names):
    """Resolve a Metashape enum across 1.x / 2.x API spellings."""
    for name in names:
        obj = Metashape
        try:
            for part in name.split("."):
                obj = getattr(obj, part)
            return obj
        except AttributeError:
            continue
    raise AttributeError(names)


def main():
    with open(os.path.join(ROOT, "pipeline_manifest.json"), "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
    geometry = manifest["export"]["geometry"]
    spherical = geometry == "equirectangular"

    doc = Metashape.app.document
    if doc is None:
        doc = Metashape.Document()
    chunk = doc.addChunk()
    chunk.label = manifest["export"]["project_name"]
    try:
        chunk.crs = Metashape.CoordinateSystem("EPSG::9707")  # WGS 84 + EGM96 height (DEM heights are orthometric)
    except Exception:  # geoid not installed
        print("[geopano3d] EPSG::9707 unavailable, falling back to EPSG::4326 (ellipsoidal heights!)")
        chunk.crs = Metashape.CoordinateSystem("EPSG::4326")

    image_dir = os.path.join(ROOT, "images")
    photos = sorted(
        os.path.join(image_dir, f) for f in os.listdir(image_dir) if f.lower().endswith((".jpg", ".jpeg", ".png", ".tif"))
    )
    chunk.addPhotos(photos)

    # --- sensor calibration ---------------------------------------------------------------
    sensor = chunk.sensors[0]
    for extra in list(chunk.sensors[1:]):
        for cam in chunk.cameras:
            if cam.sensor == extra:
                cam.sensor = sensor
        chunk.remove(extra)
    if spherical:
        sensor.type = Metashape.Sensor.Type.Spherical
    else:
        size = manifest["export"]["face_size"]
        sensor.type = Metashape.Sensor.Type.Frame
        sensor.width = size
        sensor.height = size
        sensor.pixel_width = 36.0 / size
        sensor.pixel_height = 36.0 / size
        sensor.focal_length = 18.0
        calib = Metashape.Calibration()
        calib.width, calib.height = size, size
        calib.f = manifest["export"]["focal_px"]
        sensor.user_calib = calib
        sensor.fixed = True  # synthetic pinhole: no distortion, exact focal

    # --- camera stations (all faces of one panorama share the optical centre) ----------------
    by_label = {cam.label: cam for cam in chunk.cameras}
    for cam in chunk.cameras:
        by_label.setdefault(os.path.splitext(cam.label)[0], cam)
    if USE_STATIONS and not spherical:
        groups = {}
        for item in manifest["images"]:
            cam = by_label.get(item["file"]) or by_label.get(os.path.splitext(item["file"])[0])
            if cam is None:
                continue
            grp = groups.get(item["pano_id"])
            if grp is None:
                grp = chunk.addCameraGroup()
                grp.label = item["pano_id"]
                grp.type = Metashape.CameraGroup.Type.Station
                groups[item["pano_id"]] = grp
            cam.group = grp

    # --- reference (parsed here so label/extension conventions never break the match) ------
    with open(os.path.join(ROOT, "reference_metashape.csv"), newline="", encoding="utf-8") as fh:
        rows = [r for r in csv.reader(fh) if r and not r[0].startswith("#")]
    for r in rows:
        label = r[0]
        cam = by_label.get(label) or by_label.get(os.path.splitext(label)[0])
        if cam is None:
            continue
        lon, lat, alt, yaw, pitch, roll, acc_xy, acc_z, acc_ypr = map(float, r[1:10])
        cam.reference.location = Metashape.Vector([lon, lat, alt])
        cam.reference.location_accuracy = Metashape.Vector([acc_xy, acc_xy, acc_z])
        cam.reference.rotation = Metashape.Vector([yaw, pitch, roll])
        cam.reference.rotation_accuracy = Metashape.Vector([acc_ypr] * 3)
        cam.reference.enabled = True
        try:
            cam.reference.rotation_enabled = True
            cam.reference.location_enabled = True
        except AttributeError:
            pass

    # --- masks -----------------------------------------------------------------------------
    mask_dir = os.path.join(ROOT, "masks")
    if os.path.isdir(mask_dir) and os.listdir(mask_dir):
        chunk.generateMasks(
            path=os.path.join(mask_dir, "{filename}_mask.png"),
            masking_mode=_enum("MaskingMode.MaskingModeFile", "MaskingModeFile"),
            mask_operation=_enum("MaskOperation.MaskOperationReplacement", "MaskOperationReplacement"),
            cameras=chunk.cameras,
        )

    # --- DEM (optional, informative / for orthomosaic) --------------------------------------
    dem_path = os.path.join(ROOT, "dem", "dem_epsg4326.tif")
    if os.path.exists(dem_path):
        try:
            chunk.importRaster(path=dem_path, crs=Metashape.CoordinateSystem("EPSG::4326"),
                               raster_type=_enum("DataSource.ElevationData", "ElevationData"))
        except Exception as exc:  # older versions
            print("[geopano3d] DEM import skipped:", exc)

    if RUN_ALIGNMENT:
        chunk.matchPhotos(
            downscale=1,
            generic_preselection=True,
            reference_preselection=True,
            filter_mask=True,
            keypoint_limit=40000,
            tiepoint_limit=8000,
        )
        chunk.alignCameras()
        chunk.optimizeCameras(fit_f=False, fit_cx=False, fit_cy=False, fit_k1=False, fit_k2=False, fit_k3=False,
                              fit_p1=False, fit_p2=False)
    if RUN_DENSE:
        chunk.buildDepthMaps(downscale=2, filter_mode=Metashape.MildFiltering)
        chunk.buildModel(source_data=Metashape.DepthMapsData)
        chunk.buildTexture()

    out = os.path.join(ROOT, manifest["export"]["project_name"] + ".psx")
    if not doc.path:
        doc.save(out)
    else:
        doc.save()
    print("[geopano3d] done ->", doc.path)


if __name__ == "__main__":
    main()
