import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type DistrictCollection,
  type HighwayNetwork,
  type LandmarkCollection,
  type RailwayNetwork,
  emptyDistricts,
  emptyHighwayNetwork,
  emptyLandmarks,
  emptyRailwayNetwork,
} from "@hcmap/shared";
import { assetUrl, fetchJSON } from "../api";
import { migrateNetworkPaved } from "../edit/model";

export type LineKind = "highway" | "railway";
export type DataKind = "highways" | "railways" | "landmarks" | "districts";

export interface Overlays {
  highways: HighwayNetwork;
  railways: RailwayNetwork;
  landmarks: LandmarkCollection;
  districts: DistrictCollection;
  loaded: boolean;
  dirty: Record<DataKind, boolean>;
  network: (kind: LineKind) => HighwayNetwork | RailwayNetwork;
  updateNetwork: (
    kind: LineKind,
    fn: (net: HighwayNetwork | RailwayNetwork) => void,
  ) => void;
  updateLandmarks: (fn: (doc: LandmarkCollection) => void) => void;
  updateDistricts: (fn: (doc: DistrictCollection) => void) => void;
  save: (kind: DataKind) => Promise<boolean>;
  saveAll: () => Promise<void>;
}

/** Static read path (works without backend); writes go through /api/data. */
function readUrl(kind: DataKind): string {
  return assetUrl(`/data/${kind}.json`);
}

export function useOverlays(): Overlays {
  const [highways, setHighways] = useState<HighwayNetwork>(emptyHighwayNetwork);
  const [railways, setRailways] = useState<RailwayNetwork>(emptyRailwayNetwork);
  const [landmarks, setLandmarks] = useState<LandmarkCollection>(emptyLandmarks);
  const [districts, setDistricts] = useState<DistrictCollection>(emptyDistricts);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState<Record<DataKind, boolean>>({
    highways: false,
    railways: false,
    landmarks: false,
    districts: false,
  });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchJSON<HighwayNetwork>(readUrl("highways")),
      fetchJSON<RailwayNetwork>(readUrl("railways")),
      fetchJSON<LandmarkCollection>(readUrl("landmarks")),
      fetchJSON<DistrictCollection>(readUrl("districts")),
    ]).then(([h, r, l, dist]) => {
      if (cancelled) return;
      if (h) {
        migrateNetworkPaved(h);
        setHighways(h);
      }
      if (r) {
        migrateNetworkPaved(r);
        setRailways(r);
      }
      if (l) setLandmarks(l);
      if (dist) setDistricts(dist);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const network = useCallback(
    (kind: LineKind) => (kind === "highway" ? highways : railways),
    [highways, railways],
  );

  const updateNetwork = useCallback(
    (kind: LineKind, fn: (net: HighwayNetwork | RailwayNetwork) => void) => {
      if (kind === "highway") {
        setHighways((prev) => {
          const draft = structuredClone(prev);
          fn(draft);
          return draft;
        });
        setDirty((d) => ({ ...d, highways: true }));
      } else {
        setRailways((prev) => {
          const draft = structuredClone(prev);
          fn(draft);
          return draft;
        });
        setDirty((d) => ({ ...d, railways: true }));
      }
    },
    [],
  );

  const updateLandmarks = useCallback((fn: (doc: LandmarkCollection) => void) => {
    setLandmarks((prev) => {
      const draft = structuredClone(prev);
      fn(draft);
      return draft;
    });
    setDirty((d) => ({ ...d, landmarks: true }));
  }, []);

  const updateDistricts = useCallback((fn: (doc: DistrictCollection) => void) => {
    setDistricts((prev) => {
      const draft = structuredClone(prev);
      fn(draft);
      return draft;
    });
    setDirty((d) => ({ ...d, districts: true }));
  }, []);

  const docFor = useCallback(
    (kind: DataKind) =>
      kind === "highways"
        ? highways
        : kind === "railways"
          ? railways
          : kind === "landmarks"
            ? landmarks
            : districts,
    [highways, railways, landmarks, districts],
  );

  const save = useCallback(
    async (kind: DataKind): Promise<boolean> => {
      try {
        const res = await fetch(assetUrl(`/api/data/${kind}`), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(docFor(kind)),
        });
        if (!res.ok) return false;
        setDirty((d) => ({ ...d, [kind]: false }));
        return true;
      } catch {
        return false;
      }
    },
    [docFor],
  );

  const saveAll = useCallback(async () => {
    await Promise.all(
      (["highways", "railways", "landmarks", "districts"] as DataKind[]).map((k) => save(k)),
    );
  }, [save]);

  // Stable reference across unrelated re-renders (e.g. cursor tracking on every
  // mousemove) — MapView rebuilds all edit-mode markers whenever this object
  // changes identity, which would tear down a marker mid-drag otherwise.
  return useMemo(
    () => ({
      highways,
      railways,
      landmarks,
      districts,
      loaded,
      dirty,
      network,
      updateNetwork,
      updateLandmarks,
      updateDistricts,
      save,
      saveAll,
    }),
    [
      highways,
      railways,
      landmarks,
      districts,
      loaded,
      dirty,
      network,
      updateNetwork,
      updateLandmarks,
      updateDistricts,
      save,
      saveAll,
    ],
  );
}
