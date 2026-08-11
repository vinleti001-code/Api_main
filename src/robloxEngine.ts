// Converts a parsed Roblox asset (via rbxm-parser) into a plain JSON tree
// that a Roblox game script can walk and rebuild with Instance.new().
//
// Every property is tagged with its Roblox data type ({ t, v }) so the
// client never has to guess a value's shape.
//
// Script-bearing classes (Script/LocalScript/ModuleScript/CoreScript) are
// included in the output with their Source property so models that depend on
// scripts can be reconstructed faithfully. scriptCount in the response now
// counts how many script instances were found (for informational purposes).
//
// Each instance node carries a numeric `id` so the Lua reconstruction script
// can wire up cross-instance reference properties (Beam.Attachment0/1,
// Weld.Part0/1, Motor6D.Part0/1, etc.) in a second pass after the full tree
// is built — solving the "gambar gerak" / Beam pattern where endpoints are
// siblings in the tree rather than children of the referencing instance.
//
// ── DataType coverage ──────────────────────────────────────────────────────
// All 33 DataTypes from rbxm-parser (https://dom.rojo.space/binary#data-types)
// are handled:
//   String, Bool, Int32, Float32, Float64, UDim, UDim2, Ray, Faces, Axes,
//   BrickColor, Color3, Vector2, Vector3, CFrame, Enum, Referent,
//   Vector3int16, NumberSequence, ColorSequence, NumberRange, Rect,
//   PhysicalProperties, Color3uint8, Int64, SharedString, Bytecode (skipped—
//   compiled script binary), OptionalCFrame, UniqueId, Font,
//   SecurityCapabilities.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { CoreInstance, DataType, RobloxFile } from "rbxm-parser";

const ASSET_DELIVERY_URL = "https://assetdelivery.roblox.com/v1/asset/";
const MAX_RAW_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_RAW_REDIRECTS = 3;
const RAW_FETCH_TIMEOUT_MS = 15_000;

export class EngineFetchError extends Error {}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && parts[2] === 0) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && b === 18) ||
    (a === 198 && b === 19) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

function isBlockedAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) === 6) return isPrivateIpv6(address);
  return true;
}

/**
 * GitHub's /blob/ URL is a web page, not the file bytes. Convert the common
 * GitHub file-page form into the corresponding raw.githubusercontent.com URL
 * before validation and fetching.
 */
function normalizeRawSourceUrl(rawUrl: string): string {
  let input: URL;
  try {
    input = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  const hostname = input.hostname.toLowerCase();
  const parts = input.pathname.split("/").filter(Boolean);
  if (
    (hostname === "github.com" || hostname === "www.github.com") &&
    parts.length >= 5 &&
    parts[2] === "blob"
  ) {
    const [owner, repository, , revision, ...filePath] = parts;
    const output = new URL(
      `https://raw.githubusercontent.com/${owner}/${repository}/${revision}/${filePath.join("/")}`,
    );
    output.search = input.search;
    return output.toString();
  }

  return rawUrl;
}

/**
 * Validate a remote source before fetching it. Raw URLs are user supplied, so
 * this blocks localhost, cloud metadata endpoints, private network targets,
 * non-HTTPS URLs, and non-standard ports to reduce SSRF risk.
 */
async function validateRawUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EngineFetchError("rawUrl must be a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new EngineFetchError("rawUrl must use HTTPS.");
  }
  if (url.username || url.password || (url.port && url.port !== "443")) {
    throw new EngineFetchError("rawUrl cannot contain credentials or a non-standard port.");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata.google.internal" ||
    (isIP(hostname) !== 0 && isBlockedAddress(hostname))
  ) {
    throw new EngineFetchError("rawUrl points to a blocked network address.");
  }

  if (isIP(hostname) === 0) {
    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new EngineFetchError("rawUrl host could not be resolved.");
    }
    if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
      throw new EngineFetchError("rawUrl host resolves to a blocked network address.");
    }
  }

  return url;
}

