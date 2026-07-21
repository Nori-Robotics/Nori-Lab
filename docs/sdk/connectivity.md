# Connectivity: LAN, STUN, TURN

How the media/control connection is established, and what you need for each situation.

## Same LAN as the robot

Working on-site: peers connect directly via local host candidates. The STUN default is harmless
but not even needed. **Nothing to configure.**

## Over the internet (WAN)

The default public **STUN** server lets both peers discover their public addresses and connect
**directly** — no traffic flows through any third party, and this works on typical home and office
networks. **This is the current default deployment mode.**

## Strict networks

Corporate/university firewalls, hotel or co-working Wi-Fi, CGNAT mobile carriers, VPNs: a direct
connection can be impossible.

The symptom is a session **stuck at ICE/`connecting` that never reaches `connected`** — nothing is
wrong with your code.

This is the one case that needs a **TURN relay** (`turnUrls` / `turnUser` / `turnCred`).

## TURN credentials are minted per session

You no longer ask us for relay credentials. The Nori backend runs a coturn relay on a shared
secret and **mints short-lived credentials at session start** for a signed-in operator:

```
GET /api/v1/turn/credentials     (Authorization: Bearer <your Supabase JWT>)
  -> { urls, username, credential, ttl }
```

The Nori app does this for you on every connect and passes the result straight into
`RemoteTeleop`. If you're building your own client, fetch the same endpoint with the account's
JWT and pass the three values through.

The endpoint requires a provisioned-customer JWT and **401s anonymously**, so an anonymous session
(an open dev room on the LAN) simply stays on STUN — which is what it wants anyway.

::: warning A hand-typed static TURN credential will be rejected
The relay is on `use-auth-secret`, so credentials are time-bound and derived — a fixed
username/password pair we sent you in the past no longer authenticates. Fetch, don't hardcode.
This is why the app's TURN fields were removed from the connection panel: the only thing they
could do was make a working session fail.
:::

Passing the values explicitly:

```ts
const teleop = new RemoteTeleop({
  /* ...options as usual... */
  turnUrls: [TURN_URL],
  turnUser: TURN_USER,
  turnCred: TURN_CRED,
  forceRelay: false,   // true forces ALL traffic through the relay
});
```

`forceRelay: true` forces all traffic through the relay. It's useful to *verify* the TURN path is
working — not something to leave on.

::: tip Privacy
A relay never sees your media in the clear. WebRTC is DTLS-SRTP end-to-end encrypted; a TURN
server only ever observes IPs and traffic volume.
:::

## Camera frames over the LAN, without a browser

On the robot's LAN and want frames as data rather than a video element? Multi-camera robots also
publish raw per-camera **MJPEG frames over ZeroMQ** — no WebRTC involved.

See the nori-protocol `CLIENTS.md` § "Camera frames over the LAN" for the port scheme and a
~15-line Python client.

## Debugging a connection

Symptom-first checklist: [Connection troubleshooting](/troubleshooting/connection).
