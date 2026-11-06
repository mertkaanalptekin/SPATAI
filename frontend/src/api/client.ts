// Typed client for the GeoPano3D FastAPI backend (mirrors backend/models/schemas.py).

export type SamplingMode = "road" | "grid";
export type PanoSource = "auto" | "google" | "mapillary" | "synthetic" | "local";
export type TargetSoftware = "metashape" | "realitycapture" | "both";
export type CameraGeometryMode = "cubemap4" | "cubemap6" | "ring8" | "equirectangular";
export type PosePrior = "initial" | "locked" | "exact";
export type LayerType = "rgb" | "sv_depth" | "ai_depth" | "fused_depth" | "discrepancy" | "confidence" | "mask";
export type FaceName = "front" | "right" | "back" | "left" | "up" | "down";
export type LatLon = [number, number];

export interface AOIRequest {
  polygon_latlon: LatLon[];
  step_meters: number;
  sampling_mode: SamplingMode;
  source: PanoSource;
  max_nodes?: number;
  fill_altitude_from_dem?: boolean;
}

export interface PanoMetadata {
  pano_id: string;
  lat: number;
  lon: number;
  alt: number;
  heading: number;
  pitch: number;
  roll: number;
  capture_date?: string | null;
  source: PanoSource;
  alt_source?: string | null;
  copyright?: string | null;
  rmse_m?: number | null;
}

export interface SampleResponse {
  nodes: PanoMetadata[];
  candidate_points: number;
  sampling_mode_used: SamplingMode;
  source_used: PanoSource;
  warnings: string[];
}

export interface DepthValidationMetrics {
  scale_factor: number;
  shift_m: number;
  rmse_m: number | null;
  rmse_all_m: number | null;
  mae_m: number | null;
  abs_rel: number | null;
  inlier_ratio_pct: number;
  valid_surface_pct: number;
  alignment_space: string;
  joint_pixels: number;
}

export interface ProcessResponse {
  pano: PanoMetadata;
  metrics: DepthValidationMetrics;
  reference_mode: "planar" | "ground_prior";
  ai_backend: string;
  width: number;
  height: number;
  rgb_width: number;
  rgb_height: number;
  timings_s: Record<string, number>;
}

export interface ExportRequest {
  project_name: string;
  pano_ids: string[];
  target: TargetSoftware;
  geometry: CameraGeometryMode;
  face_size: number;
  include_depth: boolean;
  include_masks: boolean;
  include_dem: boolean;
  pose_prior: PosePrior;
  accuracy_xy_m: number;
  accuracy_z_m: number;
  accuracy_ypr_deg: number;
  jpeg_quality: number;
}

export interface JobStatus {
  job_id: string;
  state: "queued" | "running" | "done" | "error";
  progress: number;
  message: string;
  download_url?: string | null;
  manifest?: Record<string, unknown> | null;
}

export interface DemResponse {
  source: string;
  resolution_m: number;
  width: number;
  height: number;
  bounds: [number, number, number, number];
  min_m: number;
  max_m: number;
  vertical_datum: string;
  hillshade_png_b64: string;
}

export interface Health {
  status: string;
  ai_depth: { backend: string; model_id: string; device: string; loaded: boolean; load_error?: string | null };
  sources: Record<string, boolean>;
  dem: { source: string; opentopography_key: boolean };
  ai_depth_mode: string;
}

export interface DepthArrays {
  width: number;
  height: number;
  sv: Float32Array;
  ai: Float32Array;
  fused: Float32Array;
  discrepancy: Float32Array;
  mask: Float32Array;
}

export interface SettingsView {
  google_maps_api_key_set: boolean;
  mapillary_access_token_set: boolean;
  opentopography_api_key_set: boolean;
  ai_depth_backend: "auto" | "transformers" | "mock";
  ai_depth_mode: "panorama" | "cubemap";
  dem_source: "auto" | "terrarium" | "opentopography";
  pano_zoom: number;
  default_cubemap_face_size: number;
  depth_work_width: number;
  camera_height_m: number;
  default_discrepancy_threshold_m: number;
  default_fusion_alpha: number;
  torch_available: boolean;
  settings_file: string;
}

export type SettingsUpdate = Partial<
  Omit<SettingsView, "google_maps_api_key_set" | "mapillary_access_token_set" | "opentopography_api_key_set" | "torch_available" | "settings_file">
> & { google_maps_api_key?: string; mapillary_access_token?: string; opentopography_api_key?: string };

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const js = await res.json();
      detail = typeof js.detail === "string" ? js.detail : JSON.stringify(js.detail);
    } catch {
      /* not JSON */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  health: () => request<Health>("/api/health"),
  settings: () => request<SettingsView>("/api/settings"),
  saveSettings: (u: SettingsUpdate) => request<SettingsView>("/api/settings", { method: "PUT", body: JSON.stringify(u) }),
  sample: (req: AOIRequest) => post<SampleResponse>("/api/aoi/sample", req),
  process: (id: string, opts: Record<string, unknown> = {}) =>
    post<ProcessResponse>(`/api/pano/${encodeURIComponent(id)}/process`, opts),
  revalidate: (id: string, tau_m: number, alpha: number) =>
    post<ProcessResponse>(`/api/pano/${encodeURIComponent(id)}/revalidate`, { tau_m, alpha }),
  layerUrl: (id: string, layer: LayerType, v: number | string = 0, width?: number) =>
    `${BASE}/api/pano/${encodeURIComponent(id)}/layers/${layer}?v=${v}${width ? `&width=${width}` : ""}`,
  cubemapUrl: (id: string, face: FaceName, layer: LayerType, v: number | string = 0, size = 384) =>
    `${BASE}/api/pano/${encodeURIComponent(id)}/cubemap/${face}?layer=${layer}&size=${size}&v=${v}`,
  arrays: async (id: string, width = 512): Promise<DepthArrays> => {
    const res = await fetch(`${BASE}/api/pano/${encodeURIComponent(id)}/arrays?width=${width}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const w = Number(res.headers.get("X-Width"));
    const h = Number(res.headers.get("X-Height"));
    const buf = await res.arrayBuffer();
    const n = w * h;
    const plane = (i: number) => new Float32Array(buf, i * n * 4, n);
    return { width: w, height: h, sv: plane(0), ai: plane(1), fused: plane(2), discrepancy: plane(3), mask: plane(4) };
  },
  exportPreview: (req: ExportRequest) => post<Record<string, string>>("/api/export/preview", req),
  exportPackage: (req: ExportRequest) => post<JobStatus>("/api/export/package", req),
  job: (id: string) => request<JobStatus>(`/api/jobs/${id}`),
  dem: (polygon: LatLon[], buffer_m = 50) =>
    post<DemResponse>("/api/dem", { polygon_latlon: polygon, buffer_m, source: "auto" }),
  watchJob(id: string, onUpdate: (j: JobStatus) => void): () => void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const host = BASE ? BASE.replace(/^https?:\/\//, "") : location.host;
    let closed = false;
    let timer: number | undefined;
    const poll = async () => {
      if (closed) return;
      try {
        const j = await api.job(id);
        onUpdate(j);
        if (j.state === "done" || j.state === "error") return;
      } catch {
        /* retry */
      }
      timer = window.setTimeout(poll, 700);
    };
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`${proto}://${host}/api/ws/jobs/${id}`);
      ws.onmessage = (ev) => onUpdate(JSON.parse(ev.data) as JobStatus);
      ws.onerror = () => {
        ws = null;
        poll();
      };
    } catch {
      poll();
    }
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  },
};
