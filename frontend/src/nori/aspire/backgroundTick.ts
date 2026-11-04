// A repeating tick that keeps its pace in a background tab. Browsers throttle a page's own timers once it is hidden, down
// to about one a minute, which is slower than the deadman's check-in limit, so a task was being cancelled just because the
// operator looked at another window. A dedicated worker's timers are not throttled that way; only its message comes back
// here, so the check-in itself still runs with the page's own auth. Closing the page ends the worker, and with it the
// check-ins, which is the point of the deadman.
export function backgroundTick(ms: number, tick: () => void): () => void {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.onmessage = () => tick();
    return () => { worker.terminate(); URL.revokeObjectURL(url); };
  } catch {
    const t = setInterval(tick, ms);        // no Worker here: a plain timer still works while the tab is visible
    return () => clearInterval(t);
  }
}

/** Ask the browser not to freeze this tab while a task runs (a tab holding a Web Lock is exempt). Returns the release. */
export function holdAwake(name: string): () => void {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  try { void navigator.locks?.request(name, () => held); } catch { /* best effort */ }
  return release;
}
