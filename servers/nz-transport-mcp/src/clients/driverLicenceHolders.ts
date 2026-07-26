import { CACHE_TTL, cached, type CacheNamespace } from "@iolab/mcp-kit";
import { queryArcgisFeatures } from "./arcgisFeatureServer.js";

// The catalog's documented service name (Driver_licence_holders_dataset) is stale; the live service
// directory lists it as Driver_Licence_Holders instead. Confirmed live:
// curl 'https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services/Driver_Licence_Holders/FeatureServer/0/query?where=1%3D1&outFields=*&f=json&resultRecordCount=3'
const BASE_URL = "https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services/Driver_Licence_Holders/FeatureServer/0";
export const SOURCE = "NZTA Driver Licence Holders Dataset";

/** This layer's own maxRecordCount, confirmed via `.../FeatureServer/0?f=json`. */
const PAGE_SIZE = 2000;
/** Safety cap so a misbehaving upstream can't loop forever; ~10.6k rows today needs 6 pages. */
const MAX_PAGES = 50;

const CACHE_KEY = "nzta:driver-licence-holders:all-rows";

export type LicenceHolderRow = {
  OBJECTID: number;
  region: string;
  licenceClass: string;
  licenceStage: string;
  ageGroup: string;
  licenceCount: number;
  /** e.g. "24/25". */
  financialYear: string;
};

async function fetchAllRows(): Promise<LicenceHolderRow[]> {
  const rows: LicenceHolderRow[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await queryArcgisFeatures<LicenceHolderRow>(SOURCE, BASE_URL, {
      where: "1=1",
      orderByFields: "financialYear DESC, region",
      resultOffset: offset,
      resultRecordCount: PAGE_SIZE,
    });
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

/**
 * The full dataset is small (~10.6k rows, a few hundred KB of JSON) and refreshes at most a few
 * times a year, so we fetch it in full once per cache window and paginate/filter in memory rather
 * than building a `where` clause per request.
 */
export async function getAllLicenceHolderRows(cache: CacheNamespace): Promise<LicenceHolderRow[]> {
  return cached(cache, CACHE_KEY, CACHE_TTL.METADATA, fetchAllRows);
}
