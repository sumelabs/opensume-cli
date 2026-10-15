import { extname } from "node:path";

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".glb": "model/gltf-binary",
  ".json": "application/json",
  ".srt": "application/x-subrip",
};

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "model/gltf-binary": ".glb",
  "application/json": ".json",
};

/** Every file extension the CLI can upload, for messages. */
export const MEDIA_EXTENSIONS = Object.keys(TYPES);

export function contentTypeFor(path: string): string | undefined {
  return TYPES[extname(path).toLowerCase()];
}

/**
 * The file extension for an artifact: its content type first, then the
 * extension in its URL, then a guess from its kind.
 */
export function extensionFor(contentType: string | undefined, url?: string, kind?: string): string {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  if (type && EXTENSIONS[type]) return EXTENSIONS[type];
  if (url) {
    try {
      const ext = extname(new URL(url).pathname).toLowerCase();
      if (ext && TYPES[ext]) return ext;
    } catch {
      // Not a URL; fall through.
    }
  }
  if (kind === "image") return ".png";
  if (kind === "video") return ".mp4";
  if (kind === "audio") return ".mp3";
  return ".bin";
}

export const isHttpUrl = (value: string) => /^https?:\/\//iu.test(value);
