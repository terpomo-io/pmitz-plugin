// Sign-in with GitHub for the hosted MCP server.
//
// When GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set, an assistant must sign its user in before it can use
// /mcp. The gateway is then an OAuth 2.1 authorization server for MCP clients, as the MCP authorization
// specification asks (metadata, dynamic client registration, authorization code with PKCE, refresh tokens),
// and hands the sign-in itself to GitHub. It asks GitHub for no permission: it reads the public profile
// (login, name, company) and does not keep GitHub's token.
//
//   GET  /.well-known/oauth-protected-resource     which authorization server protects /mcp
//   GET  /.well-known/oauth-authorization-server   where its endpoints are
//   POST /register                                 an assistant registers itself
//   GET  /authorize                                asks the user to confirm which assistant is connecting
//   POST /authorize/continue                       the user confirmed; goes to GitHub
//   GET  /oauth/github/callback                    GitHub comes back; goes back to the assistant with a code
//   POST /token                                    the assistant exchanges the code, or a refresh token
//
// The confirmation page is not decoration. GitHub asks a user to approve this service only once, so without
// it a hostile client could register its own return address, send a signed-in user straight to GitHub and
// receive a code for them. A sign-in is completed only in the browser that confirmed it: that browser holds
// the `__session` cookie (the one cookie Firebase Hosting passes on), which a cross-site request cannot send.

import { createHash } from 'node:crypto';

const TIMES = { pendingSeconds: 600, codeSeconds: 60, accessSeconds: 24 * 3600, refreshSeconds: 90 * 24 * 3600 };
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const REFUSED_SCHEMES = ['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'];

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

// A return address an assistant may register: https, http on this machine, or an application's own scheme.
function acceptableRedirect(uri) {
	try {
		const url = new URL(uri);
		if (url.hash || uri.length > 500) {
			return false;
		}
		if (url.protocol === 'http:') {
			return LOOPBACK.includes(url.hostname);
		}
		return url.protocol === 'https:' || !REFUSED_SCHEMES.includes(url.protocol);
	}
	catch {
		return false;
	}
}

// Exact match, except the port of an address on this machine, which a desktop assistant picks at run time.
function sameRedirect(registered, given) {
	if (registered === given) {
		return true;
	}
	try {
		const one = new URL(registered);
		const other = new URL(given);
		return one.protocol === 'http:' && other.protocol === 'http:' && LOOPBACK.includes(one.hostname)
			&& one.hostname === other.hostname && one.pathname === other.pathname && one.search === other.search;
	}
	catch {
		return false;
	}
}

