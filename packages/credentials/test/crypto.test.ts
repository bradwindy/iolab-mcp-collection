import { describe, expect, it } from "vitest";
import { decryptValue, encryptValue, generateEncryptionKey } from "../src/crypto.js";

describe("generateEncryptionKey", () => {
  it("produces a base64 string that decodes to 32 bytes", () => {
    const key = generateEncryptionKey();
    const bytes = atob(key);
    expect(bytes.length).toBe(32);
  });

  it("produces a different key each time", () => {
    expect(generateEncryptionKey()).not.toBe(generateEncryptionKey());
  });
});

describe("encryptValue / decryptValue", () => {
  it("round-trips a plaintext value", async () => {
    const key = generateEncryptionKey();
    const encrypted = await encryptValue("sk_live_super_secret_api_key", key);
    const decrypted = await decryptValue(encrypted, key);
    expect(decrypted).toBe("sk_live_super_secret_api_key");
  });

  it("produces different ciphertext for the same plaintext (random IV)", async () => {
    const key = generateEncryptionKey();
    const first = await encryptValue("same-value", key);
    const second = await encryptValue("same-value", key);
    expect(first).not.toBe(second);
  });

  it("fails to decrypt with the wrong key", async () => {
    const encrypted = await encryptValue("secret", generateEncryptionKey());
    await expect(decryptValue(encrypted, generateEncryptionKey())).rejects.toThrow();
  });

  it("fails to decrypt tampered ciphertext", async () => {
    const key = generateEncryptionKey();
    const encrypted = await encryptValue("secret", key);
    const tampered = encrypted.slice(0, -4) + (encrypted.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    await expect(decryptValue(tampered, key)).rejects.toThrow();
  });

  it("rejects a key that does not decode to 32 bytes", async () => {
    await expect(encryptValue("secret", btoa("too-short"))).rejects.toThrow(/32 bytes/);
  });

  it("round-trips an empty string", async () => {
    const key = generateEncryptionKey();
    const encrypted = await encryptValue("", key);
    expect(await decryptValue(encrypted, key)).toBe("");
  });
});
