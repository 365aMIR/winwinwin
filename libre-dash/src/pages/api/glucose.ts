import type { APIRoute } from 'astro';
import { getSnapshot } from '../../lib/libre';

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    return new Response(JSON.stringify(await getSnapshot()), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
};
