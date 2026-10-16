import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { parentPort, workerData } from "node:worker_threads";

const dataDir = path.resolve(String(workerData?.dataDir || "."));

async function writeSnapshot(job) {
  const startedAt = Date.now();
  const payload = Buffer.from(job.payload);
  const deserializeStartedAt = Date.now();
  const data = v8.deserialize(payload);
  const deserializeDurationMs = Date.now() - deserializeStartedAt;

  const serializeStartedAt = Date.now();
  const serialized = JSON.stringify(data, null, job.pretty ? 2 : 0);
  const serializeDurationMs = Date.now() - serializeStartedAt;

  await fs.promises.mkdir(dataDir, { recursive: true });
  const tempPath = path.join(
    dataDir,
    `catalog.runtime-${process.pid}-${Number(job.id)}-${Date.now()}.tmp`
  );

  const writeStartedAt = Date.now();
  await fs.promises.writeFile(tempPath, serialized, {
    encoding: "utf8",
    mode: 0o600,
  });

  if (job.fsync) {
    const handle = await fs.promises.open(tempPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  const writeDurationMs = Date.now() - writeStartedAt;
  return {
    id: Number(job.id),
    ok: true,
    tempPath,
    bytes: Buffer.byteLength(serialized, "utf8"),
    deserializeDurationMs,
    serializeDurationMs,
    writeDurationMs,
    durationMs: Date.now() - startedAt,
  };
}

let chain = Promise.resolve();
parentPort.on("message", job => {
  chain = chain
    .then(() => writeSnapshot(job))
    .then(result => parentPort.postMessage(result))
    .catch(error => {
      parentPort.postMessage({
        id: Number(job?.id || 0),
        ok: false,
        error: String(error?.stack || error?.message || error),
      });
    });
});
