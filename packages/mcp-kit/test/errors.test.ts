import { describe, expect, it } from "vitest";
import { missingCredentialError, toolError, UpstreamHttpError, upstreamError } from "../src/errors.js";

describe("UpstreamHttpError", () => {
  it("carries the source and response for the catch site to format", () => {
    const response = new Response(null, { status: 429, statusText: "Too Many Requests" });
    const error = new UpstreamHttpError("NIWA Tide API", response);
    expect(error.message).toBe("NIWA Tide API returned HTTP 429 Too Many Requests");
    expect(error.source).toBe("NIWA Tide API");
    expect(error.response).toBe(response);
  });
});

describe("toolError", () => {
  it("marks the result as an error with a plain message", () => {
    const result = toolError("Unknown area code 'Coatsville'.");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Unknown area code 'Coatsville'.");
  });

  it("appends the hint when provided", () => {
    const result = toolError("Unknown area code 'Coatsville'.", "Did you mean 'Coatesville'?");
    expect(result.content[0]?.text).toBe("Unknown area code 'Coatsville'. Did you mean 'Coatesville'?");
  });
});

describe("upstreamError", () => {
  it("describes the HTTP failure with a retry hint", () => {
    const response = new Response(null, { status: 503, statusText: "Service Unavailable" });
    const result = upstreamError("GeoNet", response);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("GeoNet returned HTTP 503 Service Unavailable.");
  });
});

describe("missingCredentialError", () => {
  it("points at the portal page for the specific server", () => {
    const result = missingCredentialError("nz-geo-mcp", "LINZ_API_KEY", "https://mcp.example.invalid");
    expect(result.content[0]?.text).toBe(
      "The upstream API key 'LINZ_API_KEY' is not configured for nz-geo-mcp. Set it at https://mcp.example.invalid/servers/nz-geo-mcp, then retry.",
    );
  });
});
