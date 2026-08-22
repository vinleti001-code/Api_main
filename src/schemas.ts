// Inlined Zod schemas for Roblox Toolbox Engine
// v4: Full DataType coverage — all 33 rbxm-parser DataTypes serialised
import * as zod from "zod";

export const HealthCheckResponse = zod.object({
  status: zod.string(),
});

// ── Engine: load ───────────────────────────────────────────────────────────

export const engineLoadBodyAssetIdRegExp = /^[0-9]+$/;

export const EngineLoadBody = zod.object({
  assetId: zod
    .string()
    .regex(engineLoadBodyAssetIdRegExp)
    .optional()
    .describe("Numeric Roblox asset/model ID, as a string"),
  rawUrl: zod
    .string()
    .url()
    .max(2048)
    .optional()
    .describe("HTTPS URL that points to a raw binary .rbxm or .rbxl file"),
  modelName: zod
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Optional name for a model loaded from rawUrl"),
  includeScripts: zod
    .boolean()
    .default(false)
    .describe("Reserved for future use. Scripts are always stripped."),
}).refine(
  (body) => Boolean(body.assetId) !== Boolean(body.rawUrl),
  "Provide exactly one of assetId or rawUrl.",
);

// ── Property value schema ──────────────────────────────────────────────────
//
// Shape of { t, v } for each DataType:
//
//  Primitives
//    string              → v: string
//    bool                → v: boolean
//    number              → v: number   (Int32 / Float32 / Float64 / Int64)
//    SecurityCapabilities→ v: number   (bigint bitmask stored as number)
//
//  Spatial
//    Vector2             → v: [x, y]
//    Vector3             → v: [x, y, z]
//    CFrame              → v: [px,py,pz, r00,r01,r02, r10,r11,r12, r20,r21,r22]
//    Ray                 → v: { origin:[ox,oy,oz], direction:[dx,dy,dz] }
//
//  Colors
//    Color3              → v: [r255, g255, b255]
//    BrickColor          → v: number  (BrickColor palette number)
//
//  UI dimensions
//    UDim                → v: [scale, offset]
//    UDim2               → v: [xScale, xOffset, yScale, yOffset]
//    Rect                → v: [minX, minY, maxX, maxY]
//
//  Sequences
//    NumberSequence      → v: Array<[time, value, envelope]>
//    ColorSequence       → v: Array<[time, r255, g255, b255]>
//    NumberRange         → v: [min, max]
//
//  Physics
//    PhysicalProperties  → v: [density, friction, elasticity, frictionWeight, elasticityWeight]
//
//  Bitmasks
//    Faces               → v: number  (bitmask: Front=1,Bottom=2,Left=4,Back=8,Top=16,Right=32)
//    Axes                → v: number  (bitmask: X=1,Y=2,Z=4)
//
//  Enum / reference
//    enum                → { category: string, name: string }
//    ref                 → { id: number }
//
//  Misc
//    Font                → v: { family:string, weight:number, style:number, cachedFaceId?:string }
//    UniqueId            → v: string  ("index:time:random")
//    SharedString        → v: string  (raw content resolved from file.SharedStrings)

const EnginePropertyValue = zod
  .object({
    t: zod.enum([
      // Primitives
      "string", "bool", "number", "SecurityCapabilities",
      // Spatial
      "Vector2", "Vector3", "CFrame", "Ray",
      // Colors
      "Color3", "BrickColor",
      // UI dimensions
      "UDim", "UDim2", "Rect",
      // Sequences
      "NumberSequence", "ColorSequence", "NumberRange",
      // Physics
      "PhysicalProperties",
      // Bitmasks
      "Faces", "Axes",
      // Enum / reference
      "enum", "ref",
      // Misc
      "Font", "UniqueId", "SharedString",
    ]),
    v: zod.unknown().optional(),
    // enum fields
    category: zod.string().optional(),
    name: zod.string().optional(),
    // ref field
    id: zod.number().int().optional(),
  });

export const EngineLoadResponse = zod.object({
  modelName: zod.string(),
  model: zod.object({
    id: zod.number().int(),
    className: zod.string(),
    name: zod.string(),
    properties: zod.record(zod.string(), EnginePropertyValue),
    children: zod.array(zod.unknown()),
  }),
  instanceCount: zod.number(),
  scriptCount: zod.number(),
});

export type EngineLoadBodyType = zod.infer<typeof EngineLoadBody>;

// ── Engine: search ─────────────────────────────────────────────────────────

export const AssetSearchQuery = zod.object({
  q: zod.string().min(1).max(120),
  limit: zod.coerce.number().int().min(1).max(28).default(10),
  cursor: zod.string().optional(),
  sort: zod
    .enum(["Relevance", "MostFavorited", "RecentlyCreated", "Updated", "AllTime"])
    .default("Relevance"),
  assetType: zod
    .enum(["Model", "Decal", "Audio", "Plugin", "MeshPart"])
    .default("Model"),
});

const AssetCreator = zod.object({
  name: zod.string(),
  type: zod.enum(["User", "Group"]),
  id: zod.number(),
  isVerified: zod.boolean(),
});

const AssetSearchItem = zod.object({
  id: zod.string(),
  name: zod.string(),
  description: zod.string(),
  creator: AssetCreator,
  upVotes: zod.number(),
  downVotes: zod.number(),
  hasScripts: zod.boolean(),
  thumbnail: zod.string().url().nullable(),
});

export const AssetSearchResponse = zod.object({
  keyword: zod.string(),
  assetType: zod.string(),
  assets: zod.array(AssetSearchItem),
  nextCursor: zod.string().nullable(),
  previousCursor: zod.null(),
  total: zod.number(),
});

export type AssetSearchQueryType = zod.infer<typeof AssetSearchQuery>;
export type AssetSearchItemType = zod.infer<typeof AssetSearchItem>;
export type AssetSearchResponseType = zod.infer<typeof AssetSearchResponse>;
