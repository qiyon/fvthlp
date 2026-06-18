import { $ } from "bun";
import { existsSync } from "fs";

/**
 * Checks if both ffmpeg and ffprobe are available in the PATH.
 */
export async function checkFFmpeg(): Promise<boolean> {
  try {
    await $`ffmpeg -version`.quiet();
    await $`ffprobe -version`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Generates the random output filename in the format: yyMMddHHmm_xxxx.mp4
 */
export function generateOutputFilename(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  
  const chars = "abcdefghijklmnopqrstuvwxyz";
  const randomStr = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  
  return `${yy}${MM}${dd}${HH}${mm}_${randomStr}.mp4`;
}

/**
 * Checks if a file path exists and is a valid file.
 */
export function fileExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Helper to format file size in human-readable string.
 */
export function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}
