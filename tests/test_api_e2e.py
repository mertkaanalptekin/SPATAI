"""End-to-end: synthetic AOI -> sample -> process (both AI modes) -> layers -> export zip."""

import io
import time
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.config import Settings
from backend.main import create_app

POLY = [(41.0250, 28.9738), (41.0262, 28.9738), (41.0262, 28.9744), (41.0250, 28.9744)]


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    s = Settings(_env_file=None, export_work_dir=tmp_path_factory.mktemp("exp"), ai_depth_backend="mock",
                 depth_work_width=512, pano_zoom=2)
    with TestClient(create_app(s)) as c:
        yield c


def test_full_flow(client):
    assert client.get("/api/health").json()["status"] == "ok"
    r = client.post("/api/aoi/sample", json={"polygon_latlon": POLY, "step_meters": 12, "sampling_mode": "grid", "source": "synthetic"})
    assert r.status_code == 200, r.text
    nodes = r.json()["nodes"]
    assert len(nodes) >= 5
    ids = [n["pano_id"] for n in nodes]
    assert len(set(ids)) == len(ids)

    pid = ids[len(ids) // 2]
    for mode in ("panorama", "cubemap"):
        r = client.post(f"/api/pano/{pid}/process", json={"ai_mode": mode})
        assert r.status_code == 200, r.text
        m = r.json()["metrics"]
        assert r.json()["reference_mode"] == "planar"
        # synthetic oracle: metric alignment must be near-perfect on static surfaces
        assert m["inlier_ratio_pct"] > 80, (mode, m)
        assert 5 < m["valid_surface_pct"] < 95

    for layer in ("rgb", "sv_depth", "ai_depth", "fused_depth", "discrepancy", "confidence", "mask"):
        r = client.get(f"/api/pano/{pid}/layers/{layer}")
        assert r.status_code == 200 and r.content[:4] == b"\x89PNG"
    r = client.get(f"/api/pano/{pid}/cubemap/up?layer=mask&size=128")
    assert r.status_code == 200
    r = client.get(f"/api/pano/{pid}/arrays?width=256")
    w, h = int(r.headers["x-width"]), int(r.headers["x-height"])
    arr = np.frombuffer(r.content, "<f4").reshape(5, h, w)
    assert set(np.unique(arr[4])) <= {0.0, 255.0}

    r = client.post(f"/api/pano/{pid}/revalidate", json={"tau_m": 0.3, "alpha": 0.5})
    assert r.status_code == 200

    req = {"project_name": "e2e", "pano_ids": ids[:2], "geometry": "cubemap6", "face_size": 256, "include_dem": False}
    assert "reference_metashape.csv" in client.post("/api/export/preview", json=req).json()
    job = client.post("/api/export/package", json=req).json()
    for _ in range(300):
        st = client.get(f"/api/jobs/{job['job_id']}").json()
        if st["state"] in ("done", "error"):
            break
        time.sleep(0.1)
    assert st["state"] == "done", st
    z = zipfile.ZipFile(io.BytesIO(client.get(st["download_url"]).content))
    assert sum(n.endswith(".jpg") for n in z.namelist()) == 12
    assert sum(n.endswith("_mask.png") for n in z.namelist()) == 12


def test_ground_prior_mode_recovers_metric_scale(client):
    """Without planar depth, the road-plane prior + camera height must still give metric depth."""
    app = client.app
    pipe = app.state.pipeline
    from backend.services.synthetic_scene import render_pano

    p = render_pano(0.0, 1024)
    pp = pipe._compute(pipe.get_node("synth_41.025600_28.974100_+0.0"), p.rgb, None, p.oracle_range, "panorama", 0.85, 0.75)
    assert pp.ref_mode.value == "ground_prior"
    gt = p.oracle_range[::2, ::2]
    ai = pp.result.d_ai_metric
    ok = np.isfinite(gt) & (gt < 60)
    rel = np.median(np.abs(ai[ok] - gt[ok]) / gt[ok])
    assert rel < 0.05, rel


def test_settings_roundtrip(client, tmp_path):
    pipe = client.app.state.pipeline
    env = tmp_path / ".env"
    env.write_text("# my comment\nPANO_ZOOM=3\nOTHER=keep\n")
    pipe.s = pipe.s.model_copy(update={"settings_file": env})
    before_nodes = dict(pipe.nodes)
    v = client.get("/api/settings").json()
    assert v["mapillary_access_token_set"] is False
    r = client.put("/api/settings", json={"mapillary_access_token": " tok123 ", "pano_zoom": 2, "ai_depth_mode": "panorama"})
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["mapillary_access_token_set"] is True and v["pano_zoom"] == 2
    assert "tok123" not in r.text  # secrets never echoed
    text = env.read_text()
    assert "# my comment" in text and "OTHER=keep" in text and "PANO_ZOOM=2" in text
    assert "MAPILLARY_ACCESS_TOKEN=tok123" in text
    new = client.app.state.pipeline
    assert new is not pipe and new.nodes == before_nodes
    assert client.get("/api/health").json()["sources"]["mapillary"] is True
    # clearing a secret
    assert client.put("/api/settings", json={"mapillary_access_token": ""}).json()["mapillary_access_token_set"] is False
    assert client.put("/api/settings", json={"pano_zoom": 9}).status_code == 422
