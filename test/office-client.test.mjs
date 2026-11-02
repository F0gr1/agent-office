import test from 'node:test';
import assert from 'node:assert/strict';
import { localOrigin, ensureOffice, readOffice, submitToOffice } from '../lib/office-client.mjs';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
test('project setup rejects an older backend before posting a request', async () => {
  let calls = 0;
  await assert.rejects(
    submitToOffice(localOrigin(), { kind: 'project-setup' }, async () => {
      calls++;
      return response({ capabilities: { automaticDispatch: true } });
    }),
    /更新して再起動/,
  );
  assert.equal(calls, 1);
});
test('client validates port and rejects incompatible servers', async () => {
  for (const port of [0, -1, 65536, NaN]) assert.throws(() => localOrigin(port));
  await assert.rejects(
    readOffice(localOrigin(), async () => response({ capabilities: {} })),
    /再起動/,
  );
});
test('client launches only when absent and waits for readiness', async () => {
  let calls = 0,
    launches = 0;
  const origin = await ensureOffice(4317, {
    fetcher: async () => {
      if (!calls++) throw Error('offline');
      return response({ capabilities: { automaticDispatch: true } });
    },
    launch: async () => launches++,
    wait: async () => {},
  });
  assert.equal(origin, localOrigin());
  assert.equal(launches, 1);
  launches = 0;
  await ensureOffice(4317, {
    fetcher: async () => response({ capabilities: { automaticDispatch: true } }),
    launch: async () => launches++,
  });
  assert.equal(launches, 0);
});
test('client posts automatic request with local token and links exact run', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/state')) return response({ capabilities: { automaticDispatch: true } });
    if (url.endsWith('/session')) return response({ token: 'secret-local-token' });
    return response({ id: 'aa-bb' }, 202);
  };
  const result = await submitToOffice(
    localOrigin(),
    { instruction: '依頼', workspace: '/project' },
    fetcher,
  );
  assert.equal(calls[2].options.headers['X-Office-Token'], 'secret-local-token');
  assert.equal(JSON.parse(calls[2].options.body).specialists, undefined);
  assert.deepEqual(result, { id: 'aa-bb', url: 'http://127.0.0.1:4317/?run=aa-bb' });
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('client surfaces busy/error response without retrying submission', async () => {
  let posts = 0;
  await assert.rejects(
    submitToOffice(localOrigin(), {}, async (url) => {
      if (url.endsWith('/state')) return response({ capabilities: { automaticDispatch: true } });
      if (url.endsWith('/session')) return response({ token: 'secret' });
      posts++;
      return response({ error: '実行中です' }, 409);
    }),
    /実行中/,
  );
  assert.equal(posts, 1);
});
