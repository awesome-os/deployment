import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import worker, {
  handleEdgeCasRequest,
  type EdgeCasDeps,
  type R2BucketLike,
} from './edge-cas-worker.mts';

const VALID_PREFIX = 'ab';
const VALID_SHA512 = 'a'.repeat(128);

describe('edge-cas-worker', () => {
  it('serves /healthz with ABI magic and v11 layout metadata', async () => {
    const res = await handleEdgeCasRequest(new Request('https://cdn.awesome-os.com/healthz'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-holo-cas-layout'), 'v11');
    const body = (await res.json()) as { ok: boolean; abiMagic: string; casLayout: string };
    assert.deepEqual(body, {
      ok: true,
      abiMagic: '0x33564742',
      casLayout: 'v11',
    });
  });

  it('serves /cas/v11/index.json and /cas/v11/shards/<aa>.json from R2 on hit and falls back to Pages CDN on miss', async () => {
    const r2Gets: string[] = [];
    const bucket: R2BucketLike = {
      async get(key) {
        r2Gets.push(key);
        if (key === 'cas/v11/index.json') {
          return {
            body: JSON.stringify({ schema: 'holo-v11-index', shards: ['ab'] }),
            httpMetadata: { contentType: 'application/json; charset=utf-8' },
            etag: '"r2-index-etag"',
          };
        }
        return null;
      },
    };

    const fetchedUrls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      fetchedUrls.push(String(input));
      return new Response(JSON.stringify({ shard: 'ab', blobs: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    };

    const deps: EdgeCasDeps = { bucket, fetchFn };

    const indexRes = await handleEdgeCasRequest(
      new Request('https://cdn.awesome-os.com/cas/v11/index.json'),
      deps,
    );
    assert.equal(indexRes.status, 200);
    assert.equal(indexRes.headers.get('x-holo-cas-source'), 'r2');
    assert.equal(indexRes.headers.get('x-holo-cas-layout'), 'v11');
    const indexJson = (await indexRes.json()) as { schema: string };
    assert.equal(indexJson.schema, 'holo-v11-index');

    const shardRes = await handleEdgeCasRequest(
      new Request('https://cdn.awesome-os.com/cas/v11/shards/ab.json'),
      deps,
    );
    assert.equal(shardRes.status, 200);
    assert.equal(shardRes.headers.get('x-holo-cas-source'), 'pages-cdn');
    assert.equal(shardRes.headers.get('x-holo-cas-layout'), 'v11');
    assert.deepEqual(r2Gets, ['cas/v11/index.json', 'cas/v11/shards/ab.json']);
    assert.deepEqual(fetchedUrls, [
      'https://awesome-os.github.io/holo-v11/cas/v11/shards/ab.json',
    ]);
  });

  it('serves /v11/files/<aa>/<sha512> with immutable cache headers on R2 hit and Pages CDN fallback', async () => {
    const payload = new Uint8Array([0x42, 0x47, 0x56, 0x33]);
    const bucket: R2BucketLike = {
      async get(key) {
        if (key === `v11/files/${VALID_PREFIX}/${VALID_SHA512}`) {
          return {
            body: payload,
            httpMetadata: { contentType: 'application/octet-stream' },
          };
        }
        return null;
      },
    };
    const fetchFn: typeof fetch = async () =>
      new Response('pages-blob', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });

    const r2Hit = await handleEdgeCasRequest(
      new Request(`https://cdn.awesome-os.com/v11/files/${VALID_PREFIX}/${VALID_SHA512}`),
      { bucket, fetchFn },
    );
    assert.equal(r2Hit.status, 200);
    assert.equal(r2Hit.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(r2Hit.headers.get('x-holo-cas-layout'), 'v11');
    assert.equal(r2Hit.headers.get('x-holo-cas-source'), 'r2');
    assert.deepEqual(new Uint8Array(await r2Hit.arrayBuffer()), payload);

    const otherHash = 'f'.repeat(128);
    const cdnFallback = await handleEdgeCasRequest(
      new Request(`https://cdn.awesome-os.com/v11/files/ff/${otherHash}`),
      { bucket, fetchFn },
    );
    assert.equal(cdnFallback.status, 200);
    assert.equal(cdnFallback.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(cdnFallback.headers.get('x-holo-cas-layout'), 'v11');
    assert.equal(cdnFallback.headers.get('x-holo-cas-source'), 'pages-cdn');
    assert.equal(await cdnFallback.text(), 'pages-blob');
  });

  it('rejects invalid shard prefixes and malformed SHA-512 hashes with HTTP 400', async () => {
    const badUrls = [
      `https://cdn.awesome-os.com/v11/files/zz/${VALID_SHA512}`,
      `https://cdn.awesome-os.com/v11/files/a/${VALID_SHA512}`,
      `https://cdn.awesome-os.com/v11/files/${VALID_PREFIX}/not-a-sha512`,
      `https://cdn.awesome-os.com/v11/files/${VALID_PREFIX}/${'A'.repeat(128)}`,
      'https://cdn.awesome-os.com/cas/v11/shards/zz.json',
    ];
    for (const url of badUrls) {
      const res = await handleEdgeCasRequest(new Request(url));
      assert.equal(res.status, 400, `expected 400 for ${url}`);
      assert.equal(res.headers.get('x-holo-cas-layout'), 'v11');
    }
  });

  it('supports worker.fetch entrypoint, HEAD requests, 404 unknown routes, and 405 non-GET methods', async () => {
    const headHealth = await worker.fetch(
      new Request('https://cdn.awesome-os.com/healthz', { method: 'HEAD' }),
    );
    assert.equal(headHealth.status, 200);
    assert.equal(await headHealth.text(), '');

    const notFound = await worker.fetch(new Request('https://cdn.awesome-os.com/unknown'));
    assert.equal(notFound.status, 404);

    const methodNotAllowed = await worker.fetch(
      new Request('https://cdn.awesome-os.com/healthz', { method: 'POST' }),
    );
    assert.equal(methodNotAllowed.status, 405);
    assert.equal(methodNotAllowed.headers.get('allow'), 'GET, HEAD');
  });
});
