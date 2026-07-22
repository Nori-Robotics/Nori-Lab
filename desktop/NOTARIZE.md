# Signing and notarizing the macOS build

Without notarization, macOS quarantines a downloaded app and reports it as
**"damaged and can't be opened"** — which reads like a corrupt file rather than
a security policy, so most users just give up. This is the difference between a
download that works and one that doesn't.

Everything here is a **one-time setup**, after which builds notarize themselves.

---

## One-time setup

### 1. Get a Developer ID Application certificate

Requires **paid** Apple Developer Program enrollment. A free Apple ID cannot
issue these, and the "Apple Development" certificate you already have is for
local debugging only — it cannot sign for distribution.

Xcode → Settings → Accounts → select your Apple ID → **Manage Certificates** →
**+** → **Developer ID Application**.

Verify:

```bash
security find-identity -v -p codesigning
```

You want a line reading `Developer ID Application: <Name> (TEAMID)`. If you only
see `Apple Development: ...`, the certificate wasn't created.

### 2. Create an app-specific password

`notarytool` will not accept your normal Apple ID password.

appleid.apple.com → Sign-In and Security → **App-Specific Passwords** → generate
one, label it `notarytool`.

### 3. Store the notarization credentials in your keychain

This avoids ever putting the password in a shell history, a script, or an
environment variable:

```bash
xcrun notarytool store-credentials "nori-notary" \
  --apple-id "you@example.com" \
  --team-id "X3T83VTS5A" \
  --password "abcd-efgh-ijkl-mnop"    # the app-specific password
```

`nori-notary` is just a local profile name; the build script reads it from
`$NOTARY_PROFILE`.

---

## Building a notarized release

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (X3T83VTS5A)"
export NOTARY_PROFILE="nori-notary"

./desktop/rebuild_all.sh
```

That is the whole workflow. The script signs every nested binary, builds the
`.app`, packages a DMG, submits it to Apple, staples the ticket, and prints the
SHA-256 to paste into the website's `content/release.ts`.

**Expect it to be slow.** `--timestamp` contacts Apple's timestamp server once
per file and the frozen backend contains several hundred Mach-O binaries.
Notarization itself usually takes 5–15 minutes.

Leaving `APPLE_SIGNING_IDENTITY` unset still produces a working local build —
it's just ad-hoc signed and not distributable.

---

## Why the build is structured this way

**Nested binaries must be signed individually.** Signing the outer `.app` does
not sign Mach-O files inside its `Resources/`. Our PyInstaller bundle
contributes several hundred `.dylib`/`.so` files, and notarization rejects the
entire submission if even one lacks a signature, a secure timestamp, or the
hardened-runtime flag. `desktop/sign_backend.sh` handles this and verifies the
result, because catching a straggler locally is far cheaper than decoding an
opaque rejection from Apple.

**Order matters.** Libraries are signed before the executable that loads them.
Signing a parent embeds hashes of its children, so signing a child afterwards
silently invalidates the parent.

**Stripping must precede signing.** `strip -Sx` invalidates a Mach-O signature.
If the two are reversed, dyld SIGKILLs the process at load — a silent crash with
completely empty logs. This bit us before; don't reorder it.

**Hardened runtime needs entitlements.** Notarization requires hardened runtime,
whose defaults are incompatible with embedded CPython and torch (JIT, ctypes
trampolines, `dlopen` of third-party libraries, `DYLD_*` from the PyInstaller
bootloader). See the annotated reasoning in `tauri/entitlements.plist`. Don't
remove an entitlement without re-testing a *signed* build end to end — the
failures are load-time kills, not exceptions.

**No App Sandbox.** A sandboxed app can't open arbitrary USB serial devices,
which is the entire point of this app. Sandbox is only required for the Mac App
Store, not for Developer ID distribution.

---

## Verifying before you publish

```bash
# Ticket is stapled (works offline, on a machine that has never seen the app)
xcrun stapler validate ~/Downloads/Nori-Lab-<sha>.dmg

# Gatekeeper accepts it — this is what the user's Mac actually runs
spctl -a -vvv -t install /Volumes/Nori\ Lab/Nori\ Lab.app
```

`spctl` should report `accepted` and `source=Notarized Developer ID`.

The real test: download the DMG from the published URL on a Mac that has never
built the app, and open it. Copying the file locally does not set the quarantine
attribute, so a local test can pass while a real download still fails.

---

## After a successful notarized build

1. Copy the printed SHA-256 into `content/release.ts` in the website repo.
2. Set `notarized: true` there — the "macOS will say this is damaged" callout on
   `/download` disappears on its own.
3. Upload the DMG to the GitHub release under the exact `file` name in that same
   manifest.
