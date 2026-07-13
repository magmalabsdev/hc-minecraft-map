import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Dimension } from "@hcmap/shared";
import { fetchJSON } from "../api";
import { HeightField } from "../route/heightField";

interface Manifest {
  tiles: { txMin: number; txMax: number; tzMin: number; tzMax: number };
  tileSize: number;
  heightRange: [number, number] | null;
}
interface HeightHeader {
  originX: number;
  originZ: number;
  cellSize: number;
  width: number;
  height: number;
}

const MESH_RES = 240; // grid quads per side
const EXAGGERATION = 1.3;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Stitch the region's terrain colour tiles into one canvas for the mesh texture. */
async function buildTexture(dim: Dimension, m: Manifest): Promise<HTMLCanvasElement> {
  const { txMin, txMax, tzMin, tzMax } = m.tiles;
  const S = m.tileSize;
  const canvas = document.createElement("canvas");
  canvas.width = (txMax - txMin + 1) * S;
  canvas.height = (tzMax - tzMin + 1) * S;
  const ctx = canvas.getContext("2d")!;
  const jobs: Promise<void>[] = [];
  for (let tz = tzMin; tz <= tzMax; tz++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      jobs.push(
        loadImage(`/snapshot/${dim}/terrain/0/${tx}/${tz}.png`).then((img) => {
          if (img) ctx.drawImage(img, (tx - txMin) * S, (tz - tzMin) * S);
        }),
      );
    }
  }
  await Promise.all(jobs);
  return canvas;
}

export function Terrain3D({ dimension, onBack }: { dimension: Dimension; onBack: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading terrain…");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let raf = 0;
    let cleanup = () => {};

    (async () => {
      const [header, manifest, hf] = await Promise.all([
        fetchJSON<HeightHeader>(`/snapshot/${dimension}/derived/height.json`),
        fetchJSON<Manifest>(`/snapshot/${dimension}/manifest.json`),
        HeightField.load(dimension),
      ]);
      if (disposed) return;
      if (!header || !manifest || !hf) {
        setStatus(`No 3D terrain snapshot for “${dimension}”. Run the mirror for this dimension.`);
        return;
      }

      const regionW = header.width * header.cellSize;
      const regionH = header.height * header.cellSize;
      const canvas = await buildTexture(dimension, manifest);
      if (disposed) return;

      // --- scene ---
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0d0f12);

      const geo = new THREE.BufferGeometry();
      const N = MESH_RES;
      const positions: number[] = [];
      const uvs: number[] = [];
      let sumH = 0;
      for (let iz = 0; iz <= N; iz++) {
        for (let ix = 0; ix <= N; ix++) {
          const u = ix / N;
          const v = iz / N;
          const bx = header.originX + u * regionW;
          const bz = header.originZ + v * regionH;
          const h = hf.sample(bx, bz) * EXAGGERATION;
          sumH += h;
          positions.push(bx - (header.originX + regionW / 2), h, bz - (header.originZ + regionH / 2));
          uvs.push(u, v);
        }
      }
      const indices: number[] = [];
      const row = N + 1;
      for (let iz = 0; iz < N; iz++) {
        for (let ix = 0; ix < N; ix++) {
          const a = iz * row + ix;
          indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
        }
      }
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeVertexNormals();

      const texture = new THREE.CanvasTexture(canvas);
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter;
      const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0 });
      const mesh = new THREE.Mesh(geo, material);
      scene.add(mesh);

      const meanH = sumH / ((N + 1) * (N + 1));
      scene.add(new THREE.AmbientLight(0xffffff, 0.75));
      const sun = new THREE.DirectionalLight(0xffffff, 1.1);
      sun.position.set(-0.6, 1, 0.4).multiplyScalar(1000);
      scene.add(sun);

      // --- renderer / camera / controls ---
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.setSize(host.clientWidth, host.clientHeight);
      host.appendChild(renderer.domElement);

      const camera = new THREE.PerspectiveCamera(55, host.clientWidth / host.clientHeight, 1, 20000);
      camera.position.set(0, Math.max(regionW, regionH) * 0.5 + 400, Math.max(regionW, regionH) * 0.7);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(0, meanH, 0);
      controls.enableDamping = true;
      controls.maxPolarAngle = Math.PI * 0.495;
      controls.update();

      const onResize = () => {
        if (!host.clientWidth) return;
        camera.aspect = host.clientWidth / host.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(host.clientWidth, host.clientHeight);
      };
      const ro = new ResizeObserver(onResize);
      ro.observe(host);

      setStatus("");
      const animate = () => {
        controls.update();
        renderer.render(scene, camera);
        raf = requestAnimationFrame(animate);
      };
      animate();

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        controls.dispose();
        geo.dispose();
        material.dispose();
        texture.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [dimension]);

  return (
    <div className="three-host">
      <div ref={hostRef} className="three-canvas" />
      {status && <div className="three-status">{status}</div>}
      <button className="three-back" onClick={onBack}>
        ← 2D map
      </button>
      <div className="three-hint">drag to orbit · scroll to zoom · right-drag to pan</div>
    </div>
  );
}
