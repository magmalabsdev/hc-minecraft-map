import type { Dimension } from "@hcmap/shared";
import { assetUrl, fetchJSON } from "../api";

interface HeightHeader {
  originX: number;
  originZ: number;
  cellSize: number;
  width: number;
  height: number;
  bias: number;
}

/**
 * Samples the preprocessed terrain heightmap (snapshot/<dim>/derived/height.png)
 * so route finding can reject deviations across steep terrain.
 */
export class HeightField {
  private constructor(
    private readonly data: Uint8ClampedArray,
    private readonly h: HeightHeader,
  ) {}

  static async load(dim: Dimension): Promise<HeightField | null> {
    const header = await fetchJSON<HeightHeader>(
      assetUrl(`/snapshot/${dim}/derived/height.json`),
    );
    if (!header) return null;
    const img = new Image();
    img.src = assetUrl(`/snapshot/${dim}/derived/height.png`);
    try {
      await img.decode();
    } catch {
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = header.width;
    canvas.height = header.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, header.width, header.height).data;
    return new HeightField(data, header);
  }

  private cell(gx: number, gz: number): number {
    const x = Math.max(0, Math.min(this.h.width - 1, gx));
    const z = Math.max(0, Math.min(this.h.height - 1, gz));
    const o = (z * this.h.width + x) * 4;
    return this.data[o] * 256 + this.data[o + 1] - this.h.bias;
  }

  /** Bilinearly-sampled surface height at block (x, z). */
  sample(x: number, z: number): number {
    const gx = (x - this.h.originX) / this.h.cellSize;
    const gz = (z - this.h.originZ) / this.h.cellSize;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fz = gz - z0;
    const h00 = this.cell(x0, z0);
    const h10 = this.cell(x0 + 1, z0);
    const h01 = this.cell(x0, z0 + 1);
    const h11 = this.cell(x0 + 1, z0 + 1);
    return (
      h00 * (1 - fx) * (1 - fz) +
      h10 * fx * (1 - fz) +
      h01 * (1 - fx) * fz +
      h11 * fx * fz
    );
  }

  /** Max absolute slope (blocks vertical per block horizontal) along a→b. */
  maxSlopeAlong(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    step = 3,
  ): number {
    const dist = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(dist / step));
    let prev = this.sample(ax, az);
    let worst = 0;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const h = this.sample(ax + (bx - ax) * t, az + (bz - az) * t);
      const slope = Math.abs(h - prev) / (dist / n);
      if (slope > worst) worst = slope;
      prev = h;
    }
    return worst;
  }
}
