// End-to-end test of the GitHub sign-in (sign-in.mjs). It starts its own gateway with sign-in switched on
// and a stand-in for GitHub, so it needs only the local stack of README.md:
//
//   docker compose up -d --wait
//   set -a; . ./.env; set +a
//   export DATABASE_URL="postgres://pmitz:${POSTGRES_PASSWORD}@127.0.0.1:15432/pmitz"
//   node test-sign-in.mjs

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';

const PORT = 18091;
const GITHUB_PORT = 18092;
const BASE = `http://127.0.0.1:${PORT}`;
const RETURN = 'http://127.0.0.1:33418/callback';

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
	condition ? (passed += 1) : (failed += 1);
	console.log(`  ${condition ? 'pass' : 'FAIL'}  ${name}${!condition && detail ? ' :: ' + String(detail).slice(0, 300) : ''}`);
}

// The stand-in for GitHub: one good code, one user.
const githubSaw = [];
const github = createServer((request, response) => {
	let body = '';
	request.on('data', (chunk) => { body += chunk; });
	request.on('end', () => {
		githubSaw.push(`${request.method} ${request.url}`);
		const send = (value) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
		if (request.url === '/login/oauth/access_token') {
			const sent = JSON.parse(body);
			send(sent.code === 'good-code' && sent.client_secret === 'test-secret' ? { access_token: 'gh-token' } : { error: 'bad_verification_code' });
		}
		else if (request.url === '/user' && request.headers.authorization === 'Bearer gh-token') {
			send({ id: 4242, login: 'octo-dev', name: 'Octo Dev', company: '@example-inc', email: 'hidden@example.com' });
		}
		else {
			response.writeHead(404);
			response.end();
		}
	});
}).listen(GITHUB_PORT, '127.0.0.1');

let log = '';
const gateway = spawn(process.execPath, ['server.mjs'], {
	env: {
		...process.env, PORT: String(PORT), PUBLIC_URL: BASE, PMITZ_INTERNAL_URL: process.env.PMITZ_INTERNAL_URL ?? 'http://127.0.0.1:18080',
		GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret',
		GITHUB_URL: `http://127.0.0.1:${GITHUB_PORT}`, GITHUB_API_URL: `http://127.0.0.1:${GITHUB_PORT}`,
	},
});
gateway.stdout.on('data', (chunk) => { log += chunk; });
gateway.stderr.on('data', (chunk) => { log += chunk; });
for (let waited = 0; waited < 100 && !log.includes('listening'); waited++) {
	await new Promise((resolve) => setTimeout(resolve, 100));
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const json = (response) => response.json().catch(() => null);
const post = (path, body, headers = {}) => fetch(BASE + path, { method: 'POST', redirect: 'manual', headers, body });
const form = (values) => new URLSearchParams(values).toString();
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const mcp = (token, method, params = {}) => fetch(`${BASE}/mcp`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
	body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
});

async function register(redirectUris, name = 'Test assistant') {
	return post('/register', JSON.stringify({ client_name: name, redirect_uris: redirectUris }), { 'Content-Type': 'application/json' });
}

