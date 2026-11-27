/**
 * @file edge-cas-worker.mts
 * @description Cloudflare / Edge Worker serving the Holo v11 Static CAS over R2
 *   (`HOLO_CAS_BUCKET`) with zero-token GitHub Pages CDN fallback
 *   (`https://awesome-os.github.io/holo-v11/...`), eliminating unauthenticated
 *   60 req/hr GitHub REST API rate limits for clean-box installers.
 *
 * Strictly `erasableSyntaxOnly: true` & Web Standards `fetch()` APIs only.
 */

export interface R2ObjectLike {
  readonly body: ReadableStream<Uint8Array> | BodyInit | null;
  readonly httpMetadata?: {
    readonly contentType?: string;
  };
  readonly etag?: string;
  readonly size?: number;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
}

export interface EdgeCasEnv {
  readonly HOLO_CAS_BUCKET?: R2BucketLike;
  readonly PAGES_CDN_BASE?: string;
}

export interface EdgeCasDeps {
  readonly bucket?: R2BucketLike;
  readonly fetchFn?: typeof fetch;
  readonly pagesCdnBase?: string;
}

export const ABI_MAGIC = '0x33564742';
export const CAS_LAYOUT = 'v11';
export const DEFAULT_PAGES_CDN_BASE = 'https://awesome-os.github.io/holo-v11';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const INDEX_CACHE_CONTROL = 'public, max-age=300';

const SHARD_PREFIX_RE = /^[0-9a-f]{2}$/;
const SHA512_HEX_RE = /^[0-9a-f]{128}$/;
const CAS_SHARD_PATH_RE = /^\/cas\/v11\/shards\/([^/]+)\.json$/;
const CAS_FILE_PATH_RE = /^\/v11\/files\/([^/]+)\/([^/]+)$/;

function jsonResponse(
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-holo-cas-layout': CAS_LAYOUT,
      ...extraHeaders,
    },
  });
}

function buildSuccessHeaders(
  contentType: string,
  cacheControl: string,
  source: 'r2' | 'pages-cdn',
): Headers {
  const headers = new Headers();
  headers.set('content-type', contentType);
  headers.set('cache-control', cacheControl);
  headers.set('x-holo-cas-layout', CAS_LAYOUT);
  headers.set('x-holo-cas-source', source);
  return headers;
}

async function resolveWithFallback(
  key: string,
  options: {
    readonly method: string;
    readonly defaultContentType: string;
    readonly cacheControl: string;
    readonly deps: EdgeCasDeps;
  },
): Promise<Response> {
  const { bucket, fetchFn = fetch, pagesCdnBase = DEFAULT_PAGES_CDN_BASE } = options.deps;
  const isHead = options.method === 'HEAD';

  if (bucket) {
    const object = await bucket.get(key);
    if (object) {
      const contentType = object.httpMetadata?.contentType ?? options.defaultContentType;
      const headers = buildSuccessHeaders(contentType, options.cacheControl, 'r2');
      if (object.etag) headers.set('etag', object.etag);
      return new Response(isHead ? null : object.body, {
        status: 200,
        headers,
      });
    }
  }

  const base = pagesCdnBase.replace(/\/+$/, '');
  const cdnUrl = `${base}/${key}`;
  const upstream = await fetchFn(cdnUrl, {
    method: isHead ? 'HEAD' : 'GET',
    redirect: 'follow',
  });

  if (upstream.status === 404) {
    return jsonResponse(404, { ok: false, error: 'CAS object not found', key });
  }
  if (!upstream.ok) {
    return jsonResponse(502, {
      ok: false,
      error: 'Upstream Pages CDN error',
      status: upstream.status,
      key,
    });
  }

  const contentType = upstream.headers.get('content-type') ?? options.defaultContentType;
  const headers = buildSuccessHeaders(contentType, options.cacheControl, 'pages-cdn');
  return new Response(isHead ? null : upstream.body, {
    status: 200,
    headers,
  });
}

export async function handleEdgeCasRequest(
  request: Request,
  deps: EdgeCasDeps = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return jsonResponse(
      405,
      { ok: false, error: 'Method Not Allowed' },
      { allow: 'GET, HEAD' },
    );
  }

  const pathname = new URL(request.url).pathname;

  if (pathname === '/healthz') {
    const body =
      method === 'HEAD'
        ? null
        : JSON.stringify({
            ok: true,
            abiMagic: ABI_MAGIC,
            casLayout: CAS_LAYOUT,
          });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-holo-cas-layout': CAS_LAYOUT,
      },
    });
  }

  if (pathname === '/cas/v11/index.json') {
    return resolveWithFallback('cas/v11/index.json', {
      method,
      defaultContentType: 'application/json; charset=utf-8',
      cacheControl: INDEX_CACHE_CONTROL,
      deps,
    });
  }

  const shardMatch = CAS_SHARD_PATH_RE.exec(pathname);
  if (shardMatch) {
    const aa = shardMatch[1];
    if (!SHARD_PREFIX_RE.test(aa)) {
      return jsonResponse(400, {
        ok: false,
        error: 'Invalid CAS v11 shard prefix (expected 2 lowercase hex chars)',
      });
    }
    return resolveWithFallback(`cas/v11/shards/${aa}.json`, {
      method,
      defaultContentType: 'application/json; charset=utf-8',
      cacheControl: INDEX_CACHE_CONTROL,
      deps,
    });
  }

  const fileMatch = CAS_FILE_PATH_RE.exec(pathname);
  if (fileMatch) {
    const aa = fileMatch[1];
    const sha512 = fileMatch[2];
    if (!SHARD_PREFIX_RE.test(aa) || !SHA512_HEX_RE.test(sha512)) {
      return jsonResponse(400, {
        ok: false,
        error: 'Invalid CAS v11 shard prefix or SHA-512 digest',
      });
    }
    return resolveWithFallback(`v11/files/${aa}/${sha512}`, {
      method,
      defaultContentType: 'application/octet-stream',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      deps,
    });
  }

  return jsonResponse(404, { ok: false, error: 'Not Found', path: pathname });
}

const worker = {
  async fetch(request: Request, env: EdgeCasEnv = {}): Promise<Response> {
    return handleEdgeCasRequest(request, {
      bucket: env.HOLO_CAS_BUCKET,
      pagesCdnBase: env.PAGES_CDN_BASE ?? DEFAULT_PAGES_CDN_BASE,
    });
  },
};

export default worker;
