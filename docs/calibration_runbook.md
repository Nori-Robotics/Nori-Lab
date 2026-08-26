# Agent metric-calibration runbook

**Goal of this session:** verify the new FK gripper-position grounding on real hardware, smoke-test
the depth grid, and collect the data for the **overhead-camera homography** — the 3×3 matrix that
converts overhead-camera pixels into real robot-frame millimetres on the workspace plane. Once we
have it, the agent can be told "object at pixel (u,v) = (x 340, y −120) mm" in the *same frame* as
its gripper position line, and plan motions by subtraction instead of guessing from the image.

**Branch:** everything here needs LeLab running from `agent-pose-grounding` (commit `937a77f` or
later). Run `lelab --dev`, sign in, connect the robot on the Remote page first.

**You will need:** the robot (A3 or L2), a tape measure, masking tape (to mark spots), ~45 min.

**What already exists (context):**
- Every agent turn and every `get_state` result now carries a line like
  `left gripper ≈ (x 312, y 140, z 905) mm — robot frame: origin on the floor under the base
  center, +x forward, +y robot-left, +z up. Approximate FK from joint telemetry…`
- Every `look` result carries a relative-depth grid (Depth Anything V2 on the backend) — ordinal
  near/far per frame, not metres.
- This runbook produces the third piece: metric pixel→mm for the overhead camera.

**Report back (checklist at the end):** the FK measurements from Part 1, the depth observations
from Part 2, and the filled-in `calibration_points.json` + solver output from Parts 3–4.

---

## Part 1 — FK verification (do this first; it gates everything else)

The FK line is computed from joint telemetry with two assumptions that were **not verifiable
without hardware**. Your measurements confirm or refute them.

1. Open the **Agent** page. Goal:
   `call get_state, report each gripper's position exactly as given, then call done`
   (leave "confirm before first motion" ON — this goal never moves the robot).
2. Copy the reported `(x, y, z)` for each gripper.
3. Tape-measure the real gripper-tip position **in the frame the line itself names**:
   - **A3**: from the point on the floor directly under the base center. +x toward where the
     robot faces, +y toward the robot's own left, +z up.
   - **L2**: from that arm's shoulder-pan axis (the vertical rotation axis at the shoulder), rail
     at its top position.
4. Repeat at **3 different poses** (teleop the arm somewhere new between readings — vary pan,
   reach, and lift).

**Interpret:**

