import { MoldeskError } from "../errors.js";
import { VERSION } from "../version.js";
import type { SourceEndpoint } from "./sources.js";

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface GuardedResponse {
  bytes: Uint8Array;
  headers: Headers;
  url: string;
}

export interface GuardedGetOptions {
  endpoint: SourceEndpoint;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

function fail(code: string, message: string, remediation: string): MoldeskError {
  return new MoldeskError({ code, message, remediation });
}

/** `url` must be on the endpoint's scheme and exact host. */
export function assertAllowed(url: URL, endpoint: SourceEndpoint): void {
  if (url.protocol !== `${endpoint.scheme}:` || url.host !== endpoint.host || url.username !== "" || url.password !== "") {
    throw fail("FETCH_HOST_REFUSED", `Refusing to contact ${url.protocol}//${url.host}: only ${endpoint.scheme}://${endpoint.host} is allowed.`, "Nothing was downloaded.");
  }
}

/**
 * One GET with every guard: allowlisted host, redirects only within that host (a few hops), a size cap that
 * applies to the decompressed stream, a timeout and cancellation. Never sends credentials or cookies.
 */
export async function guardedGet(rawUrl: string, options: GuardedGetOptions): Promise<GuardedResponse> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  let url = new URL(rawUrl);
  try {
    for (let hop = 0; ; hop++) {
      assertAllowed(url, options.endpoint);
      const response = await doFetch(url, {
        redirect: "manual",
        credentials: "omit",
        signal,
        headers: { "user-agent": `moldesk/${VERSION}`, accept: "*/*" },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || hop >= MAX_REDIRECTS) throw fail("FETCH_REDIRECT_REFUSED", "The server sent too many redirects or none with a target.", "Nothing was downloaded.");
        const next = new URL(location, url);
        if (next.host !== options.endpoint.host) {
          throw fail("FETCH_REDIRECT_REFUSED", `Refusing a redirect to another host (${next.host}).`, "Nothing was downloaded.");
        }
        url = next;
        continue;
      }
      if (response.status === 404) {
        await response.body?.cancel();
        throw fail("FETCH_NOT_FOUND", `${url.host} has no such entry (HTTP 404).`, "Check the id; there is no search, so find it first.");
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw fail("FETCH_HTTP_ERROR", `${url.host} answered HTTP ${response.status}.`, "Try again later.");
      }
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > options.maxBytes) {
        await response.body.cancel();
        throw fail("FETCH_TOO_LARGE", `The response is ${declared} bytes; the limit is ${options.maxBytes}.`, "Nothing was saved.");
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > options.maxBytes) {
          await reader.cancel();
          throw fail("FETCH_TOO_LARGE", `The response is larger than the ${options.maxBytes}-byte limit.`, "Nothing was saved.");
        }
        chunks.push(value);
      }
      return { bytes: Buffer.concat(chunks), headers: response.headers, url: url.href };
    }
  } catch (error) {
    if (error instanceof MoldeskError) throw error;
    if (options.signal?.aborted) throw fail("FETCH_CANCELLED", "Cancelled.", "Run the command again.");
    if (signal.aborted) throw fail("FETCH_TIMEOUT", `The request timed out after ${options.timeoutMs / 1000} s.`, "Try again later.");
    throw fail("FETCH_NETWORK_ERROR", `Could not reach ${url.host}: ${error instanceof Error ? error.message : String(error)}.`, "Check your network connection and try again.");
  }
}
