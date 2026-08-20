import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { TAARenderPass } from "three/examples/jsm/postprocessing/TAARenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

/**
 * Objects on this layer, and only these, are allowed to bloom.
 *
 * Thresholded bloom cannot work on this model. The lift is metalness 0.95 and
 * the screen 0.85, so under image-based lighting their specular highlights sit
 * right around the same brightness as anything emissive — set the threshold
 * above them and the eyes stop glowing, set it below and whole panels veil.
 * There is no value that separates the two.
 *
 * Selective bloom sidesteps the question: the bloom pass renders ONLY this
 * layer, so nothing else can contribute however bright it gets.
 */
export const BLOOM_LAYER = 1;

// Shared stand-ins for the bloom pass: everything not on BLOOM_LAYER renders
// with these, so it occludes without contributing.
const blackMesh = new THREE.MeshBasicMaterial({ color: 0x000000 });
const blackLine = new THREE.LineBasicMaterial({ color: 0x000000 });

/**
 * Post-processing for the robot viewer.
 *
 * WHY THIS IS AWKWARD
 * The urdf-viewer custom element owns its own render loop and calls
 * `renderer.render(scene, camera)` directly, so there is no hook to insert a
 * composer. Rather than fork the element or run a competing loop (two loops
 * fighting over one canvas is worse than any hack), this intercepts
 * `renderer.render` itself: the element's call runs the composer instead, and
 * the composer's own internal render calls pass straight through via a reentry
 * guard.
 *
 * WHAT EACH PASS BUYS
 *   TAA    the composer renders to an offscreen target, which bypasses the
 *          renderer's MSAA — so without this, enabling post-processing makes
 *          edges WORSE. TAA also accumulates while the view is still, which
 *          suits a page people orbit and then stop.
 *   SSAO   crevice darkening. The single biggest reason machined parts read as
 *          solid objects rather than flat shapes.
 *   Bloom  a high threshold so only the eyes and screen glow, not the whole
 *          white shell.
 *   Output tone mapping and colour-space conversion, which must happen at the
 *          END of the chain. Leaving it to the renderer double-converts.
 */

export type Post = {
  composer: EffectComposer;
  taa: TAARenderPass;
  setSize: (w: number, h: number) => void;
  /** Call when the camera or pose changes: restarts TAA accumulation. */
  invalidate: () => void;
  /**
   * Turn the bloom chain off without tearing the composer down.
   *
   * Bloom costs a WHOLE extra render of the scene every frame — the full-scene
   * black-out pass — plus its blur chain. That is a fair price for glowing eyes
   * on a robot filling the frame, and a poor one when the robot is three metres
   * away in a room and the eyes are a few pixels across.
   */
  setBloomEnabled: (enabled: boolean) => void;
  dispose: () => void;
};

/**
 * Which passes to run. Driven from the URL so a pass can be isolated without a
 * rebuild — "the image looks wrong" has several possible causes in a chain like
 * this and they are indistinguishable by eye when all of them are on.
 *
 *   ?nopost=1    no composer at all (handled by the caller)
 *   ?nossao=1    skip ambient occlusion
 *   ?nobloom=1   skip bloom
 *   ?notaa=1     plain RenderPass instead of TAA
 */
export function passFlags() {
  const q =
    typeof window === "undefined"
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search);
  return {
    ssao: !q.has("nossao"),
    bloom: !q.has("nobloom"),
    taa: !q.has("notaa"),
  };
}

