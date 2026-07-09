import { basename } from "node:path";

const LOCAL_METADATA_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export function isLocalMetadataFile(path: string): boolean {
  return LOCAL_METADATA_FILE_NAMES.has(basename(path));
}
