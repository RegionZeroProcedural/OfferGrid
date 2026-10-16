import { parentPort } from "worker_threads";
import {
  prepareCatalogSearchRecords,
  runCatalogSearch,
  runNearestCatalogSearch,
} from "../services/catalogSearchCore.js";

let records = [];
let revision = -1;

parentPort.on("message", message => {
  const { requestId, type, payload } = message || {};

  try {
    if (type === "index") {
      // Product-side tokenization happens in this worker, never on the Node
      // request thread. The prepared lexical representation is reused for all
      // searches until the next catalog revision replaces this worker.
      records = prepareCatalogSearchRecords(
        Array.isArray(payload.records) ? payload.records : []
      );
      revision = Number(payload.revision || 0);
      parentPort.postMessage({
        requestId,
        ok: true,
        result: { revision, records: records.length },
      });
      return;
    }

    if (type === "search") {
      parentPort.postMessage({
        requestId,
        ok: true,
        result: runCatalogSearch(records, payload || {}),
      });
      return;
    }

    if (type === "nearest") {
      parentPort.postMessage({
        requestId,
        ok: true,
        result: runNearestCatalogSearch(records, payload || {}),
      });
      return;
    }

    throw new Error(`Unknown worker task: ${type}`);
  } catch (error) {
    parentPort.postMessage({
      requestId,
      ok: false,
      error: String(error?.message || error),
    });
  }
});
