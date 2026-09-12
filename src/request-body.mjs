import * as zlib from "node:zlib";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fail } from "./errors.mjs";

export function parseJSON(raw) {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw fail("invalid_json", 400);
  }
}

// Read from a wrapper so a decoder failure does not destroy the HTTP socket
// before the client receives the structured error response.
export async function readRequestBody(req, { limit, signal, stats = {} }) {
  const encoding = (req.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  const decoders = {
    gzip: zlib.createGunzip,
    deflate: zlib.createInflate,
    zstd: zlib.createZstdDecompress,
  };
  stats.encoding = Object.hasOwn(decoders, encoding) || encoding === "identity"
    ? encoding : "unsupported";
  stats.wire_bytes = 0;
  stats.decoded_bytes = 0;
  if (encoding !== "identity" && !Object.hasOwn(decoders, encoding))
    throw fail("unsupported_content_encoding", 415);
  if (encoding !== "identity" && !decoders[encoding])
    throw fail("content_decoder_unavailable", 503);
  const chunks = [];
  const meter = new Transform({
    transform(chunk, _, callback) {
      stats.wire_bytes += chunk.length;
      callback(stats.wire_bytes > limit ? fail("request_too_large", 413) : null, chunk);
    },
  });
  const sink = new Writable({
    write(chunk, _, callback) {
      stats.decoded_bytes += chunk.length;
      if (stats.decoded_bytes > limit) return callback(fail("request_too_large", 413));
      chunks.push(chunk);
      callback();
    },
  });
  try {
    await pipeline(
      Readable.from(req.iterator({ destroyOnReturn: false })),
      meter,
      ...(encoding === "identity" ? [] : [decoders[encoding]()]),
      sink,
      { signal },
    );
  } catch (error) {
    if (error.type) throw error;
    if (signal?.aborted || req.aborted) throw fail("cancelled", 499);
    throw fail(encoding === "identity" ? "request_read_failed" : "invalid_compressed_body", 400);
  }
  return parseJSON(Buffer.concat(chunks));
}
