import { createHash } from 'node:crypto';

const PRODUCT = 'llu.android';
const VERSION = '4.16.0'; // Abbott rejects older clients: 403 status 920, minimumVersion

type Ticket = { token: string; expires: number };

let session: { host: string; ticket: Ticket; accountId: string } | null = null;

function headers(extra: Record<string, string> = {}) {
  return {
    'product': PRODUCT,
    'version': VERSION,
    'accept': 'application/json',
    'content-type': 'application/json',
    'cache-control': 'no-cache',
    'user-agent': 'Mozilla/5.0',
    ...extra,
  };
}

// Abbott throttles hard and answers 429/430 for minutes afterwards. Hammering
// through it only extends the ban, so one refusal parks every call site.
const THROTTLED = new Set([429, 430]);
const DEFAULT_COOLDOWN = 5 * 60_000;
let cooldownUntil = 0;

const cooldownLeft = () => Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));

async function call(host: string, path: string, init: RequestInit = {}) {
  if (cooldownLeft()) throw new Error(`Rate-limited by LibreLinkUp. Retrying in ${cooldownLeft()}s.`);

  const res = await fetch(`https://${host}.libreview.io${path}`, init);
  if (THROTTLED.has(res.status)) {
    const retryAfter = Number(res.headers.get('retry-after'));
    cooldownUntil = Date.now() + (retryAfter > 0 ? retryAfter * 1000 : DEFAULT_COOLDOWN);
    throw new Error(`Rate-limited by LibreLinkUp. Retrying in ${cooldownLeft()}s.`);
  }
  if (!res.ok) throw new Error(`LibreLinkUp ${path} -> HTTP ${res.status}`);
  return res.json() as Promise<any>;
}

async function login(host: string, email: string, password: string): Promise<typeof session> {
  const body = JSON.stringify({ email, password });
  const json = await call(host, '/llu/auth/login', { method: 'POST', headers: headers(), body });

  // Wrong region: Abbott tells us where to go instead.
  if (json?.data?.redirect && json?.data?.region) {
    return login(`api-${json.data.region}`, email, password);
  }
  const ticket: Ticket | undefined = json?.data?.authTicket;
  const userId: string | undefined = json?.data?.user?.id;
  if (!ticket?.token || !userId) {
    throw new Error(`Login failed (status ${json?.status}). Check LIBRE_EMAIL / LIBRE_PASSWORD.`);
  }
  return { host, ticket, accountId: createHash('sha256').update(userId).digest('hex') };
}

let envLoaded = false;

// Secrets have to be read at runtime: import.meta.env is substituted at build
// time, so `astro build` bakes whatever .env held right then into dist/.
function env(key: string): string | undefined {
  if (!envLoaded) {
    envLoaded = true;
    try { process.loadEnvFile(); } catch { /* no .env: use the real environment */ }
  }
  return process.env[key];
}

async function getSession() {
  const email = env('LIBRE_EMAIL');
  const password = env('LIBRE_PASSWORD');
  if (!email || !password) throw new Error('Set LIBRE_EMAIL and LIBRE_PASSWORD in .env');

  // authTicket.expires is a unix timestamp in seconds.
  if (session && session.ticket.expires * 1000 > Date.now() + 60_000) return session;
  session = await login(env('LIBRE_REGION') || 'api-eu', email, password);
  return session!;
}

function auth(s: NonNullable<typeof session>) {
  return headers({
    'authorization': `Bearer ${s.ticket.token}`,
    'account-id': s.accountId,
  });
}

export type Reading = { value: number; timestamp: string };
export type Snapshot = {
  patient: string;
  units: 'mmol/L' | 'mg/dL';
  current: Reading & { trend: string; isHigh: boolean; isLow: boolean };
  target: { low: number; high: number };
  history: Reading[];
};

const TRENDS = ['', 'Falling fast', 'Falling', 'Steady', 'Rising', 'Rising fast'];

// Abbott returns both units on every measurement; pick the one we want.
const pick = (m: any, mmol: boolean) => (mmol ? Number(m.Value) : Number(m.ValueInMgPerDl));

// FactoryTimestamp is UTC but carries no zone marker ("8/20/2026 10:15:00 AM").
const toIso = (t: string) => new Date(`${t} UTC`).toISOString();

// The sensor reports once a minute, so anything fresher than this would be the
// same numbers at Abbott's expense. Shared by the page render and /api/glucose.
const MAX_AGE = 55_000;
let cache: { snap: Snapshot; at: number } | null = null;

// Whom we follow changes about never; caching it halves our request rate.
let patientId: string | null = null;
let fallbackConn: any = null;

async function getPatient(s: NonNullable<typeof session>) {
  if (patientId) return patientId;
  const conns = await call(s.host, '/llu/connections', { headers: auth(s) });
  const conn = conns?.data?.[0];
  if (!conn) throw new Error('No connections. Accept a sharing invite in the LibreLinkUp app first.');
  fallbackConn = conn;
  patientId = conn.patientId as string;
  return patientId;
}

export async function getSnapshot(): Promise<Snapshot> {
  if (cache && Date.now() - cache.at < MAX_AGE) return cache.snap;
  try {
    const snap = await fetchSnapshot();
    cache = { snap, at: Date.now() };
    return snap;
  } catch (err) {
    // A stale reading beats an error page — but only while it is worth showing.
    if (cache && Date.now() - cache.at < 15 * 60_000) return cache.snap;
    throw err;
  }
}

async function fetchSnapshot(): Promise<Snapshot> {
  const s = await getSession();
  const id = await getPatient(s);

  const graph = await call(s.host, `/llu/connections/${id}/graph`, { headers: auth(s) });
  const c = graph?.data?.connection ?? fallbackConn;
  if (!c) throw new Error('LibreLinkUp returned no connection data.');
  const history: any[] = graph?.data?.graphData ?? [];
  // glucoseMeasurement is null between sensor syncs; the graph's last point is
  // then the most recent reading we have. It carries no TrendArrow.
  const m = c.glucoseMeasurement ?? history[history.length - 1];
  if (!m) throw new Error('No recent readings. Is the sensor connected and syncing?');
  const mmol = (env('LIBRE_UNITS') ?? 'mmol').toLowerCase().startsWith('mmol');

  return {
    patient: [c.firstName, c.lastName].filter(Boolean).join(' ') || 'You',
    units: mmol ? 'mmol/L' : 'mg/dL',
    current: {
      value: pick(m, mmol),
      timestamp: toIso(m.FactoryTimestamp),
      trend: TRENDS[m.TrendArrow] ?? 'Unknown',
      isHigh: m.isHigh || m.MeasurementColor >= 3,
      isLow: m.isLow,
    },
    target: {
      low: mmol ? c.targetLow / 18 : c.targetLow,
      high: mmol ? c.targetHigh / 18 : c.targetHigh,
    },
    history: history.map((g: any) => ({
      value: pick(g, mmol),
      timestamp: toIso(g.FactoryTimestamp),
    })),
  };
}