// Opens the confirmation page the way a browser would and returns what the browser then holds.
async function openConfirmation(clientId, { redirectUri = RETURN, state = 'client-state' } = {}) {
	const verifier = randomBytes(40).toString('base64url');
	const query = form({
		response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state,
		code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${BASE}/mcp`,
	});
	const response = await fetch(`${BASE}/authorize?${query}`, { redirect: 'manual' });
	const text = await response.text();
	return {
		response, text, verifier,
		pending: /name="pending" value="([A-Za-z0-9]+)"/.exec(text)?.[1],
		cookie: /__session=[A-Za-z0-9]+/.exec(response.headers.get('set-cookie') ?? '')?.[0],
	};
}

// The whole sign-in, as a user who confirms. Returns the code the assistant receives.
async function signInFor(clientId, options) {
	const page = await openConfirmation(clientId, options);
	await post('/authorize/continue', form({ pending: page.pending }), { ...FORM, Cookie: page.cookie, Origin: BASE });
	const back = await fetch(`${BASE}/oauth/github/callback?code=good-code&state=${page.pending}`, { redirect: 'manual', headers: { Cookie: page.cookie } });
	const target = new URL(back.headers.get('location') ?? 'http://none/');
	return { ...page, back, code: target.searchParams.get('code'), returnedState: target.searchParams.get('state'), target };
}

const exchange = (clientId, code, verifier, redirectUri = RETURN) => post('/token',
	form({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri }), FORM);

console.log('1. Without sign-in, /mcp is closed and says where to sign in');
const closed = await mcp(null, 'initialize');
check('/mcp answers 401', closed.status === 401);
check('it names the protected-resource metadata', (closed.headers.get('www-authenticate') ?? '').includes(`${BASE}/.well-known/oauth-protected-resource`));
check('a made-up token is refused', (await mcp('pma_' + 'a'.repeat(48), 'initialize')).status === 401);
const resource = await json(await fetch(`${BASE}/.well-known/oauth-protected-resource`));
check('the resource metadata names /mcp and its authorization server', resource?.resource === `${BASE}/mcp` && resource.authorization_servers?.[0] === BASE);
const server = await json(await fetch(`${BASE}/.well-known/oauth-authorization-server`));
check('the server metadata lists its endpoints and requires PKCE',
	server?.authorization_endpoint === `${BASE}/authorize` && server.token_endpoint === `${BASE}/token`
	&& server.registration_endpoint === `${BASE}/register` && server.code_challenge_methods_supported?.[0] === 'S256');
check('the health check and the home page stay open', (await fetch(`${BASE}/health`)).status === 200 && (await fetch(`${BASE}/`)).status === 200);

console.log('2. Registration');
const registered = await json(await register([RETURN]));
const CLIENT = registered?.client_id;
check('an assistant can register a return address on this machine', /^pmc_/.test(CLIENT ?? ''));
check('a plain http address elsewhere is refused', (await register(['http://attacker.example/cb'])).status === 400);
check('a javascript: address is refused', (await register(['javascript:alert(1)'])).status === 400);
check('no return address is refused', (await register([])).status === 400);

console.log('3. Sign-in');
const done = await signInFor(CLIENT);
check('the confirmation page names the assistant and where the user goes back to', done.text.includes('Test assistant') && done.text.includes('127.0.0.1:33418'));
check('the page cannot be framed', done.response.headers.get('x-frame-options') === 'DENY');
check('after GitHub, the user goes back to the assistant with a code and its state',
	done.back.status === 302 && done.target.origin + done.target.pathname === RETURN && Boolean(done.code) && done.returnedState === 'client-state');
check('GitHub was asked for no permission', githubSaw.every((line) => !line.includes('scope')));
const tokens = await json(await exchange(CLIENT, done.code, done.verifier));
check('the code is exchanged for an access token and a refresh token', /^pma_/.test(tokens?.access_token ?? '') && /^pmr_/.test(tokens?.refresh_token ?? ''));
check('the code works once', (await exchange(CLIENT, done.code, done.verifier)).status === 400);

console.log('4. What a hostile client cannot do');
const attacker = (await json(await register(['https://attacker.example/cb'], 'Friendly helper'))).client_id;
const lure = await openConfirmation(attacker, { redirectUri: 'https://attacker.example/cb' });
const skipped = await fetch(`${BASE}/oauth/github/callback?code=good-code&state=${lure.pending}`, { redirect: 'manual', headers: { Cookie: lure.cookie } });
check('a sign-in the user did not confirm is not completed', skipped.status === 400 && !skipped.headers.get('location'));
const otherBrowser = await openConfirmation(attacker, { redirectUri: 'https://attacker.example/cb' });
const forged = await post('/authorize/continue', form({ pending: otherBrowser.pending }), FORM);
check('confirming needs the browser that opened the page', forged.status === 400);
const crossSite = await post('/authorize/continue', form({ pending: otherBrowser.pending }), { ...FORM, Cookie: otherBrowser.cookie, Origin: 'https://attacker.example' });
check('confirming from another site is refused', crossSite.status === 400);
const victim = await openConfirmation(CLIENT);
await post('/authorize/continue', form({ pending: victim.pending }), { ...FORM, Cookie: victim.cookie, Origin: BASE });
const stolen = await fetch(`${BASE}/oauth/github/callback?code=good-code&state=${victim.pending}`, { redirect: 'manual' });
check('GitHub\'s answer is accepted only in the browser that confirmed', stolen.status === 400);
const elsewhere = await fetch(`${BASE}/authorize?${form({ response_type: 'code', client_id: CLIENT, redirect_uri: 'https://attacker.example/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })}`, { redirect: 'manual' });
check('a return address that was not registered is refused without a redirect', elsewhere.status === 400 && !elsewhere.headers.get('location'));
const noProof = await fetch(`${BASE}/authorize?${form({ response_type: 'code', client_id: CLIENT, redirect_uri: RETURN })}`, { redirect: 'manual' });
check('a sign-in without PKCE is refused', noProof.status === 302 && (noProof.headers.get('location') ?? '').includes('error=invalid_request'));
const wrong = await signInFor(CLIENT);
check('a code is useless without its verifier', (await exchange(CLIENT, wrong.code, 'x'.repeat(50))).status === 400);
const another = await signInFor(CLIENT);
check('a code is useless to another client', (await exchange(attacker, another.code, another.verifier)).status === 400);
const failedAtGitHub = await openConfirmation(CLIENT);
await post('/authorize/continue', form({ pending: failedAtGitHub.pending }), { ...FORM, Cookie: failedAtGitHub.cookie, Origin: BASE });
const denied = await fetch(`${BASE}/oauth/github/callback?code=bad-code&state=${failedAtGitHub.pending}`, { redirect: 'manual', headers: { Cookie: failedAtGitHub.cookie } });
check('a failed GitHub sign-in goes back with an error and no code',
	(denied.headers.get('location') ?? '').includes('error=access_denied') && !(denied.headers.get('location') ?? '').includes('code='));
const otherPort = await signInFor(CLIENT, { redirectUri: 'http://127.0.0.1:50999/callback' });
check('a desktop assistant may come back on another port of this machine', otherPort.back.status === 302 && otherPort.target.port === '50999');

console.log('5. Signed in');
const hello = await json(await mcp(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sign-in-test', version: '1' } }));
check('/mcp opens with the access token', hello?.result?.serverInfo?.name === 'pmitz-sandbox');
const created = await json(await mcp(tokens.access_token, 'tools/call', { name: 'pmitz_create_sandbox', arguments: {} }));
const sandboxId = /pmz_([a-z0-9]{12})_/.exec(JSON.stringify(created))?.[1];
const owner = sandboxId ? (await db.query('SELECT owner_github_id FROM gateway.sandbox WHERE id = $1', [sandboxId])).rows[0]?.owner_github_id : null;
check('a sandbox is created and recorded under the user', String(owner) === '4242');
const account = (await db.query('SELECT login, name, company FROM gateway.account WHERE github_id = 4242')).rows[0];
check('the account holds the public profile', account?.login === 'octo-dev' && account.name === 'Octo Dev' && account.company === '@example-inc');
await new Promise((resolve) => setTimeout(resolve, 200));
const events = log.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line).usage).filter(Boolean);
check('the usage log names the user on every MCP event',
	events.filter((entry) => ['mcp_connect', 'tool_call', 'sandbox_created'].includes(entry.event)).every((entry) => entry.user === 'octo-dev'));
check('the connection is logged with the name and company', events.some((entry) => entry.event === 'mcp_connect' && entry.userName === 'Octo Dev' && entry.company === '@example-inc'));
check('each sign-in is logged', events.some((entry) => entry.event === 'signed_in' && entry.user === 'octo-dev' && entry.firstTime === true));
check('no token, code or email is logged', !log.includes(tokens.access_token) && !log.includes(tokens.refresh_token) && !log.includes('gh-token') && !log.includes('hidden@example.com'));
const stored = JSON.stringify((await db.query('SELECT * FROM gateway.oauth_grant')).rows);
check('the database holds no usable token', !stored.includes(tokens.access_token) && !stored.includes(tokens.refresh_token));

console.log('6. Refresh');
const refresh = (clientId, value) => post('/token', form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: value }), FORM);
check('a refresh token is useless to another client', (await refresh(attacker, tokens.refresh_token)).status === 400);
const renewed = await json(await refresh(CLIENT, tokens.refresh_token));
check('a refresh token gives new tokens', /^pma_/.test(renewed?.access_token ?? '') && renewed.access_token !== tokens.access_token);
check('the new access token works', (await mcp(renewed.access_token, 'ping')).status === 200);
check('a refresh token works once', (await refresh(CLIENT, tokens.refresh_token)).status === 400);

await db.query('DELETE FROM gateway.sandbox WHERE owner_github_id = 4242');
await db.query('DELETE FROM gateway.oauth_grant; DELETE FROM gateway.oauth_client; DELETE FROM gateway.account WHERE github_id = 4242');
await db.end();
gateway.kill();
github.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
