/**
 * Roblox Asset Search — Toolbox Service API
 *
 * Uses the official Roblox Toolbox Service (same API used by Roblox Studio).
 * Step 1: search for asset IDs via  /toolbox-service/v1/marketplace/{assetType}
 * Step 2: batch-fetch full details via /toolbox-service/v1/items/details
 *
 * No authentication required for public/free assets.
 */

const TOOLBOX_SEARCH_BASE = "https://apis.roblox.com/toolbox-service/v1/marketplace";
const TOOLBOX_DETAILS_URL = "https://apis.roblox.com/toolbox-service/v1/items/details";

export const VALID_SORTS = [
  "Relevance",
  "MostFavorited",
  "RecentlyCreated",
  "Updated",
  "AllTime",
] as const;
export type SortOption = (typeof VALID_SORTS)[number];

export const VALID_ASSET_TYPES = [
  "Model",
  "Decal",
  "Audio",
  "Plugin",
  "MeshPart",
] as const;
export type AssetTypeOption = (typeof VALID_ASSET_TYPES)[number];

function toValidLimit(n: number): 10 | 28 {
  return n <= 10 ? 10 : 28;
}

const HEADERS = {
  Accept: "application/json",
  "User-Agent": "RobloxStudio/WinInet",
};

export interface AssetSearchOptions {
  keyword: string;
  limit?: number;
  cursor?: string;
  sort?: SortOption;
  assetType?: AssetTypeOption;
}

export interface AssetSearchItem {
  id: string;
  name: string;
  description: string;
  creator: {
    name: string;
    type: "User" | "Group";
    id: number;
    isVerified: boolean;
  };
  upVotes: number;
  downVotes: number;
  hasScripts: boolean;
  thumbnail: null;
}

export interface AssetSearchResult {
  keyword: string;
  assetType: AssetTypeOption;
  assets: AssetSearchItem[];
  nextCursor: string | null;
  previousCursor: null;
  total: number;
}

export class AssetSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetSearchError";
  }
}

interface ToolboxSearchResponse {
  data: Array<{ id: number; searchResultSource?: string }>;
  nextPageCursor?: string;
  totalResults?: number;
}

interface ToolboxDetailItem {
  asset: {
    id: number;
    name: string;
    description?: string;
    hasScripts?: boolean;
  };
  creator: {
    id: number;
    name: string;
    type: number;
    isVerifiedCreator?: boolean;
  };
  voting?: {
    upVotes?: number;
    downVotes?: number;
  };
}

export async function searchAssets(
  options: AssetSearchOptions,
): Promise<AssetSearchResult> {
  const {
    keyword,
    limit = 10,
    cursor,
    sort = "Relevance",
    assetType = "Model",
  } = options;

  const pageSize = toValidLimit(limit);

  const searchParams = new URLSearchParams({
    keyword,
    limit: String(pageSize),
    sort,
  });
  if (cursor) searchParams.set("cursor", cursor);

  let searchRes: Response;
  try {
    searchRes = await fetch(
      `${TOOLBOX_SEARCH_BASE}/${assetType}?${searchParams}`,
      { headers: HEADERS },
    );
  } catch {
    throw new AssetSearchError(
      "Could not reach Roblox Toolbox API.",
    );
  }

  if (searchRes.status === 429) {
    throw new AssetSearchError(
      "Roblox rate-limit — please wait a moment and try again.",
    );
  }
  if (!searchRes.ok) {
    throw new AssetSearchError(
      `Roblox Toolbox search returned HTTP ${searchRes.status}.`,
    );
  }

  const searchData = (await searchRes.json()) as ToolboxSearchResponse;
  const searchItems = searchData.data ?? [];

  if (searchItems.length === 0) {
    return {
      keyword, assetType, assets: [],
      nextCursor: null, previousCursor: null, total: 0,
    };
  }

  const idList = searchItems.map((i) => i.id).join(",");

  let detailsRes: Response;
  try {
    detailsRes = await fetch(`${TOOLBOX_DETAILS_URL}?assetIds=${idList}`, {
      headers: HEADERS,
    });
  } catch {
    throw new AssetSearchError("Could not fetch asset details from Roblox.");
  }

  if (!detailsRes.ok) {
    throw new AssetSearchError(
      `Roblox details API returned HTTP ${detailsRes.status}.`,
    );
  }

  const detailsData = (await detailsRes.json()) as { data: ToolboxDetailItem[] };

  const detailMap = new Map<number, ToolboxDetailItem>();
  for (const item of detailsData.data ?? []) {
    detailMap.set(item.asset.id, item);
  }

  const assets: AssetSearchItem[] = searchItems.map((si) => {
    const d = detailMap.get(si.id);
    if (!d) {
      return {
        id: String(si.id),
        name: "Unknown",
        description: "",
        creator: { name: "Unknown", type: "User" as const, id: 0, isVerified: false },
        upVotes: 0, downVotes: 0, hasScripts: false, thumbnail: null,
      };
    }
    return {
      id: String(d.asset.id),
      name: d.asset.name,
      description: d.asset.description ?? "",
      creator: {
        name: d.creator.name,
        type: d.creator.type === 2 ? "Group" : "User",
        id: d.creator.id,
        isVerified: d.creator.isVerifiedCreator ?? false,
      },
      upVotes: d.voting?.upVotes ?? 0,
      downVotes: d.voting?.downVotes ?? 0,
      hasScripts: d.asset.hasScripts ?? false,
      thumbnail: null,
    };
  });

  return {
    keyword, assetType, assets,
    nextCursor: searchData.nextPageCursor ?? null,
    previousCursor: null,
    total: searchData.totalResults ?? assets.length,
  };
}
