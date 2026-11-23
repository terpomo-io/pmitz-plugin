// End-to-end test of the optional GitHub sign-in (sign-in.mjs). It starts its own gateway with sign-in
// switched on and a stand-in for GitHub, so it needs only the local stack of README.md:
//
//   docker compose up -d --wait
//   set -a; . ./.env; set +a
//   export DATABASE_URL="postgres://pmitz:${POSTGRES_PASSWORD}@127.0.0.1:15432/pmitz"
//   node test-sign-in.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import pg from 'pg';

const PORT = 18091;
const GITHUB_PORT = 18092;
const BASE = `http://127.0.0.1:${PORT}`;
const GITHUB = `http://127.0.0.1:${GITHUB_PORT}`;

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
	condition ? (passed += 1) : (failed += 1);
	console.log(`  ${condition ? 'pass' : 'FAIL'}  ${name}${!condition && detail ? ' :: ' + String(detail).slice(0, 300) : ''}`);
}

// The stand-in for GitHub. Each sign-in gets its own code; the test decides what the user did with it.
const githubSaw = [];
const userDid = new Map();
let started = 0;
const github = createServer((request, response) => {
	let body = '';
	request.on('data', (chunk) => { body += chunk; });
	request.on('end', () => {
		githubSaw.push({ path: request.url, body });
		const send = (value) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
		if (request.url === '/login/device/code') {
			started += 1;
			send({ device_code: `device-${started}`, user_code: `CODE-${started}`, verification_uri: `${GITHUB}/login/device`, expires_in: 900, interval: 1 });
		}
		else if (request.url === '/login/oauth/access_token') {
			const did = userDid.get(JSON.parse(body).device_code);
			send(did === 'confirmed' ? { access_token: 'gh-token' } : { error: did === 'cancelled' ? 'access_denied' : 'authorization_pending' });
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
		GITHUB_CLIENT_ID: 'test-client', GITHUB_URL: GITHUB, GITHUB_API_URL: GITHUB,
	},
});
gateway.stdout.on('data', (chunk) => { log += chunk; });
gateway.stderr.on('data', (chunk) => { log += chunk; });
for (let waited = 0; waited < 100 && !log.includes('listening'); waited++) {
	await new Promise((resolve) => setTimeout(resolve, 100));
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function rpc(method, params = {}) {
	const response = await fetch(`${BASE}/mcp`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	return response.json();
}
async function call(name, args = {}) {
	const reply = await rpc('tools/call', { name, arguments: args });
	const text = reply.result?.content?.[0]?.text ?? '';
	try {
		return JSON.parse(text);
	}
	catch {
		return { ok: false, error: text };
	}
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 1100));
const row = async (key) => (await db.query(
	`SELECT owner_github_id, round(extract(epoch FROM expires_at - created_at) / 3600) AS hours FROM gateway.sandbox WHERE id = $1`, [key.split('_')[1]])).rows[0];

// Signs a new sandbox in as the stand-in user and returns the last answer.
async function keptSandbox() {
	const created = await call('pmitz_create_sandbox');
	await call('pmitz_keep_sandbox', { sandbox: created.sandbox });
	userDid.set(`device-${started}`, 'confirmed');
	await pause();
	return { key: created.sandbox, answer: await call('pmitz_keep_sandbox', { sandbox: created.sandbox }) };
}

console.log('1. Sign-in is optional');
const tools = (await rpc('tools/list')).result.tools;
check('the sign-in tool is listed', tools.some((tool) => tool.name === 'pmitz_keep_sandbox'));
const created = await call('pmitz_create_sandbox');
const KEY = created.sandbox;
check('a sandbox is created without signing in, and says how to keep it longer', /^pmz_/.test(KEY ?? '') && String(created.keepLonger).includes('pmitz_keep_sandbox'));
check('it works without signing in', (await call('pmitz_sandbox_status', { sandbox: KEY })).ok === true);
check('it lasts 72 hours', Number((await row(KEY)).hours) === 72);

console.log('2. Signing in');
const first = await call('pmitz_keep_sandbox', { sandbox: KEY });
check('the first call gives GitHub\'s address and a code to show the user',
	first.signedIn === false && first.address === `${GITHUB}/login/device` && first.code === 'CODE-1' && first.tellTheUser.includes('CODE-1'));
check('GitHub is asked for no permission and sent no secret', githubSaw.every((seen) => !seen.body.includes('scope') && !seen.body.includes('secret')));
const asked = githubSaw.length;
const tooSoon = await call('pmitz_keep_sandbox', { sandbox: KEY });
check('asked again at once, it repeats the same code without asking GitHub', tooSoon.signedIn === false && tooSoon.code === 'CODE-1' && githubSaw.length === asked);
await pause();
const notYet = await call('pmitz_keep_sandbox', { sandbox: KEY });
check('while the user has not entered the code, the sandbox is unchanged', notYet.signedIn === false && notYet.code === 'CODE-1' && Number((await row(KEY)).hours) === 72);
userDid.set('device-1', 'confirmed');
await pause();
const done = await call('pmitz_keep_sandbox', { sandbox: KEY });
check('once the user has entered the code, they are signed in', done.signedIn === true && done.signedInAs === 'octo-dev', JSON.stringify(done));
const kept = await row(KEY);
check('the sandbox is recorded under the user and kept 30 days', String(kept.owner_github_id) === '4242' && Number(kept.hours) === 720);
const account = (await db.query('SELECT login, name, company FROM gateway.account WHERE github_id = 4242')).rows[0];
check('the account holds the public profile', account?.login === 'octo-dev' && account.name === 'Octo Dev' && account.company === '@example-inc');
const again = await call('pmitz_keep_sandbox', { sandbox: KEY });
check('calling it again changes nothing', again.signedIn === true && again.signedInAs === 'octo-dev' && githubSaw.filter((seen) => seen.path === '/login/device/code').length === 1);
check('the status names the user', (await call('pmitz_sandbox_status', { sandbox: KEY })).signedInAs === 'octo-dev');

console.log('3. What does not sign anyone in');
check('a wrong sandbox key is refused', (await call('pmitz_keep_sandbox', { sandbox: 'pmz_aaaaaaaaaaaa_' + 'b'.repeat(32) })).ok === false);
const other = await call('pmitz_create_sandbox');
await call('pmitz_keep_sandbox', { sandbox: other.sandbox });
userDid.set(`device-${started}`, 'cancelled');
await pause();
const cancelled = await call('pmitz_keep_sandbox', { sandbox: other.sandbox });
const untouched = await row(other.sandbox);
check('a sign-in cancelled at GitHub leaves the sandbox as it was', cancelled.ok === false && untouched.owner_github_id === null && Number(untouched.hours) === 72);
for (let count = 0; count < 4; count++) {
	await keptSandbox();
}
const oneTooMany = await keptSandbox();
check('one account keeps at most five sandboxes', oneTooMany.answer.ok === false && (await row(oneTooMany.key)).owner_github_id === null, JSON.stringify(oneTooMany.answer));

console.log('4. The usage log');
await fetch(`${BASE}/sandbox/${KEY.split('_')[1]}/subscriptions/nobody`, { headers: { 'X-Api-Key': KEY } });
await new Promise((resolve) => setTimeout(resolve, 200));
const events = log.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line).usage).filter(Boolean);
const signedIn = events.find((entry) => entry.event === 'signed_in');
check('the sign-in is logged with the username, name, company and sandbox',
	signedIn?.user === 'octo-dev' && signedIn.userName === 'Octo Dev' && signedIn.company === '@example-inc' && signedIn.sandbox === KEY.split('_')[1] && signedIn.firstTime === true);
check('later tool calls on that sandbox name the user', events.some((entry) => entry.event === 'tool_call' && entry.tool === 'pmitz_sandbox_status' && entry.user === 'octo-dev'));
check('REST calls on that sandbox name the user', events.some((entry) => entry.event === 'rest_call' && entry.user === 'octo-dev'));
check('calls on a sandbox nobody signed in to name no user', events.some((entry) => entry.event === 'tool_call' && entry.user === undefined));
check('no GitHub token, device code or email is logged', !log.includes('gh-token') && !log.includes('device-1') && !log.includes('hidden@example.com'));

await db.query('DELETE FROM gateway.sandbox WHERE created_at > now() - interval \'10 minutes\'');
await db.query('DELETE FROM gateway.account WHERE github_id = 4242');
await db.end();
gateway.kill();
github.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
