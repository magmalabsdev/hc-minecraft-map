import fs from "node:fs/promises";
import path from "node:path";
import {
  emptyDistricts,
  emptyHighwayNetwork,
  emptyLandmarks,
  emptyRailwayNetwork,
} from "@hcmap/shared";
import { DATA_DIR } from "./config";

/** The editable overlay documents and their default (empty) contents. */
const FILES = {
  highways: { file: "highways.json", empty: emptyHighwayNetwork },
  railways: { file: "railways.json", empty: emptyRailwayNetwork },
  landmarks: { file: "landmarks.json", empty: emptyLandmarks },
  districts: { file: "districts.json", empty: emptyDistricts },
} as const;

export type DataKind = keyof typeof FILES;

export function isDataKind(x: string): x is DataKind {
  return x in FILES;
}

function pathFor(kind: DataKind): string {
  return path.join(DATA_DIR, FILES[kind].file);
}

/** Read an overlay document, returning the empty default if it doesn't exist. */
export async function readData(kind: DataKind): Promise<unknown> {
  try {
    const raw = await fs.readFile(pathFor(kind), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return FILES[kind].empty();
    }
    throw err;
  }
}

/** Persist an overlay document (pretty-printed for reviewable diffs). */
export async function writeData(kind: DataKind, doc: unknown): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = pathFor(kind) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  await fs.rename(tmp, pathFor(kind));
}
