#!/usr/bin/env bash
# Simulate restrictive venue networks (schools, corporate guest Wi-Fi, hotels)
# on the OPERATOR's macOS laptop, to test where the WebRTC relay and the
# Pi-side safety chain (watchdog / E-STOP) hold up and where they fail.
#
# Usage:
#   sudo ./scripts/netsim.sh udp-blocked   # school/corp: all UDP dead (DNS allowed)
#   sudo ./scripts/netsim.sh strict-443    # worst case: only TCP 80/443 + DNS egress
#   sudo ./scripts/netsim.sh blackout      # total egress cut (mid-session safety test)
#   sudo ./scripts/netsim.sh off           # restore normal networking
#   sudo ./scripts/netsim.sh status        # show active simulation rules
#
# What each profile should produce (see also chrome://webrtc-internals and the
# SDK's "ICE path:" log line):
#
#   udp-blocked  STUN dead, TURN-over-UDP dead. Connects ONLY if the backend's
#                /turn/credentials urls include ?transport=tcp (TCP 3478) or
#                turns: (TLS 5349) — both listeners confirmed open on the relay.
#                Expected: connected *** via TURN relay ***, WAN watchdog profile.
#   strict-443   Signaling (Supabase WSS:443) and API work; media/control FAIL
#                until the relay listens on 443 (coturn alt-tls-listening-port).
#                Expected today: handshake completes, ICE never connects.
#   blackout     Apply DURING an active teleop session. The Pi watchdog (WAN
#                profile 300/1000) must stop the arms; measure time-to-stop and
#                what the operator UI shows. Lift it and observe recovery.
#
# For latency / jitter / loss / bandwidth shaping (congested venue Wi-Fi), use
# Apple's Network Link Conditioner (Xcode "Additional Tools") — friendlier than
# hand-rolled dummynet and composes with these block profiles.
#
# Robot-side (Pi) degradation, run ON the Pi (venue-booth-on-bad-Wi-Fi case):
#   sudo tc qdisc add dev wlan0 root netem delay 200ms 60ms loss 3%   # apply
#   sudo tc qdisc del dev wlan0 root                                  # revert
#
# Mechanism: replaces the live pf ruleset with Apple's default anchors plus our
# block rules ("off" reloads /etc/pf.conf verbatim). Loopback is always passed
# first so the local LeLab stack (:8000/:8080) is never affected.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "needs root: sudo $0 ${1:-}" >&2
  exit 1
fi

APPLE_ANCHORS='
scrub-anchor "com.apple/*"
nat-anchor "com.apple/*"
rdr-anchor "com.apple/*"
dummynet-anchor "com.apple/*"
anchor "com.apple/*"
load anchor "com.apple" from "/etc/pf.anchors/com.apple"
'

load_rules() {
  # $1 = our block rules, appended after Apple's defaults
  printf '%s\n%s\n' "$APPLE_ANCHORS" "$1" | pfctl -q -f -
  pfctl -q -e 2>/dev/null || true # already-enabled is fine
}

case "${1:-}" in
  udp-blocked)
    load_rules '
pass quick on lo0 all
pass out quick proto udp to any port 53
block drop out quick proto udp to any
'
    echo "UDP blocked (DNS allowed). STUN/TURN-UDP are dead; TCP unrestricted."
    ;;
  strict-443)
    load_rules '
pass quick on lo0 all
pass out quick proto udp to any port 53
pass out quick proto tcp to any port { 80, 443 }
block drop out quick proto udp to any
block drop out quick proto tcp to any
'
    echo "Strict egress: TCP 80/443 + DNS only. Relay has no 443 listener today -> expect ICE failure."
    ;;
  blackout)
    load_rules '
pass quick on lo0 all
block drop out quick inet all
block drop out quick inet6 all
'
    echo "Total egress cut. If a teleop session is live, the Pi watchdog must stop the arms NOW."
    ;;
  off)
    pfctl -q -f /etc/pf.conf
    echo "Restored /etc/pf.conf — normal networking."
    ;;
  status)
    pfctl -sr 2>/dev/null | grep -v "^scrub-anchor\|^nat-anchor\|^rdr-anchor\|^dummynet-anchor\|^anchor" || true
    ;;
  *)
    grep '^#   sudo' "$0" | sed 's/^# *//'
    exit 1
    ;;
esac
