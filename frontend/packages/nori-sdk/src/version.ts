// nori-sdk — the nori-protocol version this SDK's wire vocabulary targets.
//
// The SDK speaks the control-channel language (control/jog, command, call, link) that the Pi's
// WebRTC bridge forwards to the daemon's NDJSON control port. The daemon's versioned handshake
// (`hello.protocol_version`) is performed by that bridge, so the SDK never sends `hello` itself —
// but the vocabulary it DOES send is only guaranteed against the protocol version below.
//
// Compat policy: nori-sdk targeting version N is compatible with a daemon speaking nori-protocol
// version N. The daemon rejects a mismatched client (see the protocol's error_version_mismatch).
// When the protocol makes a breaking change, this integer bumps in lockstep with a new SDK major.
export const NORI_PROTOCOL_VERSION = 1;
