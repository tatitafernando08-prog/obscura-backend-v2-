// Test fixture only: a worker that never posts a message and never exits --
// used by run-worker.spec.ts to prove a stuck worker is rejected via timeout
// instead of hanging the caller forever.
setInterval(() => undefined, 1000);
