import csv
import io
import json
import xml.etree.ElementTree as ET
import zipfile

import cv2
import numpy as np
import piexif
import pytest

from backend.models.schemas import CameraGeometryMode, ExportRequest, PanoMetadata, TargetSoftware
from backend.services.cubemap_projector import CUBE_FACES
from backend.services.dem_service import DemRaster
from backend.services.exporters import (
    METASHAPE_HEADER,
    ExportItem,
    PhotogrammetryPackager,
    face_pose,
    metashape_rows,
    metashape_ypr,
    preview_files,
    world_to_camera_enu,
    xmp_sidecar,
)
from backend.services.geo import UTMFrame

NS = {
    "x": "adobe:ns:meta/",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "xcr": "http://www.capturingreality.com/ns/xcr/1.1#",
}
PANO = PanoMetadata(pano_id="sv_galata_001", lat=41.025642, lon=28.974128, alt=38.4, heading=118.5)


def test_face_pose_yaw_wraps():
    p = face_pose(PANO, CUBE_FACES["left"], "x.jpg")
    assert p.yaw == pytest.approx((118.5 + 270) % 360)
    assert face_pose(PANO, CUBE_FACES["up"], "x.jpg").pitch == 90


def test_metashape_rows_format():
    pose = face_pose(PANO, CUBE_FACES["front"], "sv_galata_001_front.jpg")
    rows = metashape_rows([pose], 1.2, 1.8, 2.0, {"sv_galata_001_front.jpg": 0.312})
    assert rows[0] == [
        "sv_galata_001_front.jpg", "28.97412800", "41.02564200", "38.400",
        "118.500", "90.000", "0.000", "1.20", "1.80", "2.00", "0.312",
    ]
    assert metashape_ypr(face_pose(PANO, CUBE_FACES["down"], "d"))[1] == 0.0  # nadir


def test_rotation_matrix_is_orthonormal_and_points_forward():
    r = world_to_camera_enu(90.0, 0.0, 0.0)  # looking east
    np.testing.assert_allclose(r @ r.T, np.eye(3), atol=1e-12)
    assert np.linalg.det(r) == pytest.approx(1.0)
    np.testing.assert_allclose(r[2], [1, 0, 0], atol=1e-12)  # forward = east
    np.testing.assert_allclose(r[1], [0, 0, -1], atol=1e-12)  # image down = world down
    np.testing.assert_allclose(r[0], [0, -1, 0], atol=1e-12)  # image right = south


def test_xmp_is_valid_xml_with_locked_focal():
    pose = face_pose(PANO, CUBE_FACES["front"], "a.jpg")
    xml = xmp_sidecar(pose, UTMFrame.for_point(PANO.lat, PANO.lon), 18.0, "locked")
    root = ET.fromstring(xml)
    desc = root.find("rdf:RDF/rdf:Description", NS)
    q = lambda k: desc.get(f"{{{NS['xcr']}}}{k}")
    assert q("FocalLength35mm") == "18.0000"
    assert q("PosePrior") == "locked"
    assert q("Latitude") == "41.02564200" and q("Longitude") == "28.97412800"
    rot = [float(v) for v in desc.find("xcr:Rotation", NS).text.split()]
    assert len(rot) == 9
    pos = [float(v) for v in desc.find("xcr:Position", NS).text.split()]
    assert 600_000 < pos[0] < 700_000 and 4_500_000 < pos[1] < 4_600_000  # UTM 35N
    assert pos[2] == pytest.approx(38.4)


def _items():
    rng = np.random.default_rng(0)
    rgb = rng.integers(0, 255, (256, 512, 3), dtype=np.uint8)
    mask = np.full((128, 256), 255, np.uint8)
    mask[:20] = 0
    fused = np.full((128, 256), 12.0, np.float32)
    fused[:20] = np.nan
    return [ExportItem(PANO, rgb, fused, mask, 0.312)]


def _dem():
    return DemRaster(np.full((20, 20), 40.0, np.float32), 28.97, 41.03, 0.0005, 0.0004, "test")


@pytest.mark.parametrize("geom", [CameraGeometryMode.CUBEMAP_4, CameraGeometryMode.CUBEMAP_6, CameraGeometryMode.EQUIRECTANGULAR])
def test_package_layout(tmp_path, geom):
    req = ExportRequest(project_name="proj", pano_ids=["sv_galata_001"], geometry=geom, face_size=256)
    zip_path, manifest = PhotogrammetryPackager(tmp_path).build(req, _items(), _dem())
    zf = zipfile.ZipFile(zip_path)
    names = set(zf.namelist())
    n_views = {CameraGeometryMode.CUBEMAP_4: 4, CameraGeometryMode.CUBEMAP_6: 6, CameraGeometryMode.EQUIRECTANGULAR: 1}[geom]
    for base in ("reference_metashape.csv", "flightlog_realitycapture.csv", "metashape_auto_import.py",
                 "pipeline_manifest.json", "dem/dem_epsg4326.tif", "dem/terrain_local_enu.obj"):
        assert f"proj/{base}" in names
    assert sum(n.endswith(".jpg") for n in names) == n_views
    assert sum(n.endswith(".xmp") for n in names) == n_views
    assert sum(n.endswith("_mask.png") for n in names) == n_views
    assert sum(n.endswith("_depth_mm.png") for n in names) == n_views
    rows = list(csv.reader(io.StringIO(zf.read("proj/reference_metashape.csv").decode())))
    assert rows[0] == METASHAPE_HEADER and len(rows) == n_views + 1
    jpg = [n for n in names if n.endswith(".jpg")][0]
    img = cv2.imdecode(np.frombuffer(zf.read(jpg), np.uint8), cv2.IMREAD_COLOR)
    if geom != CameraGeometryMode.EQUIRECTANGULAR:
        assert img.shape == (256, 256, 3)
        ex = piexif.load(zf.read(jpg))
        assert ex["Exif"][piexif.ExifIFD.FocalLengthIn35mmFilm] == 18
        depth = cv2.imdecode(np.frombuffer(zf.read(jpg.replace("images/", "depth_validated/").replace(".jpg", "_depth_mm.png")), np.uint8), cv2.IMREAD_UNCHANGED)
        assert depth.dtype == np.uint16
        # front face centre: radial 12 m == z-depth 12 m on the optical axis
        if jpg.endswith("_front.jpg"):
            assert abs(int(depth[128, 128]) - 12000) <= 1
    m = json.loads(zf.read("proj/pipeline_manifest.json"))
    assert m["export"]["utm_epsg"] == 32635
    assert len(m["images"]) == n_views


def test_preview_files():
    req = ExportRequest(pano_ids=["a"], target=TargetSoftware.BOTH)
    files = preview_files(req, [PANO], {"sv_galata_001": 0.3})
    assert set(files) >= {"reference_metashape.csv", "flightlog_realitycapture.csv", "metashape_auto_import.py"}
    assert any(k.endswith(".xmp") for k in files)
