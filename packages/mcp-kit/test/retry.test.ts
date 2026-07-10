import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithBackoff } from "../src/retry.js";

describe("fetchWithBackoff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns immediately on a successful response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithBackoff("https://example.test", undefined, { baseDelayMs: 1 });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries on 429 and eventually succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithBackoff("https://example.test", undefined, {
      baseDelayMs: 1,
      maxAttempts: 3,
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and returns the last response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithBackoff("https://example.test", undefined, {
      baseDelayMs: 1,
      maxAttempts: 2,
    });

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx errors other than 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithBackoff("https://example.test", undefined, { baseDelayMs: 1 });

    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("honours the Retry-After header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithBackoff("https://example.test", undefined, { maxAttempts: 3 });

    expect(response.status).toBe(200);
  });
});