export function attachPostProcessing(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  size: { width: number; height: number }
): Post {
  const flags = passFlags();
  // The intermediate target is pinned explicitly rather than left to the
  // composer's default.
  //
  // The scene must land in this target in LINEAR light: OutputPass is what
  // converts to sRGB at the end of the chain. If the target's texture is tagged
  // sRGB instead, three decodes it back to linear when a pass samples it and
  // OutputPass then encodes again — a whole gamma is lost and every pixel comes
  // out darker, uniformly, with no single pass responsible. That is exactly the
  // failure this replaced: disabling SSAO, bloom or TAA individually changed
  // nothing, but bypassing the composer entirely was much brighter.
  //
  // HalfFloat because bloom thresholds against HDR values above 1.0, and
  // samples:4 restores the MSAA that going offscreen would otherwise discard.
  const target = new THREE.WebGLRenderTarget(
    Math.max(1, size.width),
    Math.max(1, size.height),
    {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: 4,
    }
  );
  const composer = new EffectComposer(renderer, target);
  composer.setSize(size.width, size.height);

  const taa = new TAARenderPass(scene, camera, 0x000000, 0);
  // 2 => 4 samples. Higher is visibly cleaner but multiplies scene draws, and
  // this is a page someone drags things around on.
  taa.sampleLevel = 2;
  taa.unbiased = false;
  if (flags.taa) composer.addPass(taa);
  else composer.addPass(new RenderPass(scene, camera));

  const ssao = new SSAOPass(scene, camera, size.width, size.height);
  // SSAO builds its own depth/normal targets from the camera's near/far. Those
  // are set tight in RobotUrdfViewer for exactly this reason — see the note on
  // camera.near there before widening them.
  // Tuned for a ~1.3 m robot in metres: a radius in the centimetres darkens
  // panel gaps and joint seams. Scene-scale units matter here — the defaults
  // assume a much larger scene and produce a uniform grey wash.
  ssao.kernelRadius = 0.03;
  ssao.minDistance = 0.0008;
  // Short range on purpose: AO should darken where parts actually meet, not
  // shade whole surfaces. A long maxDistance is what turns SSAO from contact
  // shading into an overall grey that also reads as desaturation, because it
  // only ever subtracts light.
  ssao.maxDistance = 0.03;
  // SSAO occludes by darkening, so it only ever removes light. Left at full
  // strength on top of an already-graded image it reads as grime rather than
  // shading — this keeps it to a suggestion of contact.
  ssao.output = SSAOPass.OUTPUT.Default;
  if (flags.ssao) composer.addPass(ssao);

  // Bloom, deliberately hard to trigger.
  //
  // The threshold is above 1.0 on purpose. The scene renders to a HalfFloat
  // target, so values are HDR and a specular highlight on a metallic surface
  // sits just around 1.0 — at a threshold of 0.92 the lift (metalness 0.95) and
  // the screen (0.85) bloomed across whole panels, which reads as fog rather
  // than glow. Only genuinely emissive geometry goes past 1.15, and on this
  // model that is the eyes and nothing else.
  //
  // Radius is small for the same reason: a wide radius spreads whatever it
  // catches into a veil over the frame.
  // --- selective bloom ---
  // Pass one renders only BLOOM_LAYER and blurs it. Restricting the camera's
  // layers means the rest of the robot is not drawn at all, so it cannot
  // contribute — no material swapping, and no threshold to balance.
  const bloomTarget = new THREE.WebGLRenderTarget(
    Math.max(1, size.width),
    Math.max(1, size.height),
    { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace }
  );
  const bloomComposer = new EffectComposer(renderer, bloomTarget);
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.width, size.height),
    1.1, // strength — can be generous now that only the eyes feed it
    0.4, // radius
    0.0 // threshold — nothing to gate against; the layer already selects
  );
  bloomComposer.addPass(bloom);

  // Pass two adds that result over the full-scene image.
  const combine = new ShaderPass(
    new THREE.ShaderMaterial({
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: bloomComposer.renderTarget2.texture },
      },
      vertexShader: `varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D baseTexture;
        uniform sampler2D bloomTexture;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(baseTexture, vUv) + texture2D(bloomTexture, vUv);
        }`,
    }),
    "baseTexture"
  );
  combine.needsSwap = true;
  if (flags.bloom) composer.addPass(combine);

  composer.addPass(new OutputPass());

  // --- the interception ---
  const originalRender = renderer.render.bind(renderer);
  let inside = false;
  let bloomEnabled = flags.bloom;
  const patched = (s: THREE.Scene, c: THREE.Camera) => {
    // Intercept ONLY the element's main scene render. Other code renders
    // through this same renderer for its own purposes — PMREMGenerator bakes
    // environment maps with internal renderer.render(mesh, camera) calls — and
    // hijacking those corrupts what they produce. That was a real bug: theHDRI
    // arrived async after this patch was installed, PMREM's face renders got
    // swallowed by the composer, and the scene's environment was silently
    // replaced with garbage — read as "the env knob does nothing" and "the
    // composited image is dark no matter what".
    if (inside || s !== scene || c !== camera) return originalRender(s, c);
    inside = true;
    try {
      if (bloomEnabled) {
        // Bloom render = the FULL scene, with everything that must not glow
        // swapped to flat black — not a layer-restricted render.
        //
        // Restricting the camera to BLOOM_LAYER was the first version, and it
        // had a real defect: with the head simply not drawn, the eyes rendered
        // unoccluded, so their glow showed through the body from behind as if
        // the robot were transparent. Drawing the whole robot in black keeps
        // the depth buffer honest — black geometry contributes nothing to the
        // blur but still hides what is behind it.
        //
        // Also silenced per-pass:
        //   * scene.background — RenderPass paints it regardless, and a blurred
        //     full-frame wash was the "pure white viewport" bug.
        //   * the eyes' own lit albedo — near-white under lighting sits ~1.0
        //     HDR and swamps the emissive term, which made the eye dial jump
        //     from nothing to everything. Black albedo + no env response leaves
        //     exactly `emissive * emissiveIntensity` as the bloom input.
        const restoreBackground = s.background;
        s.background = null;
        const swapped: Array<{
          obj: THREE.Mesh;
          material: THREE.Material | THREE.Material[];
        }> = [];
        const eyes: Array<{
          m: THREE.MeshStandardMaterial;
          color: THREE.Color;
          env: number;
        }> = [];
        s.traverse((o) => {
          const obj = o as THREE.Mesh;
          if (!obj.material) return;
          if (obj.isMesh && obj.layers.isEnabled(BLOOM_LAYER)) {
            const m = obj.material as THREE.MeshStandardMaterial;
            if (m?.isMeshStandardMaterial) {
              eyes.push({ m, color: m.color.clone(), env: m.envMapIntensity });
              m.color.setRGB(0, 0, 0);
              m.envMapIntensity = 0;
            }
            return;
          }
          swapped.push({ obj, material: obj.material });
          obj.material = obj.isMesh ? blackMesh : blackLine;
        });
        bloomComposer.render();
        s.background = restoreBackground;
        for (const { obj, material } of swapped) obj.material = material;
        for (const { m, color, env } of eyes) {
          m.color.copy(color);
          m.envMapIntensity = env;
        }
      }
      composer.render();
    } finally {
      inside = false;
    }
  };
  (renderer as unknown as { render: unknown }).render = patched;

  return {
    composer,
    taa,
    setSize: (w, h) => {
      composer.setSize(w, h);
      bloomComposer.setSize(w, h);
      ssao.setSize(w, h);
      bloom.setSize(w, h);
    },
    invalidate: () => {
      taa.accumulate = false;
    },
    setBloomEnabled: (enabled) => {
      bloomEnabled = flags.bloom && enabled;
      // The combine pass has to go with it: left enabled it would keep adding
      // whatever stale image is sitting in the bloom target.
      combine.enabled = bloomEnabled;
    },
    dispose: () => {
      (renderer as unknown as { render: unknown }).render = originalRender;
      composer.dispose();
      bloomComposer.dispose();
      target.dispose();
      bloomTarget.dispose();
    },
  };
}
