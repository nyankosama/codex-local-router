import { spawn, execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { fail } from "./errors.mjs";
const children = new Set();
export function checkTransport() {
  execFileSync("curl", ["--version"], { stdio: "ignore" });
}
export function stopTransport() {
  for (const child of children) child.kill("SIGTERM");
}
export function request(
  url,
  { headers = {}, body, signal, timeoutMs = 180000 } = {},
) {
  if (signal?.aborted) return Promise.reject(fail("cancelled", 499));
  return new Promise((resolve, reject) => {
    const output = new PassThrough({ highWaterMark: 64 * 1024 });
    output.on("error", () => {});
    const child = spawn(
      "curl",
      [
        "--http1.1",
        "--silent",
        "--show-error",
        "--no-buffer",
        "--include",
        "--suppress-connect-headers",
        "--connect-timeout",
        String(Math.min(15000, timeoutMs) / 1000),
        "--max-time",
        String(timeoutMs / 1000),
        "--config",
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    children.add(child);
    let header = Buffer.alloc(0),
      started = false,
      settled = false,
      aborted = false;
    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    output.once("close", () => {
      if (!output.readableEnded) child.kill("SIGTERM");
    });
    const error = (e) => {
      output.destroy(e);
      if (!settled) {
        settled = true;
        reject(e);
      }
    };
    child.stdin.on("error", () => {});
    child.stderr.resume();
    child.stdin.end(
      `url = ${JSON.stringify(url)}\nrequest = "POST"\n${Object.entries(headers)
        .map(([k, v]) => `header = ${JSON.stringify(`${k}: ${v}`)}`)
        .join(
          "\n",
        )}\nheader = "Expect:"\ndata-binary = ${JSON.stringify(JSON.stringify(body))}\n`,
    );
    child.stdout.on("data", (chunk) => {
      if (!started) {
        header = Buffer.concat([header, chunk]);
        for (;;) {
          const end = header.indexOf("\r\n\r\n");
          if (end < 0) {
            if (header.length > 65536) {
              error(fail("invalid_upstream_headers", 502));
              child.kill();
            }
            return;
          }
          const raw = header.subarray(0, end).toString();
          header = header.subarray(end + 4);
          const status = Number(raw.match(/^HTTP\/\S+ (\d+)/)?.[1]);
          if (!status) {
            error(fail("invalid_upstream_headers", 502));
            child.kill();
            return;
          }
          if (status < 200) continue;
          const h = new Headers();
          for (const line of raw.split("\r\n").slice(1)) {
            const i = line.indexOf(":");
            if (i > 0) h.append(line.slice(0, i), line.slice(i + 1).trim());
          }
          started = true;
          settled = true;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: h,
            body: output,
          });
          chunk = header;
          header = Buffer.alloc(0);
          break;
        }
      }
      if (!output.write(chunk)) {
        child.stdout.pause();
        output.once("drain", () => child.stdout.resume());
      }
    });
    child.on("error", () => error(fail("transport_unavailable", 503)));
    child.on("close", (code) => {
      children.delete(child);
      signal?.removeEventListener("abort", abort);
      if (code !== 0)
        error(
          fail(
            aborted
              ? "cancelled"
              : code === 28
                ? "upstream_timeout"
                : "upstream_connection_error",
            aborted ? 499 : code === 28 ? 504 : 502,
          ),
        );
      else if (!started) error(fail("invalid_upstream_headers", 502));
      else output.end();
    });
  });
}
export async function readJSON(response) {
  let text = "";
  for await (const chunk of response.body) {
    text += chunk;
    if (Buffer.byteLength(text) > 20 * 1024 * 1024)
      throw fail("upstream_body_too_large", 502);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw fail("invalid_upstream_json", 502);
  }
}
