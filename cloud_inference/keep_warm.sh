#!/usr/bin/env bash
#
# Keep the MolmoAct2 inference Space awake by polling its health route.
#
# Credential-free by default: /health is unauthenticated (only /act checks the
# bearer token), so the polling loop can run forever without holding a secret.
#
# The one exception is opt-in and off unless you ask for it. /health reporting
# "ready" does NOT mean the server is warm -- the first /act compiles a CUDA
# graph (~3.6s), so a health-only keep-warm still hands the operator a
# multi-second stall on their first real request. NORI_INFER_WARM_ACT=1 fires a
# single synthetic /act on the ready-transition to compile it, and that DOES
# need the token. Leave it unset and nothing here ever reads a credential.
#
# NOTE: polling is the fallback, not the real fix. A Space on paid hardware has
# a "sleep time" setting (Settings -> Sleep time) -- setting that to "never"
# stops the sleeping at the source and costs exactly the same, because you are
# billed for the GPU either way. This script exists for the case where you want
# the Space warm without changing its configuration, or want a restart-detector
# and a log of when it went cold.
#
# A MANUALLY PAUSED Space will not wake from HTTP. This script will report it as
# persistently unreachable; you have to un-pause it in the UI or via the API.
#
# Usage:
#   ./keep_warm.sh                  # poll forever
#   ./keep_warm.sh --once           # single probe, exit 0 if ready
#   NORI_INFER_URL=... ./keep_warm.sh
#
# Env:
#   NORI_INFER_URL            base URL (default: the Nori MolmoAct2 Space)
#   NORI_INFER_WARM_ACT=1     also fire a synthetic /act once the model is ready
#   KEEP_WARM_INTERVAL        seconds between probes when healthy (default 300)
#   KEEP_WARM_WAKE_INTERVAL   seconds between probes while waking (default 20)
#   KEEP_WARM_TIMEOUT         per-request timeout in seconds (default 30)

set -uo pipefail

URL="${NORI_INFER_URL:-https://norirobotics-molmoact2-space.hf.space}"
URL="${URL%/}"; URL="${URL%/act}"; URL="${URL%/}"   # tolerate a full /act URL

INTERVAL="${KEEP_WARM_INTERVAL:-300}"
WAKE_INTERVAL="${KEEP_WARM_WAKE_INTERVAL:-20}"
TIMEOUT="${KEEP_WARM_TIMEOUT:-30}"

ONCE=0
case "${1:-}" in
  --once) ONCE=1 ;;
  --help|-h) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
esac

BODY="$(mktemp -t molmoact2_warm)"
trap 'rm -f "$BODY"' EXIT
trap 'log "stopping (signal)"; exit 0' INT TERM

log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

# Echoes "<http_code> <status>", where <status> is the app's own readiness
# string (ready|loading|error) or "-" when we got no parseable body.
probe() {
  local code status
  code="$(curl -sS -m "$TIMEOUT" -o "$BODY" -w '%{http_code}' "$URL/health" 2>/dev/null)" || code="000"
  status="$(sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$BODY" 2>/dev/null)"
  printf '%s %s' "$code" "${status:-−}"
}

consecutive_cold=0
last_state=""
nap=0

while :; do
  read -r code status <<<"$(probe)"

  case "$code:$status" in
    200:ready)
      # /health going "ready" does NOT mean the server is warm: the first /act
      # compiles a CUDA graph (~3.6s), so a health-only keep-warm still leaves a
      # multi-second stall on the operator's first real request. Firing one
      # synthetic /act compiles it. Opt-in because it needs the bearer token, and
      # the rest of this script is deliberately credential-free.
      if [ "$last_state" != "ready" ] && [ "${NORI_INFER_WARM_ACT:-}" = "1" ] \
         && [ -r "$HOME/.nori_infer_token" ]; then
        curl -sS -m 60 -o /dev/null \
          -H "Content-Type: application/json" \
          -H "Authorization: Bearer $(cat "$HOME/.nori_infer_token")" \
          -d '{"images":[],"state":[0,0,0,0,0,0],"instruction":"warm","num_steps":1}' \
          "$URL/act" 2>/dev/null || true
        log "fired a synthetic /act to compile the CUDA graph"
      fi
      if [ "$last_state" != "ready" ]; then
        if [ "$consecutive_cold" -gt 0 ]; then
          log "READY (came back after $consecutive_cold cold probe(s))"
        else
          log "READY"
        fi
      fi
      last_state="ready"; consecutive_cold=0
      nap="$INTERVAL"
      ;;

    200:loading)
      # Container is up, weights still loading. Poll fast so we log the
      # ready-transition promptly rather than up to INTERVAL late.
      [ "$last_state" = "loading" ] || log "loading (container up, weights not resident)"
      last_state="loading"
      nap="$WAKE_INTERVAL"
      ;;

    200:error)
      # The app is serving but failed to load the model. Polling cannot fix
      # this -- it needs a redeploy -- so report it loudly and back off.
      log "ERROR: app is up but model load FAILED -- redeploy needed, polling will not fix it"
      last_state="error"
      nap="$INTERVAL"
      ;;

    *)
      consecutive_cold=$((consecutive_cold + 1))
      [ "$last_state" = "cold" ] || log "cold/unreachable (http=$code) -- probing to wake"
      last_state="cold"
      # A sleeping Space wakes on HTTP; a paused one never will. Say so once
      # we've waited long enough that "still booting" stops being plausible.
      if [ "$consecutive_cold" -eq 30 ]; then
        log "still unreachable after $consecutive_cold probes -- Space may be PAUSED (HTTP cannot wake a paused Space; un-pause it in the UI)"
      fi
      nap="$WAKE_INTERVAL"
      ;;
  esac

  # Exit BEFORE napping -- otherwise --once blocks for a full INTERVAL after it
  # already knows the answer.
  if [ "$ONCE" -eq 1 ]; then
    [ "$status" = "ready" ] && exit 0 || exit 1
  fi
  sleep "$nap"
done
