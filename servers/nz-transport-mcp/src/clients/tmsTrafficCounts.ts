import { arcgisContains, arcgisStringLiteral, countArcgisFeatures, queryArcgisFeatures } from "./arcgisFeatureServer.js";

// Confirmed live: curl 'https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services/TMS_Telemetry_Sites/FeatureServer/0/query?where=1%3D1&outFields=*&f=json&resultRecordCount=2'
// Table (no geometry), ~8.6M rows, maxRecordCount 2000. One row per site+date+lane+direction+vehicle-class combination.
const BASE_URL = "https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services/TMS_Telemetry_Sites/FeatureServer/0";
export const SOURCE = "NZTA TMS Daily Traffic Counts";

export type TmsTrafficCountRow = {
  OBJECTID: number;
  /** Epoch milliseconds (esriFieldTypeDate). */
  startDate: number;
  siteID: number;
  regionName: string;
  SiteRef: string;
  classWeight: "Light" | "Heavy" | string;
  siteDescription: string;
  laneNumber: number;
  /** Numeric lane-direction code; NZTA does not publish what each value means. */
  flowDirection: number;
  trafficCount: number;
};

export type TrafficCountsQuery = {
  siteRef?: string;
  region?: string;
  startDateIso?: string;
  endDateIso?: string;
  limit: number;
  offset: number;
};

function buildWhere(q: TrafficCountsQuery): string {
  const clauses: string[] = [];
  if (q.siteRef) clauses.push(`SiteRef = ${arcgisStringLiteral(q.siteRef)}`);
  if (q.region) clauses.push(arcgisContains("regionName", q.region));
  if (q.startDateIso) clauses.push(`startDate >= DATE ${arcgisStringLiteral(q.startDateIso)}`);
  if (q.endDateIso) clauses.push(`startDate <= DATE ${arcgisStringLiteral(q.endDateIso)}`);
  return clauses.length > 0 ? clauses.join(" AND ") : "1=1";
}

export async function queryTrafficCounts(
  q: TrafficCountsQuery,
): Promise<{ rows: TmsTrafficCountRow[]; totalCount: number }> {
  const where = buildWhere(q);
  const [totalCount, rows] = await Promise.all([
    countArcgisFeatures(SOURCE, BASE_URL, where),
    queryArcgisFeatures<TmsTrafficCountRow>(SOURCE, BASE_URL, {
      where,
      // Most-recent-first by default, per-site/lane order for readability within a day.
      orderByFields: "startDate DESC, SiteRef, laneNumber",
      resultOffset: q.offset,
      resultRecordCount: q.limit,
    }),
  ]);
  return { rows, totalCount };
}
