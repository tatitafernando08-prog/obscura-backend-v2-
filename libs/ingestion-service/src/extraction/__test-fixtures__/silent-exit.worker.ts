// Test fixture only: simulates a worker that terminates (e.g. killed
// externally, or an internal `process.exit()`) without ever posting a
// message back — used by run-worker.spec.ts to prove the caller doesn't
// hang forever waiting on a message that will never arrive.
process.exit(0);
