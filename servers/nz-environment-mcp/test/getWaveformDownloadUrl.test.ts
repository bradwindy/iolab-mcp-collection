import { afterEach, describe, expect, it, vi } from "vitest";
import { getWaveformDownloadUrlHandler } from "../src/tools/getWaveformDownloadUrl.js";

describe("nz_env_get_waveform_download_url", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds a dataselect URL without making any network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getWaveformDownloadUrlHandler({
      network: "NZ",
      station: "WEL",
      channel: "HHZ",
      start_time: "2026-07-01T00:00:00",
      end_time: "2026-07-01T01:00:00",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const downloadUrl = new URL(result.structuredContent?.download_url as string);
    expect(downloadUrl.origin + downloadUrl.pathname).toBe("https://service.geonet.org.nz/fdsnws/dataselect/1/query");
    expect(downloadUrl.searchParams.get("network")).toBe("NZ");
    expect(downloadUrl.searchParams.get("station")).toBe("WEL");
    expect(downloadUrl.searchParams.get("channel")).toBe("HHZ");
    expect(downloadUrl.searchParams.get("format")).toBe("miniseed");
    expect(downloadUrl.searchParams.has("location")).toBe(false);
  });

  it("includes the location code when provided", async () => {
    const result = await getWaveformDownloadUrlHandler({
      network: "NZ",
      station: "WEL",
      location: "10",
      channel: "HHZ",
      start_time: "2026-07-01T00:00:00",
      end_time: "2026-07-01T01:00:00",
    });

    const downloadUrl = new URL(result.structuredContent?.download_url as string);
    expect(downloadUrl.searchParams.get("location")).toBe("10");
  });

  it("mentions the binary miniSEED format so callers don't expect inlined data", async () => {
    const result = await getWaveformDownloadUrlHandler({
      network: "NZ",
      station: "WEL",
      channel: "HHZ",
      start_time: "2026-07-01T00:00:00",
      end_time: "2026-07-01T01:00:00",
    });

    expect(result.structuredContent?.format).toContain("miniSEED");
    expect(result.isError).toBeUndefined();
  });
});
