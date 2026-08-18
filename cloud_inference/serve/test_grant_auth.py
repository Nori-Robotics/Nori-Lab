"""V4 scoped-inference grant verify — regression for serve/server._verify_grant
and _require_auth. Mints ES256 grants with a throwaway keypair (mirrors the
backend's NORI_GRANT_SIGNING_KEY / NORI_GRANT_PUBLIC_KEY split) and asserts the
contract: valid accepted; wrong policy_ref / wrong domain / expired / forged all
rejected; static-token transition fallback; REQUIRE_GRANT off-ramp.

Run: python3 test_grant_auth.py   (needs PyJWT[crypto])
"""
import importlib, os, time


def main() -> None:
    import jwt as pyjwt
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    priv = ec.generate_private_key(ec.SECP256R1())
    pub_pem = priv.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    priv_pem = priv.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()).decode()

    os.environ.update({
        "NORI_GRANT_PUBLIC_KEY": pub_pem, "NORI_SERVE_POLICY_REF": "policy-abc",
        "MODEL_KIND": "pi05", "NORI_INFER_TOKEN": "static-xyz",
    })
    import server
    importlib.reload(server)
    import fastapi

    now = int(time.time())
    mint = lambda c: pyjwt.encode(c, priv_pem, algorithm="ES256")
    base = {"customer_id": "cust1", "policy_ref": "policy-abc",
            "dom": "nori-infer-grant-v1", "iat": now, "exp": now + 120}
    good = mint(base)
    other_priv = ec.generate_private_key(ec.SECP256R1()).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()).decode()

    def auth_ok(xh=None, az=None):
        try:
            server._require_auth(xh, az); return True
        except fastapi.HTTPException:
            return False

    checks = [
        ("valid grant accepted", server._verify_grant(good) is not None),
        ("wrong policy_ref rejected", server._verify_grant(mint({**base, "policy_ref": "other"})) is None),
        ("wrong domain rejected", server._verify_grant(mint({**base, "dom": "WRONG"})) is None),
        ("expired rejected", server._verify_grant(mint({**base, "exp": now - 60})) is None),
        ("forged (other key) rejected",
         server._verify_grant(pyjwt.encode(base, other_priv, algorithm="ES256")) is None),
        ("require_auth accepts grant (X-Nori-Token)", auth_ok(xh=good)),
        ("require_auth accepts grant (Bearer)", auth_ok(az=f"Bearer {good}")),
        ("require_auth accepts static token (transition)", auth_ok(xh="static-xyz")),
        ("require_auth rejects junk", not auth_ok(xh="nope")),
    ]
    server.REQUIRE_GRANT = True
    checks.append(("REQUIRE_GRANT drops static fallback", not auth_ok(xh="static-xyz")))
    checks.append(("REQUIRE_GRANT still accepts grant", auth_ok(xh=good)))

    for name, ok in checks:
        print(("ok   " if ok else "FAIL ") + name)
    assert all(ok for _, ok in checks), "grant-auth contract regressions above"
    print(f"\nALL {len(checks)} CHECKS PASSED")


if __name__ == "__main__":
    main()
