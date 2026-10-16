const startedAt = Date.now();

console.log("[startup-bootstrap] OfferGrid launcher active · loading application modules");

try {
  await import("./server.js");
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[startup-bootstrap] application startup module completed in ${elapsedSeconds}s`);
} catch (error) {
  console.error("[startup-bootstrap] FATAL: OfferGrid failed during startup");
  console.error(error);
  process.exitCode = 1;
}
