import { useState } from "react";
import { api, type FaceName, type LayerType } from "../api/client";

// Cross layout:      [up]
//              [left][front][right][back]
//                    [down]
const CROSS: (FaceName | null)[][] = [
  [null, "up", null, null],
  ["left", "front", "right", "back"],
  [null, "down", null, null],
];

const LAYERS: { key: LayerType; label: string }[] = [
  { key: "rgb", label: "RGB" },
  { key: "fused_depth", label: "Fused depth" },
  { key: "mask", label: "Mask" },
  { key: "discrepancy", label: "|Δd|" },
];

export default function CubemapPreview({ panoId, version }: { panoId: string; version: number }) {
  const [layer, setLayer] = useState<LayerType>("rgb");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        {LAYERS.map((l) => (
          <button key={l.key} className={`chip ${layer === l.key ? "chip-on" : ""}`} onClick={() => setLayer(l.key)}>
            {l.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-400">90° FOV pinhole · f35 = 18 mm · f = S/2 px · no distortion</span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {CROSS.flat().map((face, i) =>
          face ? (
            <figure key={i} className="relative">
              <img
                src={api.cubemapUrl(panoId, face, layer, version)}
                className="aspect-square w-full rounded border border-slate-800 bg-slate-900 object-cover"
                alt={face}
                loading="lazy"
              />
              <figcaption className="absolute left-1 top-1 rounded bg-slate-950/70 px-1.5 text-[11px] capitalize">{face}</figcaption>
            </figure>
          ) : (
            <div key={i} />
          ),
        )}
      </div>
    </div>
  );
}
