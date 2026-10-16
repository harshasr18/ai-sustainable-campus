/**
 * Camera capture.
 *
 * §7 Step A is strict about this: "Require a newly captured in-app photo… Do not provide a
 * gallery-upload option… Do not claim a photo was captured when it was not."
 *
 * So there is no `<input type="file">` anywhere in the student flow. The only way to produce
 * a photograph here is `getUserMedia` → `drawImage` → `toBlob`, and if any step fails the
 * hook reports why instead of quietly falling back to a file picker. That fallback would be
 * the single easiest way to violate the brief, and it is exactly what most implementations
 * do.
 *
 * WHY NOT `capture="environment"` ON A FILE INPUT: it *hints* at the camera on some Android
 * browsers and is ignored on most desktops, and the user can still pick from the gallery. A
 * hint is not a requirement.
 *
 * Every failure mode the brief lists is a distinct state, because the remedy differs:
 *   insecure  — the page is not on HTTPS/localhost; getUserMedia does not exist at all
 *   denied    — permission refused; the user must change a browser setting
 *   missing   — no camera device on this machine
 *   inuse     — another application holds the camera
 *   unsupported — the browser has no getUserMedia
 * Telling a user "camera error" when the real problem is that they are on http:// is a
 * support ticket waiting to happen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraStatus =
  | 'idle'
  | 'starting'
  | 'live'
  | 'captured'
  | 'denied'
  | 'missing'
  | 'insecure'
  | 'inuse'
  | 'unsupported'
  | 'error';

export interface CapturedPhoto {
  blob: Blob;
  /** Object URL for the preview. Must be revoked when replaced or on unmount. */
  previewUrl: string;
  width: number;
  height: number;
  bytes: number;
  /** Device clock at the moment the frame was drawn. Sent as untrusted `capturedAt`. */
  capturedAt: string;
  /** What the browser reports the active camera to be ('environment', 'user'), if anything. */
  facingMode: string | null;
}

export interface UseCameraResult {
  status: CameraStatus;
  errorMessage: string | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  photo: CapturedPhoto | null;
  /** True once the stream is attached and the video has real dimensions. */
  ready: boolean;
  start: () => Promise<void>;
  capture: () => Promise<void>;
  retake: () => void;
  stop: () => void;
}

const CONSTRAINTS: MediaStreamConstraints = {
  // `ideal` rather than `exact` for the rear camera: on a laptop there is no environment
  // camera at all, and `exact` would fail outright instead of using the front one.
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

export function useCamera(): UseCameraResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const photoUrlRef = useRef<string | null>(null);

  const [status, setStatus] = useState<CameraStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [ready, setReady] = useState(false);

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setReady(false);
  }, []);

  const stop = useCallback(() => {
    releaseStream();
    setStatus('idle');
  }, [releaseStream]);

  const start = useCallback(async () => {
    setErrorMessage(null);

    // 1. Feature detection. On an insecure origin the browser does not expose
    //    `navigator.mediaDevices` at all, which is why this is checked before anything else.
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const insecure = typeof window !== 'undefined' && !window.isSecureContext;
      setStatus(insecure ? 'insecure' : 'unsupported');
      setErrorMessage(
        insecure
          ? 'The camera needs a secure connection. Open the site over HTTPS or on localhost.'
          : 'This browser does not support in-app camera capture. Try a recent Chrome, Edge or Safari.',
      );
      return;
    }

    setStatus('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
      streamRef.current = stream;

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        // `playsInline` matters on iOS: without it, Safari takes the video fullscreen on play.
        video.playsInline = true;
        video.muted = true;
        await video.play().catch(() => {
          // Autoplay can be refused; the user can press play. Not worth failing the capture.
        });
      }
      setStatus('live');
    } catch (caught) {
      releaseStream();
      const error = caught as { name?: string; message?: string };
      switch (error.name) {
        case 'NotAllowedError':
        case 'SecurityError':
          setStatus('denied');
          setErrorMessage(
            'Camera access was blocked. Allow camera permission for this site in your browser settings, then try again.',
          );
          break;
        case 'NotFoundError':
        case 'OverconstrainedError':
          setStatus('missing');
          setErrorMessage('No camera was found on this device.');
          break;
        case 'NotReadableError':
        case 'AbortError':
          setStatus('inuse');
          setErrorMessage('The camera is in use by another application. Close it and try again.');
          break;
        default:
          setStatus('error');
          setErrorMessage(error.message ?? 'The camera could not be started.');
      }
    }
  }, [releaseStream]);

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    // Guard against capturing before the stream has produced a frame: a 0×0 canvas would
    // yield an empty blob, and the server would then correctly reject the report with a
    // confusing message. Better to refuse here and say why.
    if (!video.videoWidth || !video.videoHeight) {
      setStatus('error');
      setErrorMessage('The camera has not produced a picture yet. Wait a moment and try again.');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      setStatus('error');
      setErrorMessage('This browser could not process the picture.');
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const capturedAt = new Date().toISOString();
    const facingMode = streamRef.current?.getVideoTracks()[0]?.getSettings().facingMode ?? null;

    const blob = await new Promise<Blob | null>((resolve) =>
      // JPEG at 0.9: a photograph of a corridor, not a document scan. Keeps a 1080p capture
      // well inside the server's 8 MiB limit while preserving enough detail for the model.
      canvas.toBlob((result) => resolve(result), 'image/jpeg', 0.9),
    );

    if (!blob) {
      setStatus('error');
      setErrorMessage('The picture could not be encoded. Try again.');
      return;
    }

    // Revoke any previous preview so repeated retakes do not leak object URLs.
    if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
    const previewUrl = URL.createObjectURL(blob);
    photoUrlRef.current = previewUrl;

    setPhoto({ blob, previewUrl, width: canvas.width, height: canvas.height, bytes: blob.size, capturedAt, facingMode });
    setStatus('captured');
    releaseStream();
  }, [releaseStream]);

  const retake = useCallback(() => {
    if (photoUrlRef.current) {
      URL.revokeObjectURL(photoUrlRef.current);
      photoUrlRef.current = null;
    }
    setPhoto(null);
    setStatus('idle');
    setErrorMessage(null);
  }, []);

  // Releasing the stream on unmount is not optional: leaving the camera light on after a
  // user navigates away is both a privacy problem and a battery one.
  useEffect(
    () => () => {
      releaseStream();
      if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
    },
    [releaseStream],
  );

  // `ready` gates the shutter button until the stream has real dimensions.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onReady = () => setReady(true);
    video.addEventListener('loadedmetadata', onReady);
    return () => video.removeEventListener('loadedmetadata', onReady);
  });

  return { status, errorMessage, videoRef, photo, ready, start, capture, retake, stop };
}
