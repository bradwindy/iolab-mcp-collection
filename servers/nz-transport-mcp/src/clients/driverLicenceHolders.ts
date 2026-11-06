import { CACHE_TTL, cached, fetchWithBackoff, type CacheNamespace } from "@iolab/mcp-kit";
import { ArcgisQueryError, queryArcgisFeatures } from "./arcgisFeatureServer.js";

// The catalog's documented service name (Driver_licence_holders_dataset) is stale; the live service
// directory lists it as Driver_Licence_Holders instead. Confirmed live:
// curl 'https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services/Driver_Licence_Holders/FeatureServer/0/query?where=1%3D1&outFields=*&f=json&resultRecordCount=3'
//
// The data then moved again (confirmed live 2026-11-06): the service now has no layer 0 (`layers: []`,
// so `/0/query` answers HTTP 200 `{"error":{"code":400,"message":"Invalid URL"}}`) and holds one
// date-stamped table instead, `{"id": 6, "name": "DriverLicenseHolders20260720"}`, with the same
// fields. Both the id and name look tied to each data refresh, so the id is read from the service
// descriptor rather than hard-coded.
const SERVICE_URL = "https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services/Driver_Licence_Holders/FeatureServer";
export const SOURCE = "NZTA Driver Licence Holders Dataset";

/** The table's own maxRecordCount, confirmed via `.../FeatureServer/<id>?f=json`. */
const PAGE_SIZE = 2000;
/** Safety cap so a misbehaving upstream can't loop forever; ~11.3k rows today needs 6 pages. */
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

type ServiceEntry = { id: number; name?: string };
type ServiceDescriptor = { layers?: ServiceEntry[]; tables?: ServiceEntry[]; error?: { message: string } };

/** The FeatureServer sub-path (layer or table id) that holds the licence-holder rows today. */
async function resolveDataUrl(): Promise<string> {
  const url = new URL(SERVICE_URL);
  url.searchParams.set("f", "json");
  const response = await fetchWithBackoff(url);
  if (!response.ok) throw new ArcgisQueryError(SOURCE, `HTTP ${response.status} ${response.statusText}`);
  const descriptor = (await response.json()) as ServiceDescriptor;
  if (descriptor.error) throw new ArcgisQueryError(SOURCE, descriptor.error.message);

  const entries = [...(descriptor.tables ?? []), ...(descriptor.layers ?? [])];
  const entry = entries.find((candidate) => /licen[cs]e/i.test(candidate.name ?? "")) ?? entries[0];
  if (!entry) throw new ArcgisQueryError(SOURCE, "the service lists no layers or tables");
  return `${SERVICE_URL}/${entry.id}`;
}

async function fetchAllRows(): Promise<LicenceHolderRow[]> {
  const BASE_URL = await resolveDataUrl();
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
