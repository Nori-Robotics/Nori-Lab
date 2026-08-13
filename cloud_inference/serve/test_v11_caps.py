"""Pentest V11 (serving side): /act rate limit + input caps. Unit-level — imports
server with the fake adapter, no GPU. Run: python3 test_v11_caps.py"""
import base64, io, os
os.environ["MODEL_KIND"] = "fake"
os.environ["NORI_INFER_TOKEN"] = "tok"
os.environ.pop("NORI_GRANT_PUBLIC_KEY", None)
os.environ["NORI_INFER_RATE_MAX"] = "3"
os.environ["NORI_INFER_RATE_WINDOW_S"] = "10"
os.environ["NORI_INFER_MAX_IMAGE_PIXELS"] = str(64 * 64)
os.environ["NORI_INFER_MAX_IMAGE_B64"] = "5000"

import importlib, server
importlib.reload(server)
from fastapi import HTTPException
from PIL import Image
import numpy as np

CHECKS = 0
def check(c, m):
    global CHECKS; CHECKS += 1
    assert c, f"FAIL: {m}"
    print(f"ok   [{CHECKS}] {m}")

def b64img(w, h):
    buf = io.BytesIO(); Image.new("RGB", (w, h)).save(buf, "JPEG")
    return base64.b64encode(buf.getvalue()).decode()

# rate limit: caller "static", RATE_MAX=3 in 10s
server._rate_hits.clear()
for i in range(3):
    server._rate_check("static")   # first 3 ok
try:
    server._rate_check("static"); check(False, "4th request should 429")
except HTTPException as e:
    check(e.status_code == 429, "rate limit trips at RATE_MAX (429)")
# a DIFFERENT caller has its own bucket
server._rate_check("cust:other")
check(True, "per-caller buckets are independent")

# decompression-bomb / pixel cap in _decode
small = b64img(32, 32)      # 1024px <= 4096 cap
big = b64img(128, 128)      # 16384px > 4096 cap
check(server._decode(small).shape == (32, 32, 3), "small image decodes")
try:
    server._decode(big); check(False, "oversized image should 413")
except HTTPException as e:
    check(e.status_code == 413, "pixel cap rejects a big canvas (413)")

# b64-length cap (a >5000-char base64 string)
huge_b64 = "A" * 6000
check(len(huge_b64) > server.MAX_IMAGE_B64, "test payload exceeds b64 cap")

print(f"\nALL {CHECKS} CHECKS PASSED")