export function createSignIn({ pool, settings, sha256, randomToken, allow, Refusal, logUsage, sendJson, readBody }) {
	const on = Boolean(settings.githubClientId && settings.githubClientSecret);
	const resource = `${settings.publicUrl}/mcp`;
	const callback = `${settings.publicUrl}/oauth/github/callback`;
	const secureCookie = settings.publicUrl.startsWith('https:') ? ' Secure;' : '';

	async function prepareStorage() {
		await pool.query(`
			CREATE TABLE IF NOT EXISTS gateway.account (
				github_id BIGINT PRIMARY KEY,
				login TEXT NOT NULL,
				name TEXT,
				company TEXT,
				first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
				last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE TABLE IF NOT EXISTS gateway.oauth_client (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				redirect_uris JSONB NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE TABLE IF NOT EXISTS gateway.oauth_grant (
				hash TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				client_id TEXT NOT NULL,
				github_id BIGINT,
				data JSONB NOT NULL DEFAULT '{}',
				expires_at TIMESTAMPTZ NOT NULL
			);
			ALTER TABLE gateway.sandbox ADD COLUMN IF NOT EXISTS owner_github_id BIGINT;
		`);
		setInterval(() => {
			pool.query('DELETE FROM gateway.oauth_grant WHERE expires_at <= now()')
				.catch((error) => console.error(`could not delete expired sign-in records: ${error.message}`));
		}, 3600 * 1000).unref();
	}

	// Sign-in records (a pending sign-in, a code, an access token, a refresh token) are stored by the hash
	// of their secret value, so the database never holds anything that can be presented.
	async function putGrant(kind, secret, clientId, githubId, data, seconds) {
		await pool.query(
			`INSERT INTO gateway.oauth_grant (hash, kind, client_id, github_id, data, expires_at)
			 VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
			[sha256(`${kind}:${secret}`), kind, clientId, githubId, JSON.stringify(data), seconds]);
	}

	async function readGrant(kind, secret) {
		const result = await pool.query(
			'SELECT client_id, github_id, data FROM gateway.oauth_grant WHERE hash = $1 AND kind = $2 AND expires_at > now()',
			[sha256(`${kind}:${String(secret ?? '')}`), kind]);
		return result.rows[0] ?? null;
	}

	// Reads a record and deletes it in one step, so it can be used once.
	async function takeGrant(kind, secret) {
		const result = await pool.query(
			'DELETE FROM gateway.oauth_grant WHERE hash = $1 AND kind = $2 AND expires_at > now() RETURNING client_id, github_id, data',
			[sha256(`${kind}:${String(secret ?? '')}`), kind]);
		return result.rows[0] ?? null;
	}

	async function clientOf(id) {
		const result = await pool.query('SELECT id, name, redirect_uris FROM gateway.oauth_client WHERE id = $1', [String(id ?? '')]);
		return result.rows[0] ?? null;
	}

	function cookieOf(request) {
		const match = /(?:^|;\s*)__session=([A-Za-z0-9]{40})(?:;|$)/.exec(String(request.headers.cookie ?? ''));
		return match ? match[1] : '';
	}

	function page(response, status, title, body, headers = {}) {
		response.writeHead(status, {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store, private',
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
			'X-Frame-Options': 'DENY',
			'Referrer-Policy': 'no-referrer',
			...headers,
		});
		response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1c1c1c}
button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:0;background:#1f6feb;color:#fff;cursor:pointer}
code{background:#f0f0f0;padding:.1rem .3rem;border-radius:.2rem}p.small{color:#555;font-size:.9rem}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`);
	}

	function metadata(response, value) {
		sendJson(response, 200, value, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' });
	}

	async function register(request, response, context) {
		if (!allow(`register:${context.address}`, 20, 3600 * 1000) || !allow('register:all', 2000, 3600 * 1000)) {
			throw new Refusal(429, 'Too many registrations. Try again in an hour.');
		}
		let body;
		try {
			body = JSON.parse(await readBody(request));
		}
		catch {
			body = null;
		}
		const uris = body?.redirect_uris;
		if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((uri) => typeof uri === 'string' && acceptableRedirect(uri))) {
			sendJson(response, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must list one to ten https, loopback http or application addresses.' });
			return;
		}
		const id = `pmc_${randomToken(24, TOKEN_ALPHABET)}`;
		const name = (typeof body.client_name === 'string' && body.client_name.trim()) ? body.client_name.trim().slice(0, 80) : 'An MCP client';
		await pool.query('INSERT INTO gateway.oauth_client (id, name, redirect_uris) VALUES ($1, $2, $3)', [id, name, JSON.stringify(uris)]);
		sendJson(response, 201, {
			client_id: id,
			client_name: name,
			redirect_uris: uris,
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		}, { 'Access-Control-Allow-Origin': '*' });
	}

	async function authorize(response, url) {
		const query = url.searchParams;
		const client = await clientOf(query.get('client_id'));
		const redirectUri = query.get('redirect_uri') ?? '';
		// Until the client and its return address are known to be genuine, errors are shown, not sent back.
		if (!client || !client.redirect_uris.some((registered) => sameRedirect(registered, redirectUri))) {
			page(response, 400, 'This sign-in link is not valid', '<p>The assistant that sent you here is not registered with this address. Start again from your assistant.</p>');
			return;
		}
		const back = (error, description) => {
			const target = new URL(redirectUri);
			target.searchParams.set('error', error);
			target.searchParams.set('error_description', description);
			if (query.get('state')) {
				target.searchParams.set('state', query.get('state'));
			}
			response.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
			response.end();
		};
		if (query.get('response_type') !== 'code') {
			back('unsupported_response_type', 'Only response_type=code is supported.');
			return;
		}
		const challenge = query.get('code_challenge') ?? '';
		if (query.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
			back('invalid_request', 'A code_challenge with the S256 method is required.');
			return;
		}
		if (query.get('resource') && query.get('resource').replace(/\/+$/, '') !== resource) {
			back('invalid_target', `This server issues tokens for ${resource} only.`);
			return;
		}
		const pending = randomToken(40, TOKEN_ALPHABET);
		const browser = randomToken(40, TOKEN_ALPHABET);
		await putGrant('pending', pending, client.id, null, {
			redirectUri, challenge, state: (query.get('state') ?? '').slice(0, 500), browser: sha256(browser), confirmed: false,
		}, TIMES.pendingSeconds);
		let returnsTo = redirectUri;
		try {
			returnsTo = new URL(redirectUri).protocol.startsWith('http') ? new URL(redirectUri).host : `${new URL(redirectUri).protocol}//`;
		}
		catch {
			// shown as given
		}
		page(response, 200, 'Connect to Pmitz sandboxes',
			`<p><strong>${escapeHtml(client.name)}</strong> wants to use Pmitz sandboxes for you. After you sign in, you go back to <code>${escapeHtml(returnsTo)}</code>.</p>
<p>Pmitz sandboxes are temporary Pmitz servers for development and testing, run by Terpomo Software.</p>
<form method="post" action="/authorize/continue"><input type="hidden" name="pending" value="${pending}">
<button type="submit">Continue with GitHub</button></form>
<p class="small">We read your public GitHub profile (username, name and company) to know who uses the service. We ask GitHub for no access to your repositories or your email. <a href="https://terpomosoft.com/privacy/">Privacy policy</a></p>
<p class="small">If you did not start this from your assistant, close this page.</p>`,
			{ 'Set-Cookie': `__session=${browser}; Path=/; Max-Age=${TIMES.pendingSeconds}; HttpOnly;${secureCookie} SameSite=Lax` });
	}

	// The pending sign-in of this browser, or null. The cookie is what ties the two together.
	async function pendingOf(request, pending) {
		const grant = await readGrant('pending', pending);
		const browser = cookieOf(request);
		return (grant && browser && grant.data.browser === sha256(browser)) ? grant : null;
	}

	async function proceed(request, response) {
		const origin = request.headers.origin;
		const form = new URLSearchParams(await readBody(request));
		const pending = form.get('pending') ?? '';
		const grant = (!origin || origin === new URL(settings.publicUrl).origin) ? await pendingOf(request, pending) : null;
		if (!grant) {
			page(response, 400, 'This sign-in has expired', '<p>Start again from your assistant.</p>');
			return;
		}
		await pool.query(`UPDATE gateway.oauth_grant SET data = data || '{"confirmed": true}' WHERE hash = $1`, [sha256(`pending:${pending}`)]);
		const target = new URL(`${settings.githubUrl}/login/oauth/authorize`);
		target.searchParams.set('client_id', settings.githubClientId);
		target.searchParams.set('redirect_uri', callback);
		target.searchParams.set('state', pending);
		response.writeHead(303, { Location: target.toString(), 'Cache-Control': 'no-store' });
		response.end();
	}

	async function githubProfile(code) {
		const exchange = await fetch(`${settings.githubUrl}/login/oauth/access_token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ client_id: settings.githubClientId, client_secret: settings.githubClientSecret, code, redirect_uri: callback }),
			signal: AbortSignal.timeout(10000),
		});
		const token = (await exchange.json()).access_token;
		if (!token) {
			return null;
		}
		const reply = await fetch(`${settings.githubApiUrl}/user`, {
			headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pmitz-sandbox' },
			signal: AbortSignal.timeout(10000),
		});
		const profile = reply.ok ? await reply.json() : null;
		return (profile && Number.isSafeInteger(profile.id) && typeof profile.login === 'string') ? profile : null;
	}

	async function comeBack(request, response, url, context) {
		const pending = url.searchParams.get('state') ?? '';
		const grant = await pendingOf(request, pending);
		if (!grant || grant.data.confirmed !== true) {
			page(response, 400, 'This sign-in has expired', '<p>Start again from your assistant.</p>');
			return;
		}
		await takeGrant('pending', pending);
		const target = new URL(grant.data.redirectUri);
		if (grant.data.state) {
			target.searchParams.set('state', grant.data.state);
		}
		const clear = { 'Set-Cookie': `__session=; Path=/; Max-Age=0; HttpOnly;${secureCookie} SameSite=Lax`, 'Cache-Control': 'no-store' };
		const profile = url.searchParams.get('code') ? await githubProfile(url.searchParams.get('code')).catch(() => null) : null;
		if (!profile) {
			target.searchParams.set('error', 'access_denied');
			target.searchParams.set('error_description', 'The GitHub sign-in was cancelled or did not succeed.');
			response.writeHead(302, { Location: target.toString(), ...clear });
			response.end();
			return;
		}
		const text = (value, length) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, length) : null);
		const account = { githubId: profile.id, login: profile.login.slice(0, 60), name: text(profile.name, 120), company: text(profile.company, 120) };
		const stored = await pool.query(
			`INSERT INTO gateway.account (github_id, login, name, company) VALUES ($1, $2, $3, $4)
			 ON CONFLICT (github_id) DO UPDATE SET login = $2, name = $3, company = $4, last_seen = now()
			 RETURNING (xmax = 0) AS is_new`,
			[account.githubId, account.login, account.name, account.company]);
		logUsage('signed_in', { ...context, user: account.login }, { userName: account.name, company: account.company, firstTime: stored.rows[0].is_new });
		const code = randomToken(40, TOKEN_ALPHABET);
		await putGrant('code', code, grant.client_id, account.githubId, { redirectUri: grant.data.redirectUri, challenge: grant.data.challenge }, TIMES.codeSeconds);
		target.searchParams.set('code', code);
		response.writeHead(302, { Location: target.toString(), ...clear });
		response.end();
	}

	async function issue(response, clientId, githubId) {
		const access = `pma_${randomToken(48, TOKEN_ALPHABET)}`;
		const refresh = `pmr_${randomToken(48, TOKEN_ALPHABET)}`;
		await putGrant('access', access, clientId, githubId, {}, TIMES.accessSeconds);
		await putGrant('refresh', refresh, clientId, githubId, {}, TIMES.refreshSeconds);
		sendJson(response, 200, { access_token: access, token_type: 'Bearer', expires_in: TIMES.accessSeconds, refresh_token: refresh },
			{ 'Access-Control-Allow-Origin': '*', Pragma: 'no-cache' });
	}

	async function token(request, response) {
		const form = new URLSearchParams(await readBody(request));
		const refuse = (error, description) => sendJson(response, 400, { error, error_description: description }, { 'Access-Control-Allow-Origin': '*' });
		const clientId = form.get('client_id') ?? '';
		if (form.get('grant_type') === 'authorization_code') {
			const grant = await takeGrant('code', form.get('code'));
			const verifier = form.get('code_verifier') ?? '';
			const proven = /^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
				&& createHash('sha256').update(verifier).digest('base64url') === grant?.data.challenge;
			if (!grant || grant.client_id !== clientId || grant.data.redirectUri !== form.get('redirect_uri') || !proven) {
				refuse('invalid_grant', 'The code is not valid, was already used, or does not match this client.');
				return;
			}
			await issue(response, grant.client_id, grant.github_id);
			return;
		}
		if (form.get('grant_type') === 'refresh_token') {
			const known = await readGrant('refresh', form.get('refresh_token'));
			if (!known || known.client_id !== clientId || !(await takeGrant('refresh', form.get('refresh_token')))) {
				refuse('invalid_grant', 'The refresh token is not valid or was already used.');
				return;
			}
			await issue(response, known.client_id, known.github_id);
			return;
		}
		refuse('unsupported_grant_type', 'Use authorization_code or refresh_token.');
	}

	// Answers the sign-in addresses. Returns false when the request is for something else.
	async function handle(request, response, url, context) {
		if (!on) {
			return false;
		}
		const path = url.pathname;
		const options = () => {
			response.writeHead(204, {
				'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Protocol-Version', 'Access-Control-Max-Age': '86400',
			});
			response.end();
		};
		if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
			request.method === 'OPTIONS' ? options() : metadata(response, {
				resource, authorization_servers: [settings.publicUrl], bearer_methods_supported: ['header'], resource_name: 'Pmitz sandbox',
			});
			return true;
		}
		if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp'
				|| path === '/.well-known/openid-configuration') {
			request.method === 'OPTIONS' ? options() : metadata(response, {
				issuer: settings.publicUrl,
				authorization_endpoint: `${settings.publicUrl}/authorize`,
				token_endpoint: `${settings.publicUrl}/token`,
				registration_endpoint: `${settings.publicUrl}/register`,
				response_types_supported: ['code'],
				grant_types_supported: ['authorization_code', 'refresh_token'],
				code_challenge_methods_supported: ['S256'],
				token_endpoint_auth_methods_supported: ['none'],
			});
			return true;
		}
		if (path === '/register' || path === '/token') {
			if (request.method === 'OPTIONS') {
				options();
			}
			else if (request.method !== 'POST') {
				sendJson(response, 405, { error: 'Use POST.' }, { Allow: 'POST, OPTIONS' });
			}
			else {
				await (path === '/register' ? register(request, response, context) : token(request, response));
			}
			return true;
		}
		if (path === '/authorize' && request.method === 'GET') {
			await authorize(response, url);
			return true;
		}
		if (path === '/authorize/continue' && request.method === 'POST') {
			await proceed(request, response);
			return true;
		}
		if (path === '/oauth/github/callback' && request.method === 'GET') {
			await comeBack(request, response, url, context);
			return true;
		}
		return false;
	}

	// The signed-in user of an MCP request, or null. With sign-in off, everyone is anonymous and allowed.
	async function userOf(request) {
		const match = /^Bearer (pma_[A-Za-z0-9]{48})$/.exec(String(request.headers.authorization ?? ''));
		const grant = match ? await readGrant('access', match[1]) : null;
		if (!grant) {
			return null;
		}
		const result = await pool.query('SELECT github_id, login, name, company FROM gateway.account WHERE github_id = $1', [grant.github_id]);
		return result.rows[0] ?? null;
	}

	function challenge(response, headers) {
		sendJson(response, 401, { error: 'Sign in to use Pmitz sandboxes.' }, {
			...headers,
			'WWW-Authenticate': `Bearer resource_metadata="${settings.publicUrl}/.well-known/oauth-protected-resource"`,
			'Access-Control-Expose-Headers': 'WWW-Authenticate',
		});
	}

	return { on, prepareStorage, handle, userOf, challenge };
}
