import { useEffect, useMemo, useState } from "react";
import { api, type CameraGeometryMode, type ExportRequest, type JobStatus, type PanoMetadata, type PosePrior, type TargetSoftware } from "../api/client";

interface Props {
  nodes: PanoMetadata[];
}

const TARGETS: { v: TargetSoftware; l: string }[] = [
  { v: "metashape", l: "Agisoft Metashape Pro" },
  { v: "realitycapture", l: "RealityCapture" },
  { v: "both", l: "Both" },
];
const GEOMS: { v: CameraGeometryMode; l: string; hint: string }[] = [
  { v: "cubemap4", l: "4-Face Horizontal Cubemap", hint: "front/right/back/left — recommended" },
  { v: "cubemap6", l: "6-Face Full Cubemap", hint: "+ zenith & nadir" },
  { v: "ring8", l: "8-View Ring (45° steps)", hint: "50 % overlap inside each station, best tie-points" },
  { v: "equirectangular", l: "360° Equirectangular", hint: "Metashape spherical sensor" },
];

export default function ExportBuilder({ nodes }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [req, setReq] = useState<Omit<ExportRequest, "pano_ids">>({
    project_name: "geopano3d_project",
    target: "both",
    geometry: "cubemap4",
    face_size: 1024,
    include_depth: true,
    include_masks: true,
    include_dem: true,
    pose_prior: "initial",
    accuracy_xy_m: 3,
    accuracy_z_m: 5,
    accuracy_ypr_deg: 2,
    jpeg_quality: 95,
  });
  const [files, setFiles] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<string>("");
  const [job, setJob] = useState<JobStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setSelected((prev) => (prev.size ? new Set([...prev].filter((id) => nodes.some((n) => n.pano_id === id))) : new Set(nodes.map((n) => n.pano_id))));
  }, [nodes]);

  const full: ExportRequest = useMemo(() => ({ ...req, pano_ids: [...selected] }), [req, selected]);

  useEffect(() => {
    if (!full.pano_ids.length) {
      setFiles({});
      return;
    }
    const t = window.setTimeout(() => {
      api.exportPreview(full).then((f) => {
        setFiles(f);
        setTab((cur) => (cur in f ? cur : Object.keys(f)[0] ?? ""));
      }).catch((e) => setErr(String(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [full]);

  useEffect(() => {
    if (!job || job.state === "done" || job.state === "error") return;
    return api.watchJob(job.job_id, setJob);
  }, [job?.job_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof typeof req>(k: K, v: (typeof req)[K]) => setReq((r) => ({ ...r, [k]: v }));
  const nViews = { cubemap4: 4, cubemap6: 6, ring8: 8, equirectangular: 1 }[req.geometry] * selected.size;
  const running = job && (job.state === "queued" || job.state === "running");

  const start = async () => {
    setErr(null);
    try {
      setJob(await api.exportPackage(full));
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(280px,1fr)_2fr]">
      <div className="panel space-y-3 p-3 text-sm">
        <label className="block">
          <span className="label">Project name</span>
          <input className="mt-1 w-full rounded bg-slate-800 px-2 py-1" value={req.project_name} onChange={(e) => set("project_name", e.target.value.replace(/[^A-Za-z0-9_-]/g, "_"))} />
        </label>
        <div>
          <span className="label">Target software</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {TARGETS.map((t) => (
              <button key={t.v} className={`chip ${req.target === t.v ? "chip-on" : ""}`} onClick={() => set("target", t.v)}>{t.l}</button>
            ))}
          </div>
        </div>
        <div>
          <span className="label">Camera geometry</span>
          <div className="mt-1 space-y-1">
            {GEOMS.map((g) => (
              <label key={g.v} className="flex cursor-pointer items-start gap-2">
                <input type="radio" className="mt-1" checked={req.geometry === g.v} onChange={() => set("geometry", g.v)} />
                <span>{g.l}<span className="block text-xs text-slate-500">{g.hint}</span></span>
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label>
            <span className="label">Face size</span>
            <select className="mt-1 w-full rounded bg-slate-800 px-2 py-1" value={req.face_size} onChange={(e) => set("face_size", +e.target.value)}>
              {[512, 1024, 1536, 2048, 3072].map((s) => <option key={s} value={s}>{s} px</option>)}
            </select>
          </label>
          <label>
            <span className="label">RC pose prior</span>
            <select className="mt-1 w-full rounded bg-slate-800 px-2 py-1" value={req.pose_prior} onChange={(e) => set("pose_prior", e.target.value as PosePrior)}>
              <option value="initial">initial (recommended)</option>
              <option value="locked">locked</option>
              <option value="exact">exact</option>
            </select>
          </label>
          <label>
            <span className="label">σ XY / Z (m)</span>
            <div className="mt-1 flex gap-1">
              <input type="number" step={0.5} className="w-full rounded bg-slate-800 px-2 py-1" value={req.accuracy_xy_m} onChange={(e) => set("accuracy_xy_m", +e.target.value)} />
              <input type="number" step={0.5} className="w-full rounded bg-slate-800 px-2 py-1" value={req.accuracy_z_m} onChange={(e) => set("accuracy_z_m", +e.target.value)} />
            </div>
          </label>
          <label>
            <span className="label">σ YPR (°)</span>
            <input type="number" step={0.5} className="mt-1 w-full rounded bg-slate-800 px-2 py-1" value={req.accuracy_ypr_deg} onChange={(e) => set("accuracy_ypr_deg", +e.target.value)} />
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
          {([["include_masks", "Masks"], ["include_depth", "16-bit depth"], ["include_dem", "DEM + terrain mesh"]] as const).map(([k, l]) => (
            <label key={k} className="flex items-center gap-1.5">
              <input type="checkbox" checked={req[k]} onChange={(e) => set(k, e.target.checked)} /> {l}
            </label>
          ))}
        </div>
        <div>
          <div className="flex items-center justify-between">
            <span className="label">Panoramas ({selected.size}/{nodes.length})</span>
            <span className="space-x-2 text-xs">
              <button className="text-sky-400" onClick={() => setSelected(new Set(nodes.map((n) => n.pano_id)))}>all</button>
              <button className="text-sky-400" onClick={() => setSelected(new Set())}>none</button>
            </span>
          </div>
          <div className="mt-1 max-h-40 overflow-auto rounded border border-slate-800 p-1 font-mono text-[11px]">
            {nodes.map((n) => (
              <label key={n.pano_id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={selected.has(n.pano_id)}
                  onChange={(e) => setSelected((s) => { const x = new Set(s); if (e.target.checked) x.add(n.pano_id); else x.delete(n.pano_id); return x; })}
                />
                <span className="truncate">{n.pano_id}</span>
                {n.rmse_m != null && <span className="ml-auto text-slate-500">{n.rmse_m.toFixed(2)} m</span>}
              </label>
            ))}
          </div>
        </div>
        <button className="btn w-full" disabled={!selected.size || !!running} onClick={start}>
          {running ? "Building…" : `Build .zip (${nViews} images)`}
        </button>
        {job && (
          <div className="space-y-1 text-xs">
            <div className="h-2 overflow-hidden rounded bg-slate-800">
              <div className={`h-full ${job.state === "error" ? "bg-rose-500" : "bg-sky-500"}`} style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
            <div className={job.state === "error" ? "text-rose-400" : "text-slate-400"}>{job.state} · {job.message}</div>
            {job.state === "done" && job.download_url && (
              <a className="btn inline-block" href={job.download_url}>⬇ Download package {job.manifest ? `(${String(job.manifest.zip_mb)} MB)` : ""}</a>
            )}
          </div>
        )}
        {err && <div className="text-xs text-rose-400">{err}</div>}
      </div>

      <div className="panel flex min-h-[420px] flex-col p-3">
        <div className="flex flex-wrap gap-1">
          {Object.keys(files).map((f) => (
            <button key={f} className={`chip font-mono ${tab === f ? "chip-on" : ""}`} onClick={() => setTab(f)}>{f}</button>
          ))}
        </div>
        <pre className="mt-2 flex-1 overflow-auto rounded bg-slate-950 p-3 font-mono text-[11px] leading-4 text-slate-300">
          {files[tab] ?? "Select panoramas to preview generated files."}
        </pre>
      </div>
    </div>
  );
}