async function readResponseBody(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RAW_ASSET_BYTES) {
    throw new EngineFetchError(
      `Raw Roblox file is too large. Maximum size is ${MAX_RAW_ASSET_BYTES / (1024 * 1024)} MB.`,
    );
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RAW_ASSET_BYTES) {
      throw new EngineFetchError(
        `Raw Roblox file is too large. Maximum size is ${MAX_RAW_ASSET_BYTES / (1024 * 1024)} MB.`,
      );
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RAW_ASSET_BYTES) {
        await reader.cancel();
        throw new EngineFetchError(
          `Raw Roblox file is too large. Maximum size is ${MAX_RAW_ASSET_BYTES / (1024 * 1024)} MB.`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function assertBinaryRobloxFile(buffer: Buffer, sourceLabel: string): void {
  const magic = buffer.subarray(0, 8).toString("latin1");
  if (magic.startsWith("<roblox ")) {
    throw new EngineFetchError(
      `${sourceLabel} is XML (.rbxlx/.rbxmx). Only binary .rbxl or .rbxm files are supported.`,
    );
  }
  if (!magic.startsWith("<roblox!")) {
    throw new EngineFetchError(
      `${sourceLabel} did not return a Roblox binary .rbxl/.rbxm file.`,
    );
  }
}

function modelNameFromUrl(url: URL): string {
  const filename = decodeURIComponent(url.pathname.split("/").pop() || "")
    .replace(/\.(rbxm|rbxl)$/i, "")
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim();
  return (filename || "RemoteAsset").slice(0, 100);
}

/**
 * Downloads the raw asset bytes for a public/free Roblox model asset.
 * Throws EngineFetchError with a message safe to surface to the caller.
 */
export async function fetchAssetBuffer(assetId: string): Promise<Buffer> {
  const cookie = process.env.ROBLOX_COOKIE;
  let response: Response;
  try {
    response = await fetch(`${ASSET_DELIVERY_URL}?id=${assetId}`, {
      headers: {
        Accept: "application/octet-stream",
        ...(cookie ? { Cookie: `.ROBLOSECURITY=${cookie}` } : {}),
      },
      redirect: "follow",
    });
  } catch {
    throw new EngineFetchError("Could not reach Roblox asset delivery.");
  }

  if (response.status === 404) {
    throw new EngineFetchError("Asset not found.");
  }
  if (response.status === 401) {
    throw new EngineFetchError(
      cookie
        ? "Roblox rejected the configured authentication cookie (401) — it may be expired or invalid."
        : "Roblox requires authentication to access this asset — no ROBLOX_COOKIE is configured.",
    );
  }
  if (response.status === 403) {
    throw new EngineFetchError(
      "Asset is private, moderated, or not free — it cannot be fetched.",
    );
  }
  if (!response.ok) {
    throw new EngineFetchError(`Roblox returned HTTP ${response.status}.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  assertBinaryRobloxFile(buffer, "Asset ID response");

  return buffer;
}

/**
 * Downloads a public raw binary Roblox place/model from a user-provided URL.
 * Redirects are checked on every hop and the body is capped before parsing.
 */
export async function fetchRawAssetBuffer(rawUrl: string): Promise<{
  buffer: Buffer;
  modelName: string;
}> {
  let url = await validateRawUrl(normalizeRawSourceUrl(rawUrl));

  for (let redirectCount = 0; redirectCount <= MAX_RAW_REDIRECTS; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/octet-stream" },
        redirect: "manual",
        signal: AbortSignal.timeout(RAW_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof EngineFetchError) throw error;
      throw new EngineFetchError("Could not reach the raw Roblox file URL.");
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new EngineFetchError("Raw file server returned an invalid redirect.");
      }
      if (redirectCount === MAX_RAW_REDIRECTS) {
        throw new EngineFetchError("Too many redirects while fetching the raw Roblox file.");
      }
      url = await validateRawUrl(new URL(location, url).toString());
      continue;
    }

    if (response.status === 404) {
      throw new EngineFetchError("Raw Roblox file was not found.");
    }
    if (!response.ok) {
      throw new EngineFetchError(`Raw file server returned HTTP ${response.status}.`);
    }

    const buffer = await readResponseBody(response);
    assertBinaryRobloxFile(buffer, "rawUrl response");
    return { buffer, modelName: modelNameFromUrl(url) };
  }

  throw new EngineFetchError("Could not fetch the raw Roblox file.");
}

/**
 * Parses raw .rbxm bytes into a RobloxFile. Throws EngineFetchError if the
 * buffer is not a valid/parseable Roblox binary model.
 */
export function parseAssetBuffer(buffer: Buffer): RobloxFile {
  try {
    const file = RobloxFile.ReadFromBuffer(buffer);
    if (!file) {
      throw new Error("empty parser result");
    }
    return file;
  } catch {
    throw new EngineFetchError(
      "Roblox file could not be parsed — it may be corrupt or an unsupported format.",
    );
  }
}

/** Script classes that carry Source — counted in scriptCount for informational use. */
const SCRIPT_CLASSES = new Set([
  "Script",
  "LocalScript",
  "ModuleScript",
  "CoreScript",
]);

// ── Property value JSON types ──────────────────────────────────────────────

export type EnginePropertyValueType =
  // Primitives
  | "string"
  | "bool"
  | "number"
  | "SecurityCapabilities"
  // Vectors / spatial
  | "Vector2"
  | "Vector3"
  | "CFrame"
  | "Ray"
  // Colors
  | "Color3"
  | "BrickColor"
  // UI dimensions
  | "UDim"
  | "UDim2"
  | "Rect"
  // Sequences
  | "NumberSequence"
  | "ColorSequence"
  | "NumberRange"
  // Physics
  | "PhysicalProperties"
  // Bitmasks
  | "Faces"
  | "Axes"
  // Enum / reference
  | "enum"
  | "ref"
  // Misc
  | "Font"
  | "UniqueId"
  | "SharedString";

export interface EnginePropertyValueJson {
  /** Roblox data type tag. */
  t: EnginePropertyValueType;
  /** Serialised value — shape depends on `t` (see convertProperty). */
  v?: unknown;
  /** Only present when t === "enum": name of the Roblox Enum type (e.g. "Material"). */
  category?: string;
  /** Only present when t === "enum": name of the enum variant (e.g. "SmoothPlastic"). */
  name?: string;
  /** Only present when t === "ref": numeric node id of the referenced instance. */
  id?: number;
}

export interface EngineInstanceNodeJson {
  id: number;
  className: string;
  name: string;
  properties: Record<string, EnginePropertyValueJson>;
  children: EngineInstanceNodeJson[];
}

export interface ConvertedAsset {
  root: EngineInstanceNodeJson;
  instanceCount: number;
  scriptCount: number;
}

// ── SharedString lookup type (matches rbxm-parser SharedString class) ──────
interface SharedStringEntry {
  Value: string;
}

// ── ID assignment pass ─────────────────────────────────────────────────────

/**
 * Walk every instance in the file and assign a unique integer ID.
 * Must run before convertInstance so Referent properties can look up targets
 * that haven't been converted yet (e.g. Beam.Attachment1 points to an
 * Attachment that lives under a sibling Part, converted after the Beam).
 */
function assignIds(
  instance: CoreInstance,
  map: Map<CoreInstance, number>,
  counter: { n: number },
): void {
  map.set(instance, counter.n++);
  for (const child of instance.Children) {
    assignIds(child as CoreInstance, map, counter);
  }
}

// ── Property conversion ────────────────────────────────────────────────────

/**
 * Converts a single rbxm-parser property value into the tagged JSON format.
 *
 * Returns `undefined` for DataTypes that cannot be meaningfully round-tripped
 * (Bytecode — compiled Luau script binary).
 *
 * @param _propName  - Property name (unused here, kept for future filtering).
 * @param value      - Raw property from instance.Props.
 * @param idMap      - Instance → numeric id map for Referent resolution.
 * @param sharedStrs - SharedStrings array from the RobloxFile, for resolving
 *                     SharedString properties (e.g. MeshData, AnimationData).
 */
function convertProperty(
  _propName: string,
  value: { type: DataType; value: unknown },
  idMap: Map<CoreInstance, number>,
  sharedStrs: SharedStringEntry[],
): EnginePropertyValueJson | undefined {
  switch (value.type) {

    // ── Primitives ──────────────────────────────────────────────────────────

    case DataType.String:
      return { t: "string", v: value.value as string };

    case DataType.Bool:
      return { t: "bool", v: value.value as boolean };

    case DataType.Int32:
    case DataType.Float32:
    case DataType.Float64:
      return { t: "number", v: value.value as number };

    case DataType.Int64:
      // bigint → number is safe for asset IDs and capability flags that fit
      // in a double. Values too large are clamped to MAX_SAFE_INTEGER.
      return { t: "number", v: Number(value.value as bigint) };

    case DataType.SecurityCapabilities:
      // Security capabilities is a bigint bitmask; store as number.
      return { t: "SecurityCapabilities", v: Number(value.value as bigint) };

    // ── Spatial ─────────────────────────────────────────────────────────────

    case DataType.Vector2: {
      const v = value.value as { X: number; Y: number };
      return { t: "Vector2", v: [v.X, v.Y] };
    }

    case DataType.Vector3:
    case DataType.Vector3int16: {
      const v = value.value as { X: number; Y: number; Z: number };
      return { t: "Vector3", v: [v.X, v.Y, v.Z] };
    }

    case DataType.CFrame:
    case DataType.OptionalCFrame: {
      // OptionalCFrame shares the same wire format as CFrame; null OptionalCFrame
      // values are never stored in Props, so we always have a valid CFrame here.
      const cf = value.value as {
        Position: { X: number; Y: number; Z: number };
        Orientation: number[];
      };
      return {
        t: "CFrame",
        v: [
          cf.Position.X,
          cf.Position.Y,
          cf.Position.Z,
          ...cf.Orientation,
        ],
      };
    }

    case DataType.Ray: {
      // Serialised as { origin: [ox,oy,oz], direction: [dx,dy,dz] }
      // Lua rebuild: Ray.new(Vector3.new(origin), Vector3.new(direction))
      const r = value.value as {
        Origin: { X: number; Y: number; Z: number };
        Direction: { X: number; Y: number; Z: number };
      };
      return {
        t: "Ray",
        v: {
          origin: [r.Origin.X, r.Origin.Y, r.Origin.Z],
          direction: [r.Direction.X, r.Direction.Y, r.Direction.Z],
        },
      };
    }

    // ── Colors ───────────────────────────────────────────────────────────────

    case DataType.Color3:
    case DataType.Color3uint8: {
      const v = value.value as { R: number; G: number; B: number };
      return {
        t: "Color3",
        v: [
          Math.round(v.R * 255),
          Math.round(v.G * 255),
          Math.round(v.B * 255),
        ],
      };
    }

    case DataType.BrickColor: {
      // BrickColor is stored as its palette number (e.g. 194 = "Medium grey").
      // Lua rebuild: BrickColor.new(v)
      return { t: "BrickColor", v: value.value as number };
    }

    // ── UI dimensions ────────────────────────────────────────────────────────

    case DataType.UDim: {
      // Lua rebuild: UDim.new(scale, offset)
      const u = value.value as { Scale: number; Offset: number };
      return { t: "UDim", v: [u.Scale, u.Offset] };
    }

    case DataType.UDim2: {
      // Serialised as [xScale, xOffset, yScale, yOffset]
      // Lua rebuild: UDim2.new(v[1], v[2], v[3], v[4])
      const u2 = value.value as {
        X: { Scale: number; Offset: number };
        Y: { Scale: number; Offset: number };
      };
      return {
        t: "UDim2",
        v: [u2.X.Scale, u2.X.Offset, u2.Y.Scale, u2.Y.Offset],
      };
    }

    case DataType.Rect: {
      // Serialised as [minX, minY, maxX, maxY]
      // Lua rebuild: Rect.new(v[1], v[2], v[3], v[4])
      const rect = value.value as {
        Min: { X: number; Y: number };
        Max: { X: number; Y: number };
      };
      return {
        t: "Rect",
        v: [rect.Min.X, rect.Min.Y, rect.Max.X, rect.Max.Y],
      };
    }

    // ── Sequences ────────────────────────────────────────────────────────────

    case DataType.NumberSequence: {
      const ns = value.value as {
        Keypoints: Array<{ Time: number; Value: number; Envelope: number }>;
      };
      return {
        t: "NumberSequence",
        v: ns.Keypoints.map((k) => [k.Time, k.Value, k.Envelope]),
      };
    }

    case DataType.ColorSequence: {
      const cs = value.value as {
        Keypoints: Array<{
          Time: number;
          Color: { R: number; G: number; B: number };
        }>;
      };
      return {
        t: "ColorSequence",
        v: cs.Keypoints.map((k) => [
          k.Time,
          Math.round(k.Color.R * 255),
          Math.round(k.Color.G * 255),
          Math.round(k.Color.B * 255),
        ]),
      };
    }

    case DataType.NumberRange: {
      const nr = value.value as { Min: number; Max: number };
      return { t: "NumberRange", v: [nr.Min, nr.Max] };
    }

    // ── Physics ───────────────────────────────────────────────────────────────

    case DataType.PhysicalProperties: {
      // Lua rebuild: PhysicalProperties.new(density, friction, elasticity,
      //                                      frictionWeight, elasticityWeight)
      const pp = value.value as {
        Density: number;
        Friction: number;
        Elasticity: number;
        FrictionWeight: number;
        ElasticityWeight: number;
      };
      return {
        t: "PhysicalProperties",
        v: [pp.Density, pp.Friction, pp.Elasticity, pp.FrictionWeight, pp.ElasticityWeight],
      };
    }

    // ── Bitmasks ──────────────────────────────────────────────────────────────

    case DataType.Faces: {
      // rbxm-parser stores Faces as { Faces: RBXMFace[] } where each element is
      // one of: Front=1, Bottom=2, Left=4, Back=8, Top=16, Right=32.
      // We sum them to produce a single bitmask number.
      // Lua rebuild: use Enum.NormalId values to reconstruct face flags.
      const facesObj = value.value as { Faces: number[] };
      const bitmask = (facesObj.Faces ?? []).reduce(
        (acc: number, f: number) => acc | f,
        0,
      );
      return { t: "Faces", v: bitmask };
    }

    case DataType.Axes: {
      // rbxm-parser stores Axes as { Axes: RBXMAxis[] } where each element is
      // one of: X=1, Y=2, Z=4.
      // We sum them to produce a single bitmask number.
      const axesObj = value.value as { Axes: number[] };
      const bitmask = (axesObj.Axes ?? []).reduce(
        (acc: number, a: number) => acc | a,
        0,
      );
      return { t: "Axes", v: bitmask };
    }

    // ── Enum / Referent ───────────────────────────────────────────────────────

    case DataType.Enum: {
      const v = value.value as { EnumType?: { Name?: string }; Name: string };
      const category = v.EnumType?.Name;
      if (!category) return undefined;
      return { t: "enum", category, name: v.Name };
    }

    case DataType.Referent: {
      const target = value.value as CoreInstance | null;
      if (!target) return undefined;
      const id = idMap.get(target);
      if (id === undefined) return undefined;
      return { t: "ref", id };
    }

    // ── Misc ──────────────────────────────────────────────────────────────────

    case DataType.Font: {
      // RBXMFont: { Family: string, Weight: FontWeight (number), Style: FontStyle (number), CachedFaceId?: string }
      // Lua rebuild: Font.new(family, Enum.FontWeight[weightName], Enum.FontStyle[styleName])
      // Weight: Thin=100, ExtraLight=200, Light=300, Regular=400, Medium=500,
      //         SemiBold=600, Bold=700, ExtraBold=800, Heavy=900
      // Style:  Normal=0, Italic=1
      const font = value.value as {
        Family: string;
        Weight: number;
        Style: number;
        CachedFaceId?: string;
      };
      return {
        t: "Font",
        v: {
          family: font.Family,
          weight: font.Weight,
          style: font.Style,
          ...(font.CachedFaceId ? { cachedFaceId: font.CachedFaceId } : {}),
        },
      };
    }

    case DataType.UniqueId: {
      // UniqueId: { Index: number, Time: number, Random: bigint }
      // Not settable via Lua script; included for completeness / round-trip fidelity.
      // Serialised as the same string format rbxm-parser uses: "index:time:random".
      const uid = value.value as { Index: number; Time: number; Random: bigint };
      return {
        t: "UniqueId",
        v: `${uid.Index}:${uid.Time}:${uid.Random}`,
      };
    }

    case DataType.SharedString: {
      // SharedStringValue only carries an index into file.SharedStrings[].
      // We resolve it here to the actual string content (often binary mesh/anim data
      // stored as a raw string by rbxm-parser).
      // Lua reconstruction note: this content is typically only needed for streaming
      // or round-trip write-back; purely visual reconstruction uses other properties.
      const sv = value.value as { Index: number };
      const entry = sharedStrs[sv.Index];
      if (!entry) return undefined;
      return { t: "SharedString", v: entry.Value };
    }

    case DataType.Bytecode:
      // Compiled Luau bytecode — not useful for Lua-side Instance reconstruction
      // and was already excluded by the Script class filter above. Skipped.
      return undefined;

    default:
      return undefined;
  }
}

// ── Instance conversion ────────────────────────────────────────────────────

function convertInstance(
  instance: CoreInstance,
  idMap: Map<CoreInstance, number>,
  sharedStrs: SharedStringEntry[],
): {
  node: EngineInstanceNodeJson | null;
  instanceCount: number;
  scriptCount: number;
} {
  const properties: Record<string, EnginePropertyValueJson> = {};
  for (const [propName, rawValue] of instance.Props) {
    if (propName === "Parent" || propName === "RobloxLocked") continue;
    const converted = convertProperty(propName, rawValue, idMap, sharedStrs);
    if (converted) properties[propName] = converted;
  }
  if (!properties.Name) {
    properties.Name = { t: "string", v: instance.Name };
  }

  const children: EngineInstanceNodeJson[] = [];
  let instanceCount = 1;
  // scriptCount counts how many script instances exist in the tree (informational).
  let scriptCount = SCRIPT_CLASSES.has(instance.ClassName) ? 1 : 0;

  for (const child of instance.Children) {
    const result = convertInstance(child as CoreInstance, idMap, sharedStrs);
    instanceCount += result.instanceCount;
    scriptCount += result.scriptCount;
    if (result.node) children.push(result.node);
  }

  return {
    node: {
      id: idMap.get(instance)!,
      className: instance.ClassName,
      name: instance.Name,
      properties,
      children,
    },
    instanceCount,
    scriptCount,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export function convertAssetToJson(
  file: RobloxFile,
  fallbackName: string,
): ConvertedAsset {
  const topLevel = file.Roots as readonly CoreInstance[];
  // Resolve SharedStrings once for the whole file.
  const sharedStrs = file.SharedStrings as SharedStringEntry[];

  const idMap = new Map<CoreInstance, number>();
  const counter = { n: 0 };
  for (const inst of topLevel) {
    assignIds(inst, idMap, counter);
  }

  let instanceCount = 0;
  let scriptCount = 0;
  const children: EngineInstanceNodeJson[] = [];

  for (const instance of topLevel) {
    const result = convertInstance(instance, idMap, sharedStrs);
    instanceCount += result.instanceCount;
    scriptCount += result.scriptCount;
    if (result.node) children.push(result.node);
  }

  if (children.length === 1 && children[0].className === "Model") {
    return { root: children[0], instanceCount, scriptCount };
  }

  return {
    root: {
      id: -1,
      className: "Model",
      name: fallbackName,
      properties: { Name: { t: "string", v: fallbackName } },
      children,
    },
    instanceCount,
    scriptCount,
  };
}
