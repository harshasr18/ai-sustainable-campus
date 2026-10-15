/**
 * Image decoding — a SEPARATE responsibility from inference (§5 keeps image
 * validation/preprocessing apart from vision-model inference).
 *
 * This is its own module for two reasons:
 *
 *  1. MEMORY. Importing the Transformers.js runtime pulls in the native ONNX runtime
 *     (hundreds of MB). Anything that wants to decode an image without running a model
 *     — tests, a future thumbnailer — should not pay that cost. The heavy import is
 *     dynamic and happens only inside `decodeWithTransformers`.
 *
 *  2. TESTABILITY. Tests inject a decoder, so the pipeline's behaviour can be exercised
 *     deterministically without a model, an ONNX runtime, or a 149 MB download.
 */
import { AiPermanentError } from './ai-errors.js';

/** Smallest acceptable image edge, in pixels (§8: pixel-dimension limits). */
export const MIN_IMAGE_EDGE_PX = 32;

export interface DecodedImage {
  /** Opaque handle passed to the classifier. Only the decoder understands it. */
  handle: unknown;
  width: number;
  height: number;
}

export type ImageDecoder = (bytes: Buffer, mimeType: string) => Promise<DecodedImage>;

/**
 * Real decoder. Performs genuine decoding: a buffer that passed the magic-byte check
 * but is not a decodable image fails here, permanently, rather than reaching the model
 * as garbage.
 */
export const decodeWithTransformers: ImageDecoder = async (bytes, mimeType) => {
  const { RawImage } = await import('@huggingface/transformers');
  let image: { width: number; height: number };
  try {
    image = (await RawImage.fromBlob(
      new Blob([new Uint8Array(bytes)], { type: mimeType }),
    )) as unknown as { width: number; height: number };
  } catch (error) {
    throw new AiPermanentError(
      `Stored evidence could not be decoded as an image: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'AI_INVALID_EVIDENCE',
    );
  }
  return { handle: image, width: image.width, height: image.height };
};

/** Applies the dimension policy to an already-decoded image. */
export function assertUsableDimensions(decoded: DecodedImage): void {
  if (!decoded.width || !decoded.height) {
    throw new AiPermanentError('Stored evidence decoded to an image with no pixels.', 'AI_INVALID_EVIDENCE');
  }
  if (Math.min(decoded.width, decoded.height) < MIN_IMAGE_EDGE_PX) {
    throw new AiPermanentError(
      `Stored evidence is ${decoded.width}x${decoded.height}px; the minimum accepted edge is ${MIN_IMAGE_EDGE_PX}px.`,
      'AI_INVALID_EVIDENCE',
    );
  }
}
