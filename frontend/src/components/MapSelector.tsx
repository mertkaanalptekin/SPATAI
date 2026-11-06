import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import type { DemResponse, LatLon, PanoMetadata, PanoSource, SamplingMode } from "../api/client";

type DrawMode = "none" | "polygon" | "rectangle";

interface Props {
  polygon: LatLon[];
  onPolygon: (p: LatLon[]) => void;
  nodes: PanoMetadata[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSample: (opts: { step: number; mode: SamplingMode; source: PanoSource }) => void;
  onDem: () => void;
  dem: DemResponse | null;
  busy: boolean;
  availableSources: Record<string, boolean>;
}

const rmseColor = (r?: number | null) =>
  r == null ? "#94a3b8" : r < 1 ? "#22c55e" : r < 3 ? "#f59e0b" : "#ef4444";

function markerIcon(n: PanoMetadata, selected: boolean): L.DivIcon {
  const c = rmseColor(n.rmse_m);
  const ring = selected ? `<circle cx="16" cy="16" r="9" fill="none" stroke="#38bdf8" stroke-width="3"/>` : "";
  const badge =
    n.rmse_m != null
      ? `<div style="position:absolute;left:24px;top:-2px;font:600 10px ui-sans-serif;color:#0f172a;background:${c};border-radius:4px;padding:0 3px">${n.rmse_m.toFixed(2)}m</div>`
      : "";
  return L.divIcon({
    className: "heading-marker",
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    html: `<div style="position:relative;width:32px;height:32px">
      <svg width="32" height="32" viewBox="0 0 32 32" style="transform:rotate(${n.heading}deg)">
        <path d="M16 2 L21 14 L16 11 L11 14 Z" fill="${c}" stroke="#0f172a" stroke-width="1"/>
        <circle cx="16" cy="16" r="5" fill="${c}" stroke="#0f172a" stroke-width="1.5"/>${ring}
      </svg>${badge}</div>`,
  });
}

export default function MapSelector(props: Props) {
  const { polygon, onPolygon, nodes, selectedId, onSelect, onSample, onDem, dem, busy, availableSources } = props;
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const aoiLayer = useRef<L.LayerGroup>(L.layerGroup());
  const nodeLayer = useRef<L.LayerGroup>(L.layerGroup());
  const demLayer = useRef<L.ImageOverlay | null>(null);
  const draft = useRef<LatLon[]>([]);
  const [mode, setMode] = useState<DrawMode>("none");
  const modeRef = useRef<DrawMode>("none");
  const [step, setStep] = useState(10);
  const [sampling, setSampling] = useState<SamplingMode>("road");
  const [source, setSource] = useState<PanoSource>("auto");
  const [draftLen, setDraftLen] = useState(0);
  modeRef.current = mode;

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { center: [41.0256, 28.9741], zoom: 17, doubleClickZoom: false });
    const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 20,
      maxNativeZoom: 19,
      attribution: "© OpenStreetMap contributors",
    });
    const sat = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 20, maxNativeZoom: 19, attribution: "Esri World Imagery" },
    );
    osm.addTo(m);
    L.control.layers({ OpenStreetMap: osm, "Esri World Imagery": sat }, {}, { position: "topright" }).addTo(m);
    aoiLayer.current.addTo(m);
    nodeLayer.current.addTo(m);

    const redrawDraft = () => {
      aoiLayer.current.clearLayers();
      if (draft.current.length) {
        L.polyline(draft.current, { color: "#38bdf8", dashArray: "4 4" }).addTo(aoiLayer.current);
        draft.current.forEach((p) => L.circleMarker(p, { radius: 3, color: "#38bdf8" }).addTo(aoiLayer.current));
      }
      setDraftLen(draft.current.length);
    };
    m.on("click", (e: L.LeafletMouseEvent) => {
      const p: LatLon = [e.latlng.lat, e.latlng.lng];
      if (modeRef.current === "polygon") {
        draft.current = [...draft.current, p];
        redrawDraft();
      } else if (modeRef.current === "rectangle") {
        if (draft.current.length === 0) {
          draft.current = [p];
          redrawDraft();
        } else {
          const [a] = draft.current;
          const rect: LatLon[] = [a, [a[0], p[1]], p, [p[0], a[1]]];
          draft.current = [];
          setMode("none");
          onPolygon(rect);
        }
      }
    });
    m.on("dblclick", () => {
      if (modeRef.current === "polygon" && draft.current.length >= 3) {
        const poly = draft.current;
        draft.current = [];
        setMode("none");
        onPolygon(poly);
      }
    });
    map.current = m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AOI polygon
  useEffect(() => {
    if (mode !== "none") return;
    aoiLayer.current.clearLayers();
    if (polygon.length >= 3) {
      L.polygon(polygon, { color: "#38bdf8", weight: 2, fillOpacity: 0.08 }).addTo(aoiLayer.current);
    }
  }, [polygon, mode]);

  // nodes
  useEffect(() => {
    nodeLayer.current.clearLayers();
    nodes.forEach((n) => {
      L.marker([n.lat, n.lon], { icon: markerIcon(n, n.pano_id === selectedId) })
        .bindTooltip(
          `<b>${n.pano_id}</b><br/>heading ${n.heading.toFixed(1)}°, alt ${n.alt.toFixed(1)} m<br/>` +
            (n.rmse_m != null ? `validated RMSE ${n.rmse_m.toFixed(3)} m` : "not processed yet"),
        )
        .on("click", () => onSelect(n.pano_id))
        .addTo(nodeLayer.current);
    });
  }, [nodes, selectedId, onSelect]);

  // DEM hillshade overlay
  useEffect(() => {
    demLayer.current?.remove();
    demLayer.current = null;
    if (dem && map.current) {
      const [s, w, n, e] = dem.bounds;
      demLayer.current = L.imageOverlay(`data:image/png;base64,${dem.hillshade_png_b64}`, [[s, w], [n, e]], {
        opacity: 0.55,
      }).addTo(map.current);
    }
  }, [dem]);

  const startDraw = (m: DrawMode) => {
    draft.current = [];
    setDraftLen(0);
    setMode(m);
  };
  const finishPolygon = () => {
    if (draft.current.length >= 3) {
      const poly = draft.current;
      draft.current = [];
      setMode("none");
      onPolygon(poly);
    }
  };
  const fitAoi = () => {
    if (polygon.length >= 3) map.current?.fitBounds(L.latLngBounds(polygon), { padding: [30, 30] });
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="panel flex flex-wrap items-center gap-2 p-2 text-sm">
        <span className="label">AOI</span>
        <button className={`chip ${mode === "polygon" ? "chip-on" : ""}`} onClick={() => startDraw("polygon")}>
          ✏️ Polygon
        </button>
        <button className={`chip ${mode === "rectangle" ? "chip-on" : ""}`} onClick={() => startDraw("rectangle")}>
          ▭ Rectangle
        </button>
        {mode === "polygon" && (
          <button className="chip" disabled={draftLen < 3} onClick={finishPolygon}>
            ✓ Finish ({draftLen})
          </button>
        )}
        {mode !== "none" && (
          <button className="chip" onClick={() => startDraw("none")}>
            Cancel
          </button>
        )}
        <button className="chip" onClick={fitAoi} disabled={polygon.length < 3}>
          Zoom to AOI
        </button>
        <span className="ml-auto text-xs text-slate-400">
          {mode === "polygon"
            ? "Click to add vertices, double-click to close"
            : mode === "rectangle"
              ? "Click two opposite corners"
              : `${nodes.length} panoramas`}
        </span>
      </div>

      <div ref={el} className="min-h-[300px] flex-1 overflow-hidden rounded-lg border border-slate-800" />

      <div className="panel grid grid-cols-2 gap-3 p-3 text-sm md:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="label">Step {step} m</span>
          <input type="range" min={5} max={25} value={step} onChange={(e) => setStep(+e.target.value)} />
        </label>
        <div className="flex flex-col gap-1">
          <span className="label">Sampling</span>
          <div className="flex gap-1">
            {(["road", "grid"] as SamplingMode[]).map((m) => (
              <button key={m} className={`chip ${sampling === m ? "chip-on" : ""}`} onClick={() => setSampling(m)}>
                {m === "road" ? "OSM roads" : "Grid"}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1">
          <span className="label">Imagery source</span>
          <select
            className="rounded bg-slate-800 px-2 py-1"
            value={source}
            onChange={(e) => setSource(e.target.value as PanoSource)}
          >
            <option value="auto">Auto (best configured)</option>
            <option value="google" disabled={!availableSources.google}>
              Google Street View {availableSources.google ? "" : "(no key)"}
            </option>
            <option value="mapillary" disabled={!availableSources.mapillary}>
              Mapillary (CC-BY-SA) {availableSources.mapillary ? "" : "(no token)"}
            </option>
            <option value="synthetic">Synthetic demo street</option>
          </select>
        </label>
        <div className="flex items-end gap-2">
          <button
            className="btn flex-1"
            disabled={polygon.length < 3 || busy}
            onClick={() => onSample({ step, mode: sampling, source })}
          >
            {busy ? "Sampling…" : "Find panoramas"}
          </button>
          <button className="btn-ghost" disabled={polygon.length < 3 || busy} onClick={onDem} title="Fetch DEM">
            DEM
          </button>
        </div>
      </div>
    </div>
  );
}
