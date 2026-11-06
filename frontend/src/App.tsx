import { useCallback, useEffect, useState } from "react";
import { api, type DemResponse, type Health, type LatLon, type PanoMetadata, type PanoSource, type ProcessResponse, type SamplingMode } from "./api/client";
import MapSelector from "./components/MapSelector";
import DualDepthInspector from "./components/DualDepthInspector";
import CubemapPreview from "./components/CubemapPreview";
import ExportBuilder from "./components/ExportBuilder";

type Tab = "inspector" | "cubemap" | "export";

// Demo AOI around Galata, Istanbul
const DEFAULT_AOI: LatLon[] = [
  [41.0249, 28.9736],
  [41.0263, 28.9736],
  [41.0263, 28.9747],
  [41.0249, 28.9747],
];

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [polygon, setPolygon] = useState<LatLon[]>(DEFAULT_AOI);
  const [nodes, setNodes] = useState<PanoMetadata[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [info, setInfo] = useState<ProcessResponse | null>(null);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<Tab>("inspector");
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [dem, setDem] = useState<DemResponse | null>(null);
  const [aiMode, setAiMode] = useState<"panorama" | "cubemap">("cubemap");

  useEffect(() => {
    api.health().then((h) => { setHealth(h); setAiMode(h.ai_depth_mode as "panorama" | "cubemap"); }).catch((e) => setMessages([`Backend unreachable: ${e}`]));
  }, []);

  const updateNode = (p: PanoMetadata) => setNodes((ns) => ns.map((n) => (n.pano_id === p.pano_id ? p : n)));

  const sample = async (o: { step: number; mode: SamplingMode; source: PanoSource }) => {
    setBusy("Sampling AOI and resolving panoramas…");
    setMessages([]);
    try {
      const r = await api.sample({ polygon_latlon: polygon, step_meters: o.step, sampling_mode: o.mode, source: o.source });
      setNodes(r.nodes);
      setMessages([
        `${r.nodes.length} panoramas from ${r.candidate_points} ${r.sampling_mode_used === "road" ? "road" : "grid"} samples (source: ${r.source_used})`,
        ...r.warnings,
      ]);
      if (r.nodes.length) select(r.nodes[Math.floor(r.nodes.length / 2)].pano_id);
    } catch (e) {
      setMessages([String(e)]);
    } finally {
      setBusy(null);
    }
  };

  const select = useCallback(async (id: string, mode?: "panorama" | "cubemap") => {
    setSelected(id);
    setBusy(`Processing ${id}: tiles → Dataset A → Dataset B → validation…`);
    try {
      const r = await api.process(id, mode ? { ai_mode: mode } : {});
      setInfo(r);
      updateNode(r.pano);
      setVersion((v) => v + 1);
    } catch (e) {
      setMessages((m) => [...m, String(e)]);
    } finally {
      setBusy(null);
    }
  }, []);

  const revalidate = async (tau: number, alpha: number) => {
    if (!selected) return;
    const r = await api.revalidate(selected, tau, alpha);
    setInfo(r);
    updateNode(r.pano);
    setVersion((v) => v + 1);
  };

  const fetchDem = async () => {
    setBusy("Fetching best available DEM…");
    try {
      const d = await api.dem(polygon, 80);
      setDem(d);
      setMessages((m) => [...m, `DEM: ${d.source}, ${d.resolution_m.toFixed(2)} m/px, ${d.min_m.toFixed(1)}–${d.max_m.toFixed(1)} m (${d.vertical_datum})`]);
    } catch (e) {
      setMessages((m) => [...m, String(e)]);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-2">
        <h1 className="text-lg font-semibold tracking-tight">GeoPano3D <span className="font-normal text-slate-400">Studio</span></h1>
        <span className="text-xs text-slate-500">360° street imagery + DEM → Metashape / RealityCapture</span>
        {health && (
          <span className="ml-auto flex gap-2 text-[11px]">
            <span className="chip">AI: {health.ai_depth.backend} · {health.ai_depth.device}</span>
            <span className="chip">DEM: {health.dem.opentopography_key ? "OpenTopography" : "Terrarium"}</span>
          </span>
        )}
      </header>

      <main className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[minmax(360px,2fr)_3fr]">
        <section className="flex min-h-[560px] flex-col gap-2">
          <MapSelector
            polygon={polygon}
            onPolygon={setPolygon}
            nodes={nodes}
            selectedId={selected}
            onSelect={(id) => select(id)}
            onSample={sample}
            onDem={fetchDem}
            dem={dem}
            busy={!!busy}
            availableSources={health?.sources ?? {}}
          />
          {(busy || messages.length > 0) && (
            <div className="panel space-y-0.5 p-2 text-xs">
              {busy && <div className="animate-pulse text-sky-400">{busy}</div>}
              {messages.map((m, i) => <div key={i} className={/fail|error|unreach|\d{3}:/i.test(m) ? "text-amber-400" : "text-slate-400"}>{m}</div>)}
            </div>
          )}
        </section>

        <section className="flex min-h-0 flex-col gap-3 overflow-auto">
          <nav className="flex items-center gap-1">
            {([["inspector", "Dual-Depth Lab"], ["cubemap", "Cubemap Viewer"], ["export", "Export Builder"]] as [Tab, string][]).map(([k, l]) => (
              <button key={k} className={`chip text-sm ${tab === k ? "chip-on" : ""}`} onClick={() => setTab(k)}>{l}</button>
            ))}
            {selected && tab !== "export" && (
              <span className="ml-auto flex items-center gap-2 text-xs text-slate-400">
                AI inference:
                {(["cubemap", "panorama"] as const).map((m) => (
                  <button key={m} className={`chip ${aiMode === m ? "chip-on" : ""}`} onClick={() => { setAiMode(m); select(selected, m); }}>
                    {m === "cubemap" ? "per-face" : "panorama"}
                  </button>
                ))}
              </span>
            )}
          </nav>

          {tab === "export" ? (
            <ExportBuilder nodes={nodes} />
          ) : !info ? (
            <div className="panel grid flex-1 place-items-center p-10 text-center text-sm text-slate-400">
              <div>
                <p className="mb-2 text-base text-slate-200">Draw an AOI and click “Find panoramas”.</p>
                <p>Without API keys the synthetic demo street (with exact ground truth) is used,<br />so the whole pipeline can be explored offline.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-4 text-xs text-slate-400">
                <span className="font-mono text-sm text-slate-200">{info.pano.pano_id}</span>
                <span>{info.pano.lat.toFixed(6)}, {info.pano.lon.toFixed(6)}</span>
                <span>alt {info.pano.alt.toFixed(1)} m</span>
                <span>heading {info.pano.heading.toFixed(1)}°</span>
                <span>{info.rgb_width}×{info.rgb_height}px</span>
                <span>{Object.entries(info.timings_s).map(([k, v]) => `${k} ${v}s`).join(" · ")}</span>
                {info.pano.copyright && <span>© {info.pano.copyright}</span>}
              </div>
              {tab === "inspector" ? (
                <DualDepthInspector key={info.pano.pano_id} info={info} version={version} onRevalidate={revalidate} />
              ) : (
                <CubemapPreview panoId={info.pano.pano_id} version={version} />
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
