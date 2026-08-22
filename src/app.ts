import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import {
  EngineLoadBody,
  EngineLoadResponse,
  HealthCheckResponse,
  AssetSearchQuery,
  AssetSearchResponse,
} from "./schemas.js";
import {
  EngineFetchError,
  fetchAssetBuffer,
  fetchRawAssetBuffer,
  parseAssetBuffer,
  convertAssetToJson,
} from "./robloxEngine.js";
import { searchAssets, AssetSearchError } from "./assetSearch.js";

const app: Express = express();

// Roblox Studio's HttpService and Godot's HTTPClient do not send browser
// credentials or browser-style preflight requests. Keep the API public at the
// transport layer and let the route validation decide what is accepted.
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept", "Authorization", "X-Client"],
  optionsSuccessStatus: 204,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Godot-friendly response headers. These are also useful when the endpoint is
// tested from a browser-based Godot tool.
app.use((_req: Request, res: Response, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Toolbox-API-Version", "godot-1");
  next();
});

// ── Health check ──────────────────────────────────────────────────────────
app.get("/api/healthz", (_req: Request, res: Response) => {
  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

// ── Engine: load asset ────────────────────────────────────────────────────
/**
 * POST /api/engine/load
 * Body: { assetId: "12345678" } or { rawUrl: "https://.../model.rbxm" }
 */
async function loadAsset(req: Request, res: Response): Promise<void> {
  // GET is intentionally supported for Godot prototypes and simple
  // HTTPClient calls. POST remains the recommended method for Roblox and for
  // production Godot clients because rawUrl can be long.
  const input = req.method === "GET"
    ? {
        assetId: typeof req.query.assetId === "string" ? req.query.assetId : undefined,
        rawUrl: typeof req.query.rawUrl === "string" ? req.query.rawUrl : undefined,
        modelName: typeof req.query.modelName === "string" ? req.query.modelName : undefined,
      }
    : (req.body ?? {});
  const parsed = EngineLoadBody.safeParse(input);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: "Invalid request.",
      details: parsed.error.issues.map((issue) => issue.message),
    });
    return;
  }

  const { assetId, rawUrl, modelName } = parsed.data;

  try {
    const remote = rawUrl ? await fetchRawAssetBuffer(rawUrl) : null;
    const resolvedModelName = modelName ?? remote?.modelName ?? `Asset_${assetId}`;
    console.log(`[Engine] Loading ${rawUrl ? `raw URL ${rawUrl}` : `asset ${assetId}`}`);

    const buffer = remote ? remote.buffer : await fetchAssetBuffer(assetId!);
    const file   = parseAssetBuffer(buffer);
    const { root, instanceCount, scriptCount } = convertAssetToJson(file, resolvedModelName);

    console.log(`[Engine] ${resolvedModelName} → ${instanceCount} instances, ${scriptCount} scripts found`);

    res.json(EngineLoadResponse.parse({
      modelName: root.name || resolvedModelName,
      model: root,
      instanceCount,
      scriptCount,
    }));
  } catch (err) {
    if (err instanceof EngineFetchError) {
      console.warn(`[Engine] Load failed for ${assetId}: ${err.message}`);
      res.status(502).json({ ok: false, error: err.message });
      return;
    }
    console.error(`[Engine] Unexpected error for ${assetId}:`, err);
    res.status(502).json({ ok: false, error: "Unexpected error loading asset." });
  }
}

app.get("/api/engine/load", loadAsset);
app.post("/api/engine/load", loadAsset);

// Explicit alias for clients that prefer a self-documenting raw-file route.
// It returns exactly the same JSON shape as /api/engine/load.
app.post("/api/engine/load-url", async (req: Request, res: Response): Promise<void> => {
  const parsed = EngineLoadBody.safeParse({
    ...req.body,
    assetId: undefined,
  });
  if (!parsed.success || !parsed.data.rawUrl) {
    res.status(400).json({ error: parsed.success ? "rawUrl is required." : parsed.error.message });
    return;
  }
  req.body = parsed.data;
  await loadAsset(req, res);
});
app.get("/api/engine/load-url", loadAsset);

// ── Engine: search assets ─────────────────────────────────────────────────
/**
 * GET /api/engine/search
 *
 * Searches Roblox assets via the official Roblox Toolbox Service API
 * (the same API used by Roblox Studio's built-in Toolbox).
 *
 * Query params:
 *   q          — keyword (required)
 *   limit      — 1–28, default 10
 *   cursor     — pagination cursor from previous response
 *   sort       — Relevance | MostFavorited | RecentlyCreated | Updated | AllTime
 *   assetType  — Model | Decal | Audio | Plugin | MeshPart  (default: Model)
 *
 * Response:
 *   { keyword, assetType, total, nextCursor, previousCursor,
 *     assets: [{ id, name, description, creator, upVotes, downVotes, hasScripts, thumbnail }] }
 *
 *   thumbnail is always null — clients use rbxthumb://type=Asset&id=ID&w=150&h=150
 */
app.get("/api/engine/search", async (req: Request, res: Response): Promise<void> => {
  const parsed = AssetSearchQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { q, limit, cursor, sort, assetType } = parsed.data;

  try {
    console.log(`[Search] keyword="${q}" assetType=${assetType} sort=${sort}`);

    const result = await searchAssets({ keyword: q, limit, cursor, sort, assetType });

    console.log(`[Search] "${q}" → ${result.assets.length} / ${result.total} results`);

    res.json(AssetSearchResponse.parse(result));
  } catch (err) {
    if (err instanceof AssetSearchError) {
      console.warn(`[Search] Failed for "${q}": ${(err as Error).message}`);
      res.status(502).json({ error: (err as Error).message });
      return;
    }
    console.error(`[Search] Unexpected error for "${q}":`, err);
    res.status(502).json({ error: "Unexpected error searching assets." });
  }
});

export default app;
