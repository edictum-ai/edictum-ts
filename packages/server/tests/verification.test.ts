import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";

import {
  BundleVerificationError,
  verifyBundleSignature,
} from "../src/verification.js";

// ---------------------------------------------------------------------------
// Generate a real Ed25519 keypair for testing
// ---------------------------------------------------------------------------

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
// Ed25519 DER prefix is 12 bytes, public key is last 32 bytes
const publicKeyHex = Buffer.from(publicKeyDer.subarray(12)).toString("hex");

function signData(data: Uint8Array): string {
  const sig = sign(null, data, privateKey);
  return Buffer.from(sig).toString("base64");
}

// ---------------------------------------------------------------------------
// Valid signature
// ---------------------------------------------------------------------------

describe("verifyBundleSignature", () => {
  it("succeeds with a valid signature", () => {
    const yamlBytes = Buffer.from("apiVersion: edictum/v1\nkind: ContractBundle\n");
    const sig = signData(yamlBytes);

    expect(() => verifyBundleSignature(yamlBytes, sig, publicKeyHex)).not.toThrow();
  });

  it("rejects an invalid signature", () => {
    const yamlBytes = Buffer.from("apiVersion: edictum/v1\n");
    const sig = signData(yamlBytes);
    const tamperedYaml = Buffer.from("apiVersion: edictum/v2\n");

    expect(() => verifyBundleSignature(tamperedYaml, sig, publicKeyHex)).toThrow(
      BundleVerificationError,
    );
  });

  it("rejects a corrupted signature", () => {
    const yamlBytes = Buffer.from("test data");
    const sig = signData(yamlBytes);
    // Corrupt the signature by changing a character
    const corrupted = sig.slice(0, -2) + "AA";

    expect(() => verifyBundleSignature(yamlBytes, corrupted, publicKeyHex)).toThrow(
      BundleVerificationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Empty inputs
// ---------------------------------------------------------------------------

describe("empty input validation", () => {
  it("throws on empty signature", () => {
    const yamlBytes = Buffer.from("data");
    expect(() => verifyBundleSignature(yamlBytes, "", publicKeyHex)).toThrow(
      "Signature is empty",
    );
  });

  it("throws on empty public key", () => {
    const yamlBytes = Buffer.from("data");
    expect(() => verifyBundleSignature(yamlBytes, "AAAA", "")).toThrow(
      "Public key is empty",
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid encodings
// ---------------------------------------------------------------------------

describe("encoding validation", () => {
  it("throws on invalid hex public key", () => {
    const yamlBytes = Buffer.from("data");
    expect(() => verifyBundleSignature(yamlBytes, "AAAA", "not-hex-!!")).toThrow(
      BundleVerificationError,
    );
    expect(() => verifyBundleSignature(yamlBytes, "AAAA", "not-hex-!!")).toThrow(
      "Invalid public key hex encoding",
    );
  });

  it("throws on odd-length hex public key", () => {
    const yamlBytes = Buffer.from("data");
    expect(() => verifyBundleSignature(yamlBytes, "AAAA", "abc")).toThrow(
      "Invalid public key hex encoding",
    );
  });

  it("throws on hex string with non-hex characters that Buffer.from would silently accept", () => {
    const yamlBytes = Buffer.from("data");
    // "zz" is not valid hex — Buffer.from("zz", "hex") returns empty Buffer silently
    // 64 chars to pass the length/2 == 32 check if regex weren't there
    const sneakyKey = "zz".repeat(32);
    expect(() => verifyBundleSignature(yamlBytes, "AAAA", sneakyKey)).toThrow(
      "Invalid public key hex encoding",
    );
    expect(() => verifyBundleSignature(yamlBytes, "AAAA", sneakyKey)).toThrow(
      "contains non-hex characters",
    );
  });

  it("throws on hex string with spaces (even length)", () => {
    const yamlBytes = Buffer.from("data");
    // 64 chars total, even length, but contains spaces — should be caught by regex
    const keyWithSpaces = "ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67 89";
    // Pad to 64 chars (even length)
    const padded = (keyWithSpaces + "00".repeat(32)).slice(0, 64);
    expect(() => verifyBundleSignature(yamlBytes, "AAAA", padded)).toThrow(
      "contains non-hex characters",
    );
  });

  it("throws on wrong-length public key", () => {
    const yamlBytes = Buffer.from("data");
    const sig = signData(yamlBytes);
    // Valid hex but wrong length (16 bytes instead of 32)
    const shortKey = "abcdef0123456789abcdef0123456789";

    expect(() => verifyBundleSignature(yamlBytes, sig, shortKey)).toThrow(
      BundleVerificationError,
    );
  });
});

// ---------------------------------------------------------------------------
// BundleVerificationError
// ---------------------------------------------------------------------------

describe("BundleVerificationError", () => {
  it("has correct name", () => {
    const err = new BundleVerificationError("test");
    expect(err.name).toBe("BundleVerificationError");
    expect(err.message).toBe("test");
    expect(err instanceof Error).toBe(true);
  });
});
