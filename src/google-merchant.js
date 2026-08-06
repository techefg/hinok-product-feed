import 'dotenv/config';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/content';
// This OAuth client is already registered for the localhost callback used by
// the existing Google Ads / GA4 authorization tooling.
const OAUTH_REDIRECT_URI = 'http://localhost:8080/';
const API_BASE = 'https://merchantapi.googleapis.com/datasources/v1';
const FEED_URL = 'https://techefg.github.io/hinok-product-feed/google-feed.csv';
const DISPLAY_NAME = 'Hinok Shopify Direct Feed';

function env(name, fallbackName) {
  const value = process.env[name] || (fallbackName ? process.env[fallbackName] : '');
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function oauthConfig() {
  return {
    clientId: env('GOOGLE_MERCHANT_CLIENT_ID', 'GOOGLE_ADS_CLIENT_ID'),
    clientSecret: env('GOOGLE_MERCHANT_CLIENT_SECRET', 'GOOGLE_ADS_CLIENT_SECRET'),
  };
}

function upsertLocalEnv(values) {
  const path = join(process.cwd(), '.env');
  let content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    content = pattern.test(content)
      ? content.replace(pattern, line)
      : `${content.trimEnd()}\n${line}\n`;
  }
  writeFileSync(path, content.replace(/^\n/, ''), { encoding: 'utf8', mode: 0o600 });
}

async function exchangeCode(code) {
  const { clientId, clientSecret } = oauthConfig();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`OAuth token exchange failed: ${body.error_description || body.error}`);
  if (!body.refresh_token) throw new Error('OAuth response did not include a refresh token. Re-run with consent.');
  return body.refresh_token;
}

async function authorize() {
  const { clientId, clientSecret } = oauthConfig();
  const state = randomBytes(24).toString('hex');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();

  console.log('Open this URL in a signed-in browser:');
  console.log(url.toString());
  console.log(`Waiting for OAuth callback on ${OAUTH_REDIRECT_URI}`);

  await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const callback = new URL(req.url, OAUTH_REDIRECT_URI);
        if (callback.pathname !== '/') {
          res.writeHead(404).end('Not found');
          return;
        }
        if (callback.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
        const authError = callback.searchParams.get('error');
        if (authError) throw new Error(`OAuth authorization failed: ${authError}`);
        const code = callback.searchParams.get('code');
        if (!code) throw new Error('OAuth callback did not include a code');

        const refreshToken = await exchangeCode(code);
        upsertLocalEnv({
          GOOGLE_MERCHANT_CLIENT_ID: clientId,
          GOOGLE_MERCHANT_CLIENT_SECRET: clientSecret,
          GOOGLE_MERCHANT_REFRESH_TOKEN: refreshToken,
          ...(process.env.GMC_MERCHANT_ID ? { GMC_MERCHANT_ID: process.env.GMC_MERCHANT_ID } : {}),
        });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Merchant Center authorization complete. You may close this window.');
        console.log('Authorization complete. Credentials saved to the gitignored local .env file.');
        server.close(resolve);
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Authorization failed: ${error.message}`);
        server.close(() => reject(error));
      }
    });
    server.listen(8080, 'localhost');
  });
}

async function accessToken() {
  const { clientId, clientSecret } = oauthConfig();
  const refreshToken = env('GOOGLE_MERCHANT_REFRESH_TOKEN');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`OAuth refresh failed: ${body.error_description || body.error}`);
  return body.access_token;
}

async function api(method, path, body) {
  const token = await accessToken();
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Merchant API ${method} ${path} failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

function accountId() {
  return env('GMC_MERCHANT_ID');
}

function dataSourceType(source) {
  return [
    'primaryProductDataSource',
    'supplementalProductDataSource',
    'localInventoryDataSource',
    'regionalInventoryDataSource',
    'promotionDataSource',
  ].find((key) => source[key]) || 'other';
}

async function listDataSources() {
  const data = await api('GET', `/accounts/${accountId()}/dataSources?pageSize=100`);
  const sources = data.dataSources || [];
  console.log(JSON.stringify(sources.map((source) => ({
    name: source.name,
    id: source.dataSourceId,
    displayName: source.displayName,
    input: source.input,
    type: dataSourceType(source),
    feedLabel: source.primaryProductDataSource?.feedLabel,
    contentLanguage: source.primaryProductDataSource?.contentLanguage,
    countries: source.primaryProductDataSource?.countries,
    fetchUri: source.fileInput?.fetchSettings?.fetchUri,
  })), null, 2));
}

function primaryFeedBody() {
  return {
    displayName: DISPLAY_NAME,
    primaryProductDataSource: {
      countries: ['US'],
      feedLabel: 'US',
      contentLanguage: 'en',
    },
    fileInput: {
      fetchSettings: {
        enabled: true,
        timeOfDay: { hours: 7 },
        timeZone: 'Etc/UTC',
        frequency: 'FREQUENCY_DAILY',
        fetchUri: FEED_URL,
      },
    },
  };
}

async function createDataSource(apply) {
  const body = primaryFeedBody();
  if (!apply) {
    console.log('Dry run. Re-run with --apply to create this data source:');
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const created = await api('POST', `/accounts/${accountId()}/dataSources`, body);
  console.log(JSON.stringify(created, null, 2));
  await api('POST', `/${created.name}:fetch`);
  console.log(`Immediate fetch triggered for ${created.name}`);
}

async function fetchDataSource(id) {
  await api('POST', `/accounts/${accountId()}/dataSources/${id}:fetch`);
  console.log(`Fetch triggered for data source ${id}`);
}

async function latestStatus(id) {
  const data = await api(
    'GET',
    `/accounts/${accountId()}/dataSources/${id}/fileUploads/latest`,
  );
  console.log(JSON.stringify(data, null, 2));
}

async function deleteDataSource(id, expectedName, apply) {
  const source = await api('GET', `/accounts/${accountId()}/dataSources/${id}`);
  if (!apply || !expectedName || source.displayName !== expectedName) {
    throw new Error(
      `Deletion refused. Re-run with --apply --name ${JSON.stringify(source.displayName)}`,
    );
  }
  await api('DELETE', `/accounts/${accountId()}/dataSources/${id}`);
  console.log(`Deleted data source ${id}: ${source.displayName}`);
}

async function main() {
  const [command, id] = process.argv.slice(2);
  const apply = process.argv.includes('--apply');
  const nameIndex = process.argv.indexOf('--name');
  const expectedName = nameIndex >= 0 ? process.argv[nameIndex + 1] : '';

  switch (command) {
    case 'auth': await authorize(); break;
    case 'list': await listDataSources(); break;
    case 'create': await createDataSource(apply); break;
    case 'fetch': await fetchDataSource(id); break;
    case 'status': await latestStatus(id); break;
    case 'delete': await deleteDataSource(id, expectedName, apply); break;
    default:
      console.log('Usage: node src/google-merchant.js <auth|list|create|fetch|status|delete> [id] [--apply] [--name NAME]');
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