| Observation | Meaning | Action |
|---|---|---|
| All within ~30 mm | FK good | proceed |
| Off by a roughly *constant ratio* (e.g. everything ~1.5× too far) on A3 | the normalized≈degrees unit assumption is wrong for the A3 gateway | record the ratio at 3 poses, report — one-line fix on our side |
| **y has the wrong sign** when you pan the arm (L2: pan the arm to the robot's left → reported y should go **positive**) | pan sign flip needed in `fk.ts` | report — one-line fix |
| z wrong by exactly the lift height | lift sign/zero issue | note the lift.pos value from get_state alongside |

**Do not proceed to Part 3 until x/y are trustworthy** — the homography uses FK as ground truth.
(Part 2 doesn't depend on FK; you can do it regardless.)

---

## Part 2 — Depth grid smoke test (5 min, no motion)

1. Place one object ~20 cm from the front camera and another ~1.5 m away, both visible.
2. Agent goal:
   `look at the front camera, then the overhead camera. Using the depth grids, say which visible
   object is nearest and which is farthest, then call done.`
3. Check in the transcript:
   - The reply references the depth grid (values near 1.00 for the close object's region).
   - Its near/far ordering matches reality.
   - If a look shows **no** depth text: the backend model may be cold — first request after a
     deploy downloads ~100 MB. Just run the goal again. If it never appears, check the browser
     Network tab for `/nori/depth` (expect 200 with a `grid`); report the status/body if not.
4. Note the `ms` field from one `/nori/depth` response in the Network tab — that's our real prod
   inference latency. Report it.

---

## Part 3 — Overhead homography: data collection

### Rules that make the data valid

- **The robot base must not move** from here on (homography is in the robot frame; a base move
  invalidates it). Park it, don't send `base` commands, don't nudge it.
- **The overhead camera must not be bumped.** If either moves, restart Part 3.
- The calibration is valid **for the workspace plane only** (table or floor — whatever surface
  the gripper will touch). All points must be ON that plane.
- Points must be **spread out and not in a line**: use the 4 corners of the reachable workspace,
  plus 2 extra points (one center, one off-center) — 6 total. 4 build the matrix, 2 validate it.

### Per-point procedure (repeat ×6)

1. Stick a small tape cross on the plane at the spot.
2. **Teleop** the gripper so its TIP touches the cross (close the gripper first — the tip is
   better-defined closed). Get it touching, not hovering: the FK point must be *on* the plane.
3. **Record the FK (x, y):** on the Agent page run the get_state goal from Part 1 (or read the
   gripper line from the latest turn's context if a run is open). Write down x and y in mm for
   the arm you're using. Ignore z.
4. **Capture the overhead frame:** agent goal `look at the overhead camera, then call done`.
   Right-click the thumbnail in the transcript → *Save Image As…* → `point_N.jpg`.
   ⚠️ Move the arm as little as possible between step 3 and step 4 — ideally not at all
   (the look doesn't move it; just don't teleop in between).
5. **Read the pixel (u, v)** of the gripper tip / tape cross in that image. Two options:
   - macOS Preview: open the image, Tools → Show Inspector isn't enough — instead make a
     selection starting exactly on the tip; the inspector shows the selection's origin in pixels.
   - Or run the click helper below (needs `pip install opencv-python` in any venv):

   ```python
   # click_point.py — click the gripper tip; prints (u, v). q to quit.
   import cv2, sys
   img = cv2.imread(sys.argv[1])
   def cb(ev, x, y, *a):
       if ev == cv2.EVENT_LBUTTONDOWN: print(f"u={x} v={y}")
   cv2.imshow("img", img); cv2.setMouseCallback("img", cb)
   while cv2.waitKey(50) != ord("q"): pass
   ```

6. Add a row to `calibration_points.json` (create it anywhere, e.g. `~/nori-calib/`):

```json
{
  "robot_serial": "<from the Remote page>",
  "camera": "overhead",
  "image_width":  <width of point_1.jpg — MUST record>,
  "image_height": <height>,
  "arm": "left",
  "date": "2026-08-25",
  "points": [
    { "name": "corner_front_left",  "u": 0, "v": 0, "x_mm": 0.0, "y_mm": 0.0, "holdout": false },
    { "name": "corner_front_right", "u": 0, "v": 0, "x_mm": 0.0, "y_mm": 0.0, "holdout": false },
    { "name": "corner_back_left",   "u": 0, "v": 0, "x_mm": 0.0, "y_mm": 0.0, "holdout": false },
    { "name": "corner_back_right",  "u": 0, "v": 0, "x_mm": 0.0, "y_mm": 0.0, "holdout": false },
    { "name": "center",             "u": 0, "v": 0, "x_mm": 0.0, "y_mm": 0.0, "holdout": true },
    { "name": "off_center",         "u": 0, "v": 0, "x_mm": 0.0, "y_mm": 0.0, "holdout": true }
  ]
}
```

**Why image_width/height matter:** pixels only mean something at a known resolution. The saved
thumbnail is the exact resolution the agent's `look` uses today, but if the video quality setting
changes, the pixels scale — recording the dims lets us rescale instead of recalibrating.

---

## Part 4 — Solve and validate

Save as `solve_homography.py` next to the JSON and run
`python3 solve_homography.py calibration_points.json` (needs only numpy — if your system python
lacks it, use the repo venv: `<NoriLeLab>/.venv/bin/python solve_homography.py …`):

```python
#!/usr/bin/env python3
"""DLT homography: overhead pixels (u,v) -> robot-frame mm (x,y) on the workspace plane."""
import json, sys
import numpy as np

data = json.load(open(sys.argv[1]))
fit = [p for p in data["points"] if not p["holdout"]]
hold = [p for p in data["points"] if p["holdout"]]
assert len(fit) >= 4, "need >= 4 non-holdout points"

def solve(points):
    rows = []
    for p in points:
        u, v, x, y = p["u"], p["v"], p["x_mm"], p["y_mm"]
        rows.append([u, v, 1, 0, 0, 0, -x*u, -x*v, -x])
        rows.append([0, 0, 0, u, v, 1, -y*u, -y*v, -y])
    _, _, vt = np.linalg.svd(np.asarray(rows, dtype=float))
    return vt[-1].reshape(3, 3)

def apply(H, u, v):
    w = H @ [u, v, 1.0]
    return w[0]/w[2], w[1]/w[2]

H = solve(fit)
print("H =", np.array2string(H, precision=6))
for label, pts in (("fit", fit), ("HOLDOUT", hold)):
    for p in pts:
        x, y = apply(H, p["u"], p["v"])
        err = ((x-p["x_mm"])**2 + (y-p["y_mm"])**2) ** 0.5
        print(f"  [{label}] {p['name']:20s} predicted ({x:7.1f},{y:7.1f})  "
              f"measured ({p['x_mm']:7.1f},{p['y_mm']:7.1f})  err {err:5.1f} mm")

out = dict(data, homography=H.tolist(), solver="dlt-v1")
json.dump(out, open("overhead_homography.json", "w"), indent=2)
print("wrote overhead_homography.json")
```

**Acceptance:**

| Holdout error | Verdict |
|---|---|
| < 15 mm | excellent — ship it |
| 15–30 mm | usable; likely imprecise clicking or the tip wasn't quite on the plane — fine for guiding motion, redo later if we need grasp-grade accuracy |
| > 30 mm | something's off — most often: a point recorded after the base shifted, wrong arm's FK line, or a (u,v) typo. Check the worst point first; re-collect just that one |

If a *fit* point has a wildly larger error than the others, it's a bad data row — fix or drop it
and re-run (you still need ≥4 fit points).

---

## Part 5 — Hand off

Send back (Slack or drop in the repo):
1. Part 1 FK table: 3 poses × (reported xyz, measured xyz), robot model, and the lift.pos values.
2. Part 2: does the model's near/far match reality (y/n + one screenshot), and the `/nori/depth` `ms`.
3. `calibration_points.json`, `overhead_homography.json`, the solver's printed errors, and the six `point_N.jpg` images.

The next engineering step (not this runbook) wires `overhead_homography.json` into the agent loop
so overhead `look` results carry metric object coordinates automatically.

## Known limitations (expected, don't debug these)

- Lens distortion is ignored — errors grow toward image corners; that's inside the tolerance above.
- The homography dies if the base or camera moves. Per-session recalibration is the price until we
  anchor it to a workspace fiducial.
- Depth grids are relative per frame; they will NOT become metric from this calibration (that's a
  separate, later anchoring step).
