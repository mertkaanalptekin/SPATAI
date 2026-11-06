import { useEffect, useMemo, useRef, useState } from "react";
import {
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LinearScale,
  LogarithmicScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { api, type DepthArrays, type LayerType, type ProcessResponse } from "../api/client";

Chart.register(LineController, LineElement, PointElement, LinearScale, LogarithmicScale, CategoryScale, Legend, Tooltip, Filler);

const LAYERS: { key: LayerType; label: string }[] = [
  { key: "rgb", label: "RGB" },
  { key: "sv_depth", label: "SV planar depth (A)" },
  { key: "ai_depth", label: "AI depth, metric (B)" },
  { key: "fused_depth", label: "Fused depth" },
  { key: "discrepancy", label: "|Δd| discrepancy" },
  { key: "confidence", label: "Confidence" },
  { key: "mask", label: "_mask.png" },
];

interface Props {
  info: ProcessResponse;
  version: number;
  onRevalidate: (tau: number, alpha: number) => Promise<void>;
}

const fmt = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));

export default function DualDepthInspector({ info, version, onRevalidate }: Props) {
  const id = info.pano.pano_id;
  const [layer, setLayer] = useState<LayerType>("fused_depth");
  const [tau, setTau] = useState(0.85);
  const [alpha, setAlpha] = useState(0.75);
  const [row, setRow] = useState(0.62);
  const [arrays, setArrays] = useState<DepthArrays | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [pending, setPending] = useState(false);
  const chartEl = useRef<HTMLCanvasElement>(null);
  const chart = useRef<Chart | null>(null);
  const first = useRef(true);

  useEffect(() => {
    let alive = true;
    api.arrays(id, 512).then((a) => alive && setArrays(a)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id, version]);

  // debounced re-validation when τ / α change
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = window.setTimeout(async () => {
      setPending(true);
      try {
        await onRevalidate(tau, alpha);
      } finally {
        setPending(false);
      }
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tau, alpha]);

  const scan = useMemo(() => {
    if (!arrays) return null;
    const y = Math.min(arrays.height - 1, Math.floor(row * arrays.height));
    const off = y * arrays.width;
    const labels: string[] = [];
    const sv: (number | null)[] = [];
    const ai: (number | null)[] = [];
    const fused: (number | null)[] = [];
    for (let x = 0; x < arrays.width; x++) {
      labels.push((((x + 0.5) / arrays.width - 0.5) * 360).toFixed(1));
      const f = (v: number) => (Number.isFinite(v) && v < 249 ? v : null);
      sv.push(f(arrays.sv[off + x]));
      ai.push(f(arrays.ai[off + x]));
      fused.push(f(arrays.fused[off + x]));
    }
    return { labels, sv, ai, fused, lat: (0.5 - (y + 0.5) / arrays.height) * 180 };
  }, [arrays, row]);

  useEffect(() => {
    if (!chartEl.current || !scan) return;
    if (!chart.current) {
      chart.current = new Chart(chartEl.current, {
        type: "line",
        data: { labels: [], datasets: [] },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          elements: { point: { radius: 0 }, line: { borderWidth: 1.5 } },
          scales: {
            x: { ticks: { color: "#94a3b8", maxTicksLimit: 9 }, grid: { color: "#1e293b" }, title: { display: true, text: "longitude relative to heading (°)", color: "#64748b" } },
            y: { type: "logarithmic", ticks: { color: "#94a3b8" }, grid: { color: "#1e293b" }, title: { display: true, text: "range (m)", color: "#64748b" } },
          },
          plugins: { legend: { labels: { color: "#cbd5e1", boxWidth: 12 } } },
        },
      });
    }
    const c = chart.current;
    c.data.labels = scan.labels;
    c.data.datasets = [
      { label: "D_sv (Dataset A)", data: scan.sv, borderColor: "#38bdf8", spanGaps: false },
      { label: "D_ai metric (Dataset B)", data: scan.ai, borderColor: "#f472b6", spanGaps: false },
      { label: "D_fused", data: scan.fused, borderColor: "#a3e635", borderDash: [4, 3], spanGaps: false },
    ];
    c.update();
  }, [scan]);

  useEffect(() => () => chart.current?.destroy(), []);

  const px = useMemo(() => {
    if (!arrays || !hover) return null;
    const x = Math.min(arrays.width - 1, Math.floor(hover.x * arrays.width));
    const y = Math.min(arrays.height - 1, Math.floor(hover.y * arrays.height));
    const i = y * arrays.width + x;
    const sx = info.width / arrays.width;
    return {
      X: Math.floor(x * sx),
      Y: Math.floor(y * sx),
      sv: arrays.sv[i],
      ai: arrays.ai[i],
      fused: arrays.fused[i],
      d: arrays.discrepancy[i],
      mask: arrays.mask[i],
    };
  }, [arrays, hover, info.width]);

  const m = info.metrics;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1">
        {LAYERS.map((l) => (
          <button key={l.key} className={`chip ${layer === l.key ? "chip-on" : ""}`} onClick={() => setLayer(l.key)}>
            {l.label}
          </button>
        ))}
        {pending && <span className="ml-2 self-center text-xs text-amber-400">re-validating…</span>}
      </div>

      <div
        className="relative w-full select-none overflow-hidden rounded border border-slate-800 bg-[repeating-conic-gradient(#1e293b_0_25%,#0f172a_0_50%)] bg-[length:16px_16px]"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setRow((e.clientY - r.top) / r.height);
        }}
      >
        <img src={api.layerUrl(id, layer, version)} className="block w-full" style={{ imageRendering: layer === "rgb" ? "auto" : "pixelated" }} alt={layer} />
        <div className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-yellow-300/80" style={{ top: `${row * 100}%` }} />
        {hover && (
          <div className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white" style={{ left: `${hover.x * 100}%`, top: `${hover.y * 100}%` }} />
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="panel space-y-3 p-3 text-sm">
          <label className="block">
            <span className="label">Discrepancy threshold τ = {tau.toFixed(2)} m</span>
            <input className="w-full" type="range" min={0.25} max={2.5} step={0.05} value={tau} onChange={(e) => setTau(+e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Fusion weight α = {alpha.toFixed(2)} (AI share)</span>
            <input className="w-full" type="range" min={0} max={1} step={0.05} value={alpha} onChange={(e) => setAlpha(+e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Scanline row Y = {arrays ? Math.floor(row * info.height) : "—"} ({scan ? `${scan.lat.toFixed(1)}° elev.` : ""})</span>
            <input className="w-full" type="range" min={0} max={0.999} step={0.001} value={row} onChange={(e) => setRow(+e.target.value)} />
          </label>
        </div>

        <div className="panel p-3 font-mono text-xs leading-5">
          <div className="label mb-1 font-sans">Pixel inspector</div>
          {px ? (
            <>
              <div>(X, Y) = ({px.X}, {px.Y})</div>
              <div>D_sv = {fmt(px.sv)} m</div>
              <div>D_ai = {fmt(px.ai)} m</div>
              <div>D_fused = {fmt(px.fused)} m</div>
              <div>|Δd| = {fmt(px.d)} m</div>
              <div className={px.mask > 0 ? "text-lime-400" : "text-rose-400"}>mask = {px.mask > 0 ? "255 Valid" : "0 Masked"}</div>
            </>
          ) : (
            <div className="text-slate-500">hover the panorama · click to set scanline</div>
          )}
        </div>

        <div className="panel p-3 text-xs leading-5">
          <div className="label mb-1">Validation ({info.reference_mode === "planar" ? "SV planar depth" : "road-plane prior"})</div>
          <div className="grid grid-cols-2 gap-x-3 font-mono">
            <span>RMSE (kept)</span><span>{fmt(m.rmse_m, 3)} m</span>
            <span>RMSE (all)</span><span>{fmt(m.rmse_all_m, 3)} m</span>
            <span>MAE</span><span>{fmt(m.mae_m, 3)} m</span>
            <span>AbsRel</span><span>{fmt(m.abs_rel, 4)}</span>
            <span>inliers ≤ τ</span><span>{fmt(m.inlier_ratio_pct, 1)} %</span>
            <span>valid surface</span><span>{fmt(m.valid_surface_pct, 1)} %</span>
            <span>scale s</span><span>{m.scale_factor.toPrecision(5)}</span>
            <span>shift t</span><span>{m.shift_m.toPrecision(4)}</span>
          </div>
          <div className="mt-1 text-slate-500">space: {m.alignment_space} · AI: {info.ai_backend}</div>
        </div>
      </div>

      <div className="panel h-56 p-2">
        <canvas ref={chartEl} />
      </div>
    </div>
  );
}
