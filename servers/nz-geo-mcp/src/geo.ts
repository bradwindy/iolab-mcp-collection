/**
 * Shared geometry-summarization helpers.
 *
 * Per the collection's geospatial guidance: NEVER return raw geometry (polygon rings, line
 * paths, full coordinate arrays) to a tool caller by default. A single NZ parcel or land-unit
 * polygon can carry thousands of coordinate pairs and would obliterate a context window for
 * no research benefit. Instead every geometry-bearing tool in this server reduces geometry down
 * to a centroid (lat/lon) and a bounding box — enough to place, map, or zoom to a feature — and
 * never exposes raw rings/paths, even when the caller opts in to "include geometry".
 */

export type LatLon = { lat: number; lon: number };
export type BBox = { min_lon: number; min_lat: number; max_lon: number; max_lat: number };
export type GeometrySummary = { centroid: LatLon; bbox: BBox };

function summarizeCoordPairs(pairs: Array<[number, number]>): GeometrySummary | null {
  if (pairs.length === 0) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of pairs) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return {
    centroid: { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 },
    bbox: { min_lon: minLon, min_lat: minLat, max_lon: maxLon, max_lat: maxLat },
  };
}

/** Recursively flatten a GeoJSON-style nested coordinate array down to [lon, lat] pairs. */
function flattenGeoJsonCoordinates(coordinates: unknown, out: Array<[number, number]>): void {
  if (!Array.isArray(coordinates)) return;
  if (coordinates.length >= 2 && typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    out.push([coordinates[0] as number, coordinates[1] as number]);
    return;
  }
  for (const item of coordinates) flattenGeoJsonCoordinates(item, out);
}

/** Summarize a GeoJSON-shaped geometry ({type, coordinates}) as returned by LINZ's vector query API. */
export function summarizeGeoJsonGeometry(
  geometry: { type?: string; coordinates?: unknown } | null | undefined,
): GeometrySummary | null {
  if (!geometry?.coordinates) return null;
  const pairs: Array<[number, number]> = [];
  flattenGeoJsonCoordinates(geometry.coordinates, pairs);
  return summarizeCoordPairs(pairs);
}

/**
 * Summarize an Esri JSON geometry as returned by ArcGIS REST `/query` endpoints.
 * Points carry {x, y}; polylines carry {paths: [[[x,y],...],...]}; polygons carry
 * {rings: [[[x,y],...],...]}. Coordinates are [x, y] = [lon, lat] once outSR=4326 is requested.
 */
export function summarizeEsriGeometry(geometry: unknown): GeometrySummary | null {
  if (!geometry || typeof geometry !== "object") return null;
  const geom = geometry as { x?: number; y?: number; rings?: unknown; paths?: unknown };

  if (typeof geom.x === "number" && typeof geom.y === "number") {
    return { centroid: { lat: geom.y, lon: geom.x }, bbox: { min_lon: geom.x, min_lat: geom.y, max_lon: geom.x, max_lat: geom.y } };
  }

  const rings = Array.isArray(geom.rings) ? geom.rings : Array.isArray(geom.paths) ? geom.paths : null;
  if (!rings) return null;

  const pairs: Array<[number, number]> = [];
  for (const ring of rings) {
    if (!Array.isArray(ring)) continue;
    for (const point of ring) {
      if (Array.isArray(point) && point.length >= 2 && typeof point[0] === "number" && typeof point[1] === "number") {
        pairs.push([point[0], point[1]]);
      }
    }
  }
  return summarizeCoordPairs(pairs);
}
