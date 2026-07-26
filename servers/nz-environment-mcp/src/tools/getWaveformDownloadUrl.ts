import { z } from "zod";
import { attribution, jsonResult, type ToolTextResult } from "@iolab/mcp-kit";
import { buildWaveformUrl } from "../clients/geonetFdsn.js";

export const getWaveformDownloadUrlInputShape = {
  network: z.string().min(1).max(10).describe("FDSN network code, e.g. 'NZ'. Find one with nz_env_search_seismic_stations."),
  station: z.string().min(1).max(20).describe("Station code, e.g. 'WEL'."),
  location: z.string().max(10).optional().describe("FDSN location code, e.g. '10'. Omit to match any location."),
  channel: z.string().min(1).max(20).describe("Channel code or wildcard pattern, e.g. 'HHZ' or 'HH?'."),
  start_time: z.string().min(4).describe("ISO 8601 start of the waveform window."),
  end_time: z.string().min(4).describe("ISO 8601 end of the waveform window."),
};

export const getWaveformDownloadUrlOutputShape = {
  download_url: z.string(),
  format: z.string(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getWaveformDownloadUrlInputShape);

/**
 * Escape hatch for raw waveform access. Deliberately does not fetch or inline the
 * waveform: miniSEED bodies are binary and can be very large, so this tool only
 * constructs the FDSN dataselect URL for the caller (or another tool, e.g. ObsPy) to
 * fetch directly.
 */
export async function getWaveformDownloadUrlHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const downloadUrl = buildWaveformUrl({
    network: input.network,
    station: input.station,
    ...(input.location ? { location: input.location } : {}),
    channel: input.channel,
    startTime: input.start_time,
    endTime: input.end_time,
  });

  return jsonResult({
    download_url: downloadUrl,
    format: "miniSEED (application/vnd.fdsn.mseed) — binary; use ObsPy, ws2sac, or similar to read it.",
    notice:
      "This server never fetches or inlines waveform bytes. Split very large time ranges into smaller " +
      "requests — GeoNet asks FDSN clients to keep individual pulls modest; for bulk archive access GeoNet " +
      "recommends AWS Open Data over repeated FDSN pulls.",
    attribution: attribution("GeoNet FDSN Web Services (GNS Science)", {
      license: "CC BY 3.0 NZ",
      url: "https://www.geonet.org.nz/data/access/FDSN",
    }),
  });
}
