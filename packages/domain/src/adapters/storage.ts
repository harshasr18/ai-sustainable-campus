/**
 * Evidence (photo) storage adapter.
 *
 * Brief requirements, all enforced here:
 *   - stored OUTSIDE any public/static directory
 *   - unique storage names; the client filename is NEVER trusted or used
 *   - file type + size validated (MIME is checked against real magic bytes, not
 *     the client-supplied Content-Type, which is trivially spoofed)
 *   - path traversal prevented structurally (keys are generated, never parsed from
 *     user input, and resolved paths are verified to stay inside the root)
 *   - authorization enforced on RETRIEVAL (only the reporter, or HOD/ADMIN in the
 *     same workspace — see canReadEvidence in issues.ts)
 *   - replaceable with object storage later, because callers only ever see an
 *     opaque key + a stream
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validationFailed } from '../errors.js';

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export const EVIDENCE_MAX_BYTES_DEFAULT = 8 * 1024 * 1024; // 8 MiB

export interface StoredEvidence {
  /** Opaque key persisted on the report. Contains no user-controlled text. */
  key: string;
  bytes: number;
  mimeType: AllowedImageType;
  sha256: string;
}

export interface EvidenceStorage {
  save(input: { buffer: Buffer; declaredMimeType?: string | null; workspaceId: string }): Promise<StoredEvidence>;
  /** Returns the raw bytes; callers MUST have authorized the caller first. */
  read(key: string): Promise<Buffer>;
  /** Opaque reference used by the AI adapter (never a public URL). */
  toReference(key: string): string;
  readonly kind: string;
}

/**
 * Resolves an opaque evidence reference (as produced by `toReference`) back to bytes.
 *
 * Only this function knows how a reference maps onto a storage adapter, so the AI layer
 * can be handed a reader without ever seeing a path, a URL, or the database. It lives
 * beside `toReference` rather than at the call site because the two form one convention
 * — the `kind://` prefix — and splitting them across files is how a prefix and its
 * parser drift apart.
 *
 * Callers MUST have authorized the caller before reading. This function checks nothing:
 * it is the last step of a permission check that already happened.
 */
export function readEvidenceRef(storage: EvidenceStorage, reference: string): Promise<Buffer> {
  const prefix = `${storage.kind}://`;
  const key = reference.startsWith(prefix) ? reference.slice(prefix.length) : reference;
  return storage.read(key);
}

/* --------------------------- content sniffing ------------------------------ */

/**
 * Detects the real image type from magic bytes. A file uploaded as image/jpeg that
 * is actually an HTML document or PDF is rejected — defence against stored XSS and
 * content-type confusion.
 */
export function detectImageType(buffer: Buffer): AllowedImageType | null {
  if (buffer.length < 12) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  // WEBP: "RIFF"...."WEBP"
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

const EXTENSION: Record<AllowedImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/* ------------------------------ local adapter ------------------------------ */

export interface LocalEvidenceStorageOptions {
  rootDir: string;
  maxBytes?: number;
}

export class LocalEvidenceStorage implements EvidenceStorage {
  readonly kind = 'local-filesystem';
  private readonly root: string;
  private readonly maxBytes: number;

  constructor(options: LocalEvidenceStorageOptions) {
    // Resolved ONCE, so every later containment check compares against a real path.
    this.root = path.resolve(options.rootDir);
    this.maxBytes = options.maxBytes ?? EVIDENCE_MAX_BYTES_DEFAULT;
  }

  async save(input: { buffer: Buffer; declaredMimeType?: string | null; workspaceId: string }): Promise<StoredEvidence> {
    const { buffer } = input;

    if (buffer.length === 0) throw validationFailed('Uploaded photo is empty.');
    if (buffer.length > this.maxBytes) {
      throw validationFailed(`Photo exceeds the maximum size of ${Math.floor(this.maxBytes / 1024 / 1024)} MB.`);
    }

    const detected = detectImageType(buffer);
    if (!detected) {
      throw validationFailed('Unsupported file type. Only JPEG, PNG and WebP photographs are accepted.');
    }
    // Reject an outright lie about the type — cheap, and it surfaces client bugs early.
    if (input.declaredMimeType && input.declaredMimeType !== detected) {
      throw validationFailed(`Declared type ${input.declaredMimeType} does not match the file's actual type ${detected}.`);
    }

    // Generated key. The client's filename appears nowhere in the path.
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    // workspaceId is a trusted server value (a UUID), never client text.
    const key = `${input.workspaceId}/${yyyy}/${mm}/${randomUUID()}.${EXTENSION[detected]}`;

    const absolute = this.resolveInsideRoot(key);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, buffer, { mode: 0o600 });

    return {
      key,
      bytes: buffer.length,
      mimeType: detected,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    };
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.resolveInsideRoot(key));
  }

  toReference(key: string): string {
    return `local://${key}`;
  }

  /**
   * Path-traversal guard. Keys leaving this adapter are always generated, but this
   * check also protects against a corrupted/hostile key arriving from the database.
   * Containment is decided on the RESOLVED path, so `../` cannot escape.
   */
  private resolveInsideRoot(key: string): string {
    if (key.includes('\0')) throw validationFailed('Invalid evidence key.');
    const absolute = path.resolve(this.root, key);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (absolute !== this.root && !absolute.startsWith(rootWithSep)) {
      throw validationFailed('Invalid evidence key.');
    }
    return absolute;
  }
}
