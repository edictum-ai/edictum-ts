/**
 * Ed25519 bundle signature verification.
 *
 * Uses node:crypto (Node 22+) — no external dependencies.
 */

import { createPublicKey, verify } from 'node:crypto'

/** Raised when a bundle signature is invalid or missing. */
export class BundleVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BundleVerificationError'
  }
}

/**
 * Verify an Ed25519 signature over raw YAML bytes.
 *
 * @param yamlBytes - The raw YAML bundle bytes that were signed.
 * @param signatureB64 - Base64-encoded Ed25519 signature.
 * @param publicKeyHex - Hex-encoded Ed25519 public key (32 bytes).
 *
 * @throws BundleVerificationError if signature is invalid or missing.
 */
export function verifyBundleSignature(
  yamlBytes: Uint8Array,
  signatureB64: string,
  publicKeyHex: string,
): void {
  if (!signatureB64) {
    throw new BundleVerificationError('Signature is empty')
  }

  if (!publicKeyHex) {
    throw new BundleVerificationError('Public key is empty')
  }

  // Odd-length hex gets silently truncated by Buffer.from — reject early
  if (publicKeyHex.length % 2 !== 0) {
    throw new BundleVerificationError('Invalid public key hex encoding: odd-length hex string')
  }

  // Explicit regex check — Buffer.from(hex, "hex") silently drops non-hex chars
  if (!/^[0-9a-fA-F]+$/.test(publicKeyHex)) {
    throw new BundleVerificationError(
      'Invalid public key hex encoding: contains non-hex characters',
    )
  }

  let publicKeyBytes: Buffer
  try {
    publicKeyBytes = Buffer.from(publicKeyHex, 'hex')
    // Belt-and-suspenders: verify hex was fully consumed
    if (publicKeyBytes.length !== publicKeyHex.length / 2) {
      throw new Error('Invalid hex length')
    }
  } catch (error) {
    throw new BundleVerificationError(
      `Invalid public key hex encoding: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // Ed25519 public keys are exactly 32 bytes
  if (publicKeyBytes.length !== 32) {
    throw new BundleVerificationError(
      `Invalid Ed25519 public key: expected 32 bytes, got ${publicKeyBytes.length}`,
    )
  }

  let signatureBytes: Buffer
  try {
    signatureBytes = Buffer.from(signatureB64, 'base64')
    // Validate it was valid base64 by re-encoding and comparing
    if (signatureBytes.toString('base64') !== signatureB64) {
      // Try URL-safe base64
      if (signatureBytes.toString('base64url') !== signatureB64) {
        throw new Error('Invalid base64 encoding')
      }
    }
  } catch (error) {
    throw new BundleVerificationError(
      `Invalid signature base64 encoding: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  try {
    // Build the Ed25519 public key in DER format for node:crypto
    const publicKey = createPublicKey({
      key: Buffer.concat([
        // Ed25519 DER prefix: SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING }
        Buffer.from('302a300506032b6570032100', 'hex'),
        publicKeyBytes,
      ]),
      format: 'der',
      type: 'spki',
    })

    const valid = verify(null, yamlBytes, publicKey, signatureBytes)
    if (!valid) {
      throw new BundleVerificationError(
        'Bundle signature verification failed — the bundle may have been tampered with',
      )
    }
  } catch (error) {
    if (error instanceof BundleVerificationError) {
      throw error
    }
    throw new BundleVerificationError(
      `Signature verification error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
