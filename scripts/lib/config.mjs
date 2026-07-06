/** Shared config for the session-sync server + clients. Host-agnostic. */
import { join } from "path";
import { homedir, hostname } from "os";

export const DEFAULT_PORT = 8765;

/** Server base URL clients talk to. Override with SESSION_SYNC_URL or --server. */
export function serverUrl(argv = []) {
  const i = argv.indexOf("--server");
  if (i >= 0 && argv[i + 1]) return argv[i + 1].replace(/\/$/, "");
  if (process.env.SESSION_SYNC_URL) return process.env.SESSION_SYNC_URL.replace(/\/$/, "");
  return `http://127.0.0.1:${DEFAULT_PORT}`;
}

/** Where the SERVER persists uploaded sessions + index. Override with SESSION_SYNC_DATA. */
export function dataDir() {
  return process.env.SESSION_SYNC_DATA || join(homedir(), ".session-sync");
}

/** This machine's device tag. Override with SESSION_SYNC_DEVICE or --device. */
export function deviceName(argv = []) {
  const i = argv.indexOf("--device");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return process.env.SESSION_SYNC_DEVICE || hostname();
}

/** Read a --flag value from argv, or undefined. */
export function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
