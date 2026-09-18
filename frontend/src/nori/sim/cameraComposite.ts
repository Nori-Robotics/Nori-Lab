// NORI: Additive. The robot's rendered cameras as ONE composite video track, the way the
// real bridge sends them: a grid of tiles, row-major, in the order of the sim's
// camera_layout — so RemoteTeleop.cameraView(role) / snapshot(role) / cameraTileRect crop
// the right cell without knowing they are looking at a simulation.
//
// The viewer's inset is a scissor rectangle inside the MAIN canvas showing one camera at a
// time, which cannot be captured as a feed. So this owns a second, offscreen WebGLRenderer
// on a canvas nobody displays, asks the running sim to render every camera into it
// (SimHandle.renderRobotCameras — same optical-frame mounts, walls at real height), and
// hands out canvas.captureStream(). 640x480 at 15 fps is the real robot's operating point.
//
// Cost: a second GL context uploads the scene's geometry and textures a second time. Fine
// for a dev page, not for anything that ships next to a live video call.

import * as THREE from "three";
import type { CameraView, SimHandle } from "./simRuntime";

export interface CameraCompositeOptions {
  /** Tile order. MUST match the mock's descriptor.cameras (its camera_layout). */
  views: readonly CameraView[];
  cols?: number; // default: ceil(sqrt(n)), the same rule the mock's cameraLayoutFrame uses
  width?: number; // default 640
  height?: number; // default 480
  fps?: number; // default 15
}

export interface CameraComposite {
  stream: MediaStream;
  canvas: HTMLCanvasElement;
  dispose(): void;
}

export function createCameraComposite(sim: SimHandle, opts: CameraCompositeOptions): CameraComposite {
  const n = opts.views.length;
  const cols = opts.cols ?? (n < 2 ? 1 : Math.ceil(Math.sqrt(n)));
  const width = opts.width ?? 640;
  const height = opts.height ?? 480;
  const fps = opts.fps ?? 15;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  // preserveDrawingBuffer: captureStream samples the canvas between frames; without it a
  // browser may hand the encoder a cleared buffer on some frames (visible as black flicker).
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: "low-power",
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;

  const draw = () => sim.renderRobotCameras(renderer, opts.views, cols);
  draw();
  const timer = setInterval(draw, 1000 / fps);
  const stream = canvas.captureStream(fps);

  return {
    stream,
    canvas,
    dispose() {
      clearInterval(timer);
      for (const t of stream.getTracks()) t.stop();
      renderer.dispose();
    },
  };
}
