import { z } from "zod";
import {
  attribution,
  CACHE_TTL,
  cached,
  jsonResult,
  responseFormatParam,
  selectFormat,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { getVolcanoAlertLevels as getVolcanoAlertLevelsClient, type VolcanoAlert } from "../clients/geonet.js";

export const getVolcanoAlertLevelsInputShape = {
  volcano: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Free-text match against a volcano's id or title, e.g. 'ruapehu' or 'White Island'. Omit for all volcanoes."),
  response_format: responseFormatParam,
};

export const getVolcanoAlertLevelsOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getVolcanoAlertLevelsInputShape);

function toConcise(volcano: VolcanoAlert) {
  return {
    volcano_id: volcano.volcanoID,
    title: volcano.volcanoTitle,
    alert_level: volcano.level,
    aviation_colour_code: volcano.acc,
    activity: volcano.activity,
  };
}

function toDetailed(volcano: VolcanoAlert) {
  return {
    ...toConcise(volcano),
    hazards: volcano.hazards,
    longitude: volcano.longitude,
    latitude: volcano.latitude,
  };
}

export async function getVolcanoAlertLevelsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const volcanoes = await cached(env.MCP_CACHE, "geonet:volcano-alert-levels", CACHE_TTL.SLOW_MOVING, () =>
      getVolcanoAlertLevelsClient(),
    );

    const needle = input.volcano?.toLowerCase();
    const filtered = needle
      ? volcanoes.filter(
          (volcano) => volcano.volcanoID.toLowerCase().includes(needle) || volcano.volcanoTitle.toLowerCase().includes(needle),
        )
      : volcanoes;

    const items = filtered.map((volcano) => selectFormat(input.response_format, toConcise(volcano), toDetailed(volcano)));

    return jsonResult({
      items,
      total_count: filtered.length,
      notice:
        filtered.length === 0 && input.volcano
          ? `No volcano matched '${input.volcano}'. Omit \`volcano\` to see all monitored volcanoes and their ids.`
          : "",
      attribution: attribution("GeoNet (GNS Science)", {
        license: "CC BY 3.0 NZ",
        url: "https://www.geonet.org.nz/data/policy",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
