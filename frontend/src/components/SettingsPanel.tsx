import { useEffect, useState } from "react";
import { api, type SettingsUpdate, type SettingsView } from "../api/client";

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

type SecretKey = "google_maps_api_key" | "mapillary_access_token" | "opentopography_api_key";

const SECRETS: { key: SecretKey; label: string; help: string; link: string }[] = [
  {
    key: "mapillary_access_token",
    label: "Mapillary access token",
    help: "Free. Open CC-BY-SA street imagery; derived 3D models are allowed with attribution.",
    link: "https://www.mapillary.com/dashboard/developers",
  },
  {
    key: "opentopography_api_key",
    label: "OpenTopography API key",
    help: "Free. Unlocks USGS 3DEP 1 m lidar terrain (USA) and Copernicus 30 m worldwide.",
    link: "https://portal.opentopography.org/requestService?service=api",
  },
  {
    key: "google_maps_api_key",
    label: "Google Maps Platform key (Map Tiles API)",
    help: "Street View imagery. Google's terms restrict building 3D models from it; check your agreement.",
    link: "https://developers.google.com/maps/documentation/tile/get-api-key",
  },
];

export default function SettingsPanel({ onClose, onSaved }: Props) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [secrets, setSecrets] = useState<Partial<Record<SecretKey, string>>>({});
  const [opts, setOpts] = useState<SettingsUpdate>({});
  const [state, setState] = useState<"idle" | "saving" | "saved" | string>("idle");

  useEffect(() => {
    api.settings().then(setView).catch((e) => setState(String(e)));
  }, []);

  if (!view) {
    return (
      <Shell onClose={onClose}>
        <p className="text-sm text-slate-400">{state === "idle" ? "Loading…" : state}</p>
      </Shell>
    );
  }
  const val = <K extends keyof SettingsUpdate>(k: K) => (opts[k] ?? view[k as keyof SettingsView]) as SettingsUpdate[K];
  const setOpt = <K extends keyof SettingsUpdate>(k: K, v: SettingsUpdate[K]) => setOpts((o) => ({ ...o, [k]: v }));

  const save = async () => {
    setState("saving");
    try {
      const body: SettingsUpdate = { ...opts };
      for (const [k, v] of Object.entries(secrets)) if (v !== undefined) body[k as SecretKey] = v;
      setView(await api.saveSettings(body));
      setSecrets({});
      setOpts({});
      setState("saved");
      onSaved();
    } catch (e) {
      setState(String(e));
    }
  };

  return (
    <Shell onClose={onClose}>
      <section className="space-y-4">
        <h3 className="label">Imagery & terrain keys</h3>
        {SECRETS.map((s) => {
          const isSet = view[`${s.key}_set` as keyof SettingsView] as boolean;
          const edit = secrets[s.key];
          return (
            <div key={s.key}>
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{s.label}</span>
                <span className={`rounded px-1.5 text-[10px] ${isSet ? "bg-emerald-900 text-emerald-300" : "bg-slate-800 text-slate-400"}`}>
                  {isSet ? "configured" : "not set"}
                </span>
                <a className="ml-auto text-xs text-sky-400 hover:underline" href={s.link} target="_blank" rel="noreferrer">
                  get a key ↗
                </a>
              </div>
              <div className="mt-1 flex gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  className="flex-1 rounded bg-slate-800 px-2 py-1 font-mono text-sm"
                  placeholder={isSet ? "•••••••• (leave empty to keep)" : "paste key here"}
                  value={edit ?? ""}
                  onChange={(e) => setSecrets((x) => ({ ...x, [s.key]: e.target.value }))}
                />
                {isSet && (
                  <button className="btn-ghost text-xs" onClick={() => setSecrets((x) => ({ ...x, [s.key]: "" }))} title="remove on save">
                    Remove
                  </button>
                )}
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                {s.help}
                {edit === "" && isSet && <span className="text-amber-400"> Will be removed on save.</span>}
              </p>
            </div>
          );
        })}
      </section>

      <section className="mt-5 grid grid-cols-2 gap-3 text-sm">
        <h3 className="label col-span-2">Processing</h3>
        <label>
          <span className="text-xs text-slate-400">AI depth engine</span>
          <select className="mt-1 w-full rounded bg-slate-800 px-2 py-1" value={val("ai_depth_backend")} onChange={(e) => setOpt("ai_depth_backend", e.target.value as SettingsView["ai_depth_backend"])}>
            <option value="auto">Auto</option>
            <option value="transformers" disabled={!view.torch_available}>
              Depth-Anything-V2 {view.torch_available ? "" : "(not installed)"}
            </option>
            <option value="mock">Built-in fallback</option>
          </select>
        </label>
        <label>
          <span className="text-xs text-slate-400">AI inference</span>
          <select className="mt-1 w-full rounded bg-slate-800 px-2 py-1" value={val("ai_depth_mode")} onChange={(e) => setOpt("ai_depth_mode", e.target.value as SettingsView["ai_depth_mode"])}>
            <option value="cubemap">Per cube face (precise)</option>
            <option value="panorama">Whole panorama (fast)</option>
          </select>
        </label>
        <label>
          <span className="text-xs text-slate-400">Panorama resolution</span>
          <select className="mt-1 w-full rounded bg-slate-800 px-2 py-1" value={val("pano_zoom")} onChange={(e) => setOpt("pano_zoom", +e.target.value)}>
            {[2, 3, 4, 5].map((z) => (
              <option key={z} value={z}>
                zoom {z} (~{512 * 2 ** z}px wide)
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-xs text-slate-400">Terrain (DEM) source</span>
          <select className="mt-1 w-full rounded bg-slate-800 px-2 py-1" value={val("dem_source")} onChange={(e) => setOpt("dem_source", e.target.value as SettingsView["dem_source"])}>
            <option value="auto">Best available</option>
            <option value="opentopography">OpenTopography</option>
            <option value="terrarium">AWS Terrain Tiles (no key)</option>
          </select>
        </label>
        <label>
          <span className="text-xs text-slate-400">Camera height above road (m)</span>
          <input type="number" step={0.1} min={0.5} max={10} className="mt-1 w-full rounded bg-slate-800 px-2 py-1" value={val("camera_height_m")} onChange={(e) => setOpt("camera_height_m", +e.target.value)} />
        </label>
        <label>
          <span className="text-xs text-slate-400">Depth working width (px)</span>
          <select className="mt-1 w-full rounded bg-slate-800 px-2 py-1" value={val("depth_work_width")} onChange={(e) => setOpt("depth_work_width", +e.target.value)}>
            {[512, 1024, 2048].map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </label>
        {!view.torch_available && (
          <p className="col-span-2 rounded border border-slate-800 bg-slate-950 p-2 text-xs text-slate-400">
            To use the real Depth-Anything-V2 model, close GeoPano3D and start it once with{" "}
            <code className="text-sky-300">--with-ai</code> (e.g. <code className="text-sky-300">start.bat --with-ai</code>). This downloads PyTorch (~1–2 GB).
          </p>
        )}
      </section>

      <footer className="mt-5 flex items-center gap-3">
        <span className="truncate text-[11px] text-slate-500" title={view.settings_file}>
          saved to {view.settings_file}
        </span>
        <span className={`ml-auto whitespace-nowrap text-xs ${state === "saved" ? "text-emerald-400" : state === "saving" || state === "idle" ? "text-slate-400" : "text-rose-400"}`}>
          {state === "saved" ? "Saved ✓" : state === "saving" ? "Saving…" : state === "idle" ? "" : state}
        </span>
        <button className="btn-ghost" onClick={onClose}>Close</button>
        <button className="btn" onClick={save} disabled={state === "saving"}>Save</button>
      </footer>
    </Shell>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[2000] grid place-items-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button className="ml-auto text-slate-400 hover:text-white" onClick={onClose} aria-label="close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
