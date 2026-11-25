// Pmitz hosted MCP server.
//
// Gives an assistant a Pmitz sandbox, a temporary Pmitz server ("sandbox") with no account. Every sandbox
// is a private slice of one real Pmitz server that runs next to this process: the gateway prefixes the
// product, subscription and subject IDs of each sandbox, so sandboxes cannot see each other.
//
// Three ways in, all on the same data:
//   POST /mcp          MCP over Streamable HTTP, stateless, no sign-in. The Pmitz tools are the ones of
//                      the local MCP server (plugins/pmitz/server/pmitz-mcp.mjs), with a sandbox key.
//   /sandbox/<id>/...        The Pmitz REST API of one sandbox, for the developer's application.
//                      Authenticate with the sandbox key in the X-Api-Key header.
//   GET /              A short page that says what this is.
//
// Configuration (environment):
//   PMITZ_INTERNAL_URL   Base URL of the Pmitz server behind the gateway, for example http://127.0.0.1:8080
//   PMITZ_INTERNAL_KEY   API key of that server. Never leaves this process.
//   DATABASE_URL         PostgreSQL connection string, the same database the Pmitz server uses
//   PUBLIC_URL           Public base URL of this service, for example https://pmitz-mcp.web.app
//   OPENAI_APPS_CHALLENGE  Optional token served at /.well-known/openai-apps-challenge
//   PORT                 Port to listen on (default 8090)
//   SWEEP_SECONDS        Minimum time between two clean-ups of expired sandboxes (default 600)
//   GITHUB_CLIENT_ID     Optional. The client ID of a GitHub OAuth app with the device flow enabled. When set,
//                        a user can sign in with GitHub to keep a sandbox longer (see sign-in.mjs).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';

import { createSignIn } from './sign-in.mjs';
import { createToolset, ToolError, SERVER_VERSION, GROUP_TYPES } from '../plugins/pmitz/server/pmitz-mcp.mjs';

const settings = {
	pmitzUrl: (process.env.PMITZ_INTERNAL_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, ''),
	pmitzKey: process.env.PMITZ_INTERNAL_KEY ?? '',
	databaseUrl: process.env.DATABASE_URL ?? '',
	publicUrl: (process.env.PUBLIC_URL ?? 'http://127.0.0.1:8090').replace(/\/+$/, ''),
	challenge: (process.env.OPENAI_APPS_CHALLENGE ?? '').trim(),
	port: Number(process.env.PORT ?? 8090),
	sweepSeconds: Number(process.env.SWEEP_SECONDS ?? 600),
	githubClientId: (process.env.GITHUB_CLIENT_ID ?? '').trim(),
	// Where GitHub is. Only a test points these elsewhere.
	githubUrl: (process.env.GITHUB_URL ?? 'https://github.com').replace(/\/+$/, ''),
	githubApiUrl: (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, ''),
};

// Limits. A sandbox is for development and testing, so they are deliberately small.
const LIMITS = {
	lifetimeHours: 72,
	keptDays: 30,
	keptSandboxesPerAccount: 5,
	maxBodyBytes: 64 * 1024,
	maxIdLength: 120,
	maxProductsPerSandbox: 10,
	maxSubscriptionsPerSandbox: 500,
	maxActiveSandboxs: 5000,
	requestsPerSandboxPerMinute: 120,
	createsPerAddressPerHour: 30,
	createsPerHour: 300,
	requestsPerAddressPerMinute: 600,
};

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const REQUEST_TIMEOUT_MS = 15000;
const OPERATIONS = ['usage', 'limits-check', 'subscription-check'];

const pool = new pg.Pool({ connectionString: settings.databaseUrl, max: 5, idleTimeoutMillis: 30000 });

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

// A refusal the caller can act on. `status` is the HTTP status the REST surface answers with.
class Refusal extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

// ---------------------------------------------------------------------------------------------
// Usage log
// ---------------------------------------------------------------------------------------------

// One JSON line per event on standard output, which Cloud Run stores as a structured log entry. It records
// who called, with which assistant, what each call sent and what it was answered. The one thing it never
// holds is a sandbox key: a key is a password, so only the sandbox's identifier is kept.

// Which assistant a request comes from, read from the name it sends in its User-Agent.
function clientKind(userAgent) {
	const text = String(userAgent ?? '').toLowerCase();
	if (text.includes('claude')) {
		return 'Claude';
	}
	if (text.includes('codex')) {
		return 'Codex';
	}
	if (text.includes('openai') || text.includes('chatgpt')) {
		return 'ChatGPT';
	}
	const product = /^[a-z0-9._-]{1,40}/.exec(text);
	return product ? product[0] : 'unknown';
}

// Stands for one caller for one day: a keyed hash of the address and the date. It lets distinct callers be
// counted with one short value, and changes at midnight UTC.
function callerHash(address) {
	const day = new Date().toISOString().slice(0, 10);
	return createHmac('sha256', settings.pmitzKey).update(`${day}:${address}`).digest('hex').slice(0, 12);
}

// Why a call was refused, as one of a few fixed words. The text of a refusal can quote what the caller sent,
// so it is never logged.
const REFUSAL_REASONS = {
	400: 'invalid_request', 401: 'bad_sandbox_key', 404: 'not_found', 409: 'already_exists', 410: 'sandbox_expired',
	413: 'too_large', 422: 'sandbox_full', 429: 'rate_limited', 503: 'unavailable',
};

function refusalReason(status) {
	return REFUSAL_REASONS[status] ?? `http_${status}`;
}

// What a tool call led to, from the answer of the Pmitz server: its HTTP status, why it was refused, and the
// decision Pmitz took (allowed or denied for a feature, or the status of a limit). All are fixed words of
// Pmitz or of this gateway.
function resultSummary(value) {
	const summary = {};
	if (Number.isInteger(value?.httpStatus)) {
		summary.httpStatus = value.httpStatus;
	}
	if (value?.ok === false) {
		// From the Pmitz server, 422 means a limit would be exceeded. From this gateway it means the sandbox is full.
		summary.reason = value.httpStatus === 422 ? 'limit_exceeded'
			: Number.isInteger(value.httpStatus) ? refusalReason(value.httpStatus) : 'refused';
	}
	const result = value?.result;
	if (typeof result?.featureAllowed === 'boolean') {
		summary.decision = result.featureAllowed ? 'allowed' : 'denied';
	}
	else if (typeof result?.featureStatus === 'string' && /^[A-Z_]{1,40}$/.test(result.featureStatus)) {
		summary.decision = result.featureStatus;
	}
	return summary;
}

// What a call sent or was answered, made safe to log: the secret part of any sandbox key is removed, and a
// value too large for one log entry is cut and marked.
const LOGGED_CHARACTERS = 8000;

function forLog(value) {
	if (value === undefined) {
		return undefined;
	}
	const text = (JSON.stringify(value) ?? 'null').replace(/pmz_([a-z0-9]{12})_[A-Za-z0-9]{32}/g, 'pmz_$1_…');
	return text.length <= LOGGED_CHARACTERS ? JSON.parse(text) : { cutAt: LOGGED_CHARACTERS, text: text.slice(0, LOGGED_CHARACTERS) };
}

function logUsage(event, context, fields = {}) {
	console.log(JSON.stringify({
		severity: 'INFO',
		message: `usage ${event}`,
		usage: {
			event, client: context.client, caller: context.caller, via: context.via,
			address: context.address, network: context.network, country: context.country,
			...(context.user ? { user: context.user } : {}), ...fields,
		},
	}));
}

// ---------------------------------------------------------------------------------------------
// Rate limits (per process; the service runs as one instance)
// ---------------------------------------------------------------------------------------------

const windows = new Map();

function allow(bucket, limit, windowMs) {
	const now = Date.now();
	const entry = windows.get(bucket);
	if (!entry || now - entry.start >= windowMs) {
		windows.set(bucket, { start: now, count: 1 });
		return true;
	}
	entry.count += 1;
	return entry.count <= limit;
}

setInterval(() => {
	const cutoff = Date.now() - 3600 * 1000;
	for (const [bucket, entry] of windows) {
		if (entry.start < cutoff) {
			windows.delete(bucket);
		}
	}
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

async function prepareStorage() {
	await pool.query(`
		CREATE SCHEMA IF NOT EXISTS gateway;
		CREATE TABLE IF NOT EXISTS gateway.sandbox (
			id TEXT PRIMARY KEY,
			key_hash TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			expires_at TIMESTAMPTZ NOT NULL
		);
		CREATE TABLE IF NOT EXISTS gateway.product (
			sandbox_id TEXT NOT NULL REFERENCES gateway.sandbox(id) ON DELETE CASCADE,
			product_id TEXT NOT NULL,
			definition JSON NOT NULL,
			PRIMARY KEY (sandbox_id, product_id)
		);
		CREATE TABLE IF NOT EXISTS gateway.subscription (
			sandbox_id TEXT NOT NULL REFERENCES gateway.sandbox(id) ON DELETE CASCADE,
			subscription_id TEXT NOT NULL,
			PRIMARY KEY (sandbox_id, subscription_id)
		);
	`);
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

function randomToken(length, alphabet) {
	const bytes = randomBytes(length * 2);
	let token = '';
	for (let index = 0; token.length < length; index += 1) {
		const value = bytes[index % bytes.length];
		if (value < Math.floor(256 / alphabet.length) * alphabet.length) {
			token += alphabet[value % alphabet.length];
		}
		if (index > length * 40) {
			throw new Error('could not generate a token');
		}
	}
	return token;
}

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const MIXED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function prefixOf(sandboxId) {
	return `${sandboxId}--`;
}

async function createSandbox(address) {
	if (!allow(`create:${address}`, LIMITS.createsPerAddressPerHour, 3600 * 1000)
			|| !allow('create:all', LIMITS.createsPerHour, 3600 * 1000)) {
		throw new Refusal(429, 'Too many sandboxes were created recently. Try again in an hour.');
	}
	const active = await pool.query('SELECT count(*)::int AS n FROM gateway.sandbox WHERE expires_at > now()');
	if (active.rows[0].n >= LIMITS.maxActiveSandboxs) {
		throw new Refusal(503, 'The service is at capacity. Try again later.');
	}
	const id = randomToken(12, ID_ALPHABET);
	const secret = randomToken(32, MIXED_ALPHABET);
	const result = await pool.query(
		`INSERT INTO gateway.sandbox (id, key_hash, expires_at)
		 VALUES ($1, $2, now() + make_interval(hours => $3)) RETURNING expires_at`,
		[id, sha256(secret), LIMITS.lifetimeHours]);
	return { id, key: `pmz_${id}_${secret}`, expiresAt: result.rows[0].expires_at };
}

// Accepts the full key (pmz_<id>_<secret>) and returns the sandbox, or refuses.
async function authenticate(key, expectedId) {
	const match = /^pmz_([a-z0-9]{12})_([A-Za-z0-9]{32})$/.exec(typeof key === 'string' ? key.trim() : '');
	if (!match || (expectedId && match[1] !== expectedId)) {
		throw new Refusal(401, 'The sandbox key is missing or not valid. It looks like pmz_<id>_<secret> and is '
			+ 'returned once by pmitz_create_sandbox.');
	}
	const [, id, secret] = match;
	const result = await pool.query(
		`SELECT s.key_hash, s.expires_at, s.created_at, a.login FROM gateway.sandbox s
		 LEFT JOIN gateway.account a ON a.github_id = s.owner_github_id WHERE s.id = $1`, [id]);
	const row = result.rows[0];
	const given = Buffer.from(sha256(secret));
	if (!row || !timingSafeEqual(given, Buffer.from(row.key_hash))) {
		throw new Refusal(401, 'The sandbox key is not valid.');
	}
	if (row.expires_at.getTime() <= Date.now()) {
		throw new Refusal(410, 'This sandbox has expired and its data was deleted. Create a new one with '
			+ 'pmitz_create_sandbox.');
	}
	if (!allow(`sandbox:${id}`, LIMITS.requestsPerSandboxPerMinute, 60 * 1000)) {
		throw new Refusal(429, 'Too many requests for this sandbox. Wait a minute.');
	}
	return { id, prefix: prefixOf(id), expiresAt: row.expires_at, createdAt: row.created_at, user: row.login ?? null };
}

async function deleteSandboxData(sandboxId) {
	const prefix = prefixOf(sandboxId);
	const products = await pool.query('SELECT product_id FROM gateway.product WHERE sandbox_id = $1', [sandboxId]);
	for (const row of products.rows) {
		await callInternal('DELETE', '/products/' + encodeURIComponent(prefix + row.product_id)).catch(() => {});
	}
	await pool.query('DELETE FROM dbo.usage WHERE product_id LIKE $1', [prefix + '%']);
	await pool.query('DELETE FROM dbo.subscription WHERE subscription_id LIKE $1', [prefix + '%']);
	await pool.query('DELETE FROM gateway.sandbox WHERE id = $1', [sandboxId]);
	loaded.delete(sandboxId);
}

let lastSweep = 0;

// Deletes expired sandboxes. Runs in the background, at most every SWEEP_SECONDS (ten minutes).
function sweepExpired() {
	if (Date.now() - lastSweep < settings.sweepSeconds * 1000) {
		return;
	}
	lastSweep = Date.now();
	pool.query('SELECT id FROM gateway.sandbox WHERE expires_at <= now() LIMIT 200')
		.then(async (result) => {
			for (const row of result.rows) {
				await deleteSandboxData(row.id);
			}
		})
		.catch((error) => console.error(`sweep failed: ${error.message}`));
}

// ---------------------------------------------------------------------------------------------
// The Pmitz server behind the gateway
// ---------------------------------------------------------------------------------------------

async function callInternal(method, path, body) {
	const headers = { 'X-Api-Key': settings.pmitzKey };
	if (body !== undefined) {
		headers['Content-Type'] = 'application/json';
	}
	let response;
	try {
		response = await fetch(settings.pmitzUrl + path, {
			method,
			headers,
			body: (body === undefined) ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			redirect: 'error',
		});
	}
	catch {
		throw new Refusal(503, 'The Pmitz server behind this service did not answer. Try again in a moment.');
	}
	const text = await response.text();
	let parsed = null;
	if (text) {
		try {
			parsed = JSON.parse(text);
		}
		catch {
			parsed = text.slice(0, 2000);
		}
	}
	return { status: response.status, body: parsed };
}

// The Pmitz catalog lives in the memory of the Pmitz process. This remembers which sandboxes had
// their stored products sent to the process that is running now.
const loaded = new Set();

// A Pmitz process that restarted has an empty catalog and answers as if no product ever existed.
// A marker product tells the two cases apart: when it can be created again, the process is new.
const MARKER_PRODUCT = { productId: 'gateway--marker', features: [], plans: [] };
let markerCheckedAt = 0;

async function forgetCatalogIfPmitzRestarted() {
	if (Date.now() - markerCheckedAt < 5000) {
		return;
	}
	const response = await callInternal('POST', '/products', MARKER_PRODUCT);
	if (response.status === 200) {
		loaded.clear();
	}
	else if (response.status !== 409) {
		throw new Refusal(503, 'The Pmitz server behind this service is not ready. Try again in a moment.');
	}
	markerCheckedAt = Date.now();
}

async function ensureCatalogLoaded(sandbox) {
	await forgetCatalogIfPmitzRestarted();
	if (loaded.has(sandbox.id)) {
		return;
	}
	const products = await pool.query('SELECT product_id, definition FROM gateway.product WHERE sandbox_id = $1',
		[sandbox.id]);
	for (const row of products.rows) {
		const definition = { ...row.definition, productId: sandbox.prefix + row.product_id };
		const response = await callInternal('POST', '/products', definition);
		if (response.status !== 200 && response.status !== 409) {
			throw new Refusal(503, 'The stored plans of this sandbox could not be loaded. Try again in a moment.');
		}
	}
	loaded.add(sandbox.id);
}

function checkId(value, name) {
	if (typeof value !== 'string' || value.trim() === '' || value.length > LIMITS.maxIdLength) {
		throw new Refusal(400, `"${name}" must be a non-empty string of at most ${LIMITS.maxIdLength} characters.`);
	}
	return value;
}

// Removes the sandbox prefix from everything the Pmitz server answers.
function withoutPrefix(sandbox, body) {
	if (body === null || body === undefined) {
		return body;
	}
	if (typeof body === 'string') {
		return body.split(sandbox.prefix).join('');
	}
	return JSON.parse(JSON.stringify(body).split(sandbox.prefix).join(''));
}

// Runs one Pmitz REST request inside a sandbox. `path` is a Pmitz route such as /products or
// /subscriptions/acme/usage/reports/export. Returns { status, body } with sandbox IDs restored.
async function forward(sandbox, method, path, body) {
	const segments = path.split('?')[0].split('/').filter((segment) => segment !== '')
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			}
			catch {
				throw new Refusal(400, 'The path is not valid.');
			}
		});
	const encode = (parts) => '/' + parts.map(encodeURIComponent).join('/');
	const scoped = (id, name) => sandbox.prefix + checkId(id, name);
	let target;
	let payload = body;
	let after = async () => {};

	if (segments.length === 1 && segments[0] === 'products' && method === 'POST') {
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			throw new Refusal(400, 'The body must be one product object.');
		}
		const productId = checkId(body.productId, 'productId');
		const count = await pool.query('SELECT count(*)::int AS n FROM gateway.product WHERE sandbox_id = $1',
			[sandbox.id]);
		if (count.rows[0].n >= LIMITS.maxProductsPerSandbox) {
			throw new Refusal(422, `A sandbox holds at most ${LIMITS.maxProductsPerSandbox} products.`);
		}
		target = '/products';
		payload = { ...body, productId: sandbox.prefix + productId };
		after = async (response) => {
			if (response.status === 200) {
				await pool.query(
					`INSERT INTO gateway.product (sandbox_id, product_id, definition) VALUES ($1, $2, $3)
					 ON CONFLICT (sandbox_id, product_id) DO UPDATE SET definition = EXCLUDED.definition`,
					[sandbox.id, productId, JSON.stringify(body)]);
			}
		};
	}
	else if (segments.length === 2 && segments[0] === 'products' && method === 'DELETE') {
		const productId = checkId(segments[1], 'productId');
		target = encode(['products', sandbox.prefix + productId]);
		after = async (response) => {
			if (response.status === 200) {
				await pool.query('DELETE FROM gateway.product WHERE sandbox_id = $1 AND product_id = $2',
					[sandbox.id, productId]);
			}
		};
	}
	else if (segments.length === 1 && segments[0] === 'subscriptions' && method === 'POST') {
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			throw new Refusal(400, 'The body must be one subscription object.');
		}
		const subscriptionId = checkId(body.subscriptionId, 'subscriptionId');
		const plans = body.plans;
		if (plans === null || typeof plans !== 'object' || Array.isArray(plans)) {
			throw new Refusal(400, '"plans" must be an object that maps product IDs to plan IDs.');
		}
		const count = await pool.query('SELECT count(*)::int AS n FROM gateway.subscription WHERE sandbox_id = $1',
			[sandbox.id]);
		if (count.rows[0].n >= LIMITS.maxSubscriptionsPerSandbox) {
			throw new Refusal(422, `A sandbox holds at most ${LIMITS.maxSubscriptionsPerSandbox} subscriptions.`);
		}
		target = '/subscriptions';
		payload = {
			...body,
			subscriptionId: sandbox.prefix + subscriptionId,
			plans: Object.fromEntries(Object.entries(plans)
				.map(([productId, planId]) => [sandbox.prefix + checkId(productId, 'plans key'), planId])),
		};
		after = async (response) => {
			if (response.status === 200) {
				await pool.query(
					'INSERT INTO gateway.subscription (sandbox_id, subscription_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
					[sandbox.id, subscriptionId]);
			}
		};
	}
	else if (segments.length === 2 && segments[0] === 'subscriptions' && method === 'GET') {
		target = encode(['subscriptions', scoped(segments[1], 'subscriptionId')]);
	}
	else if (segments.length === 3 && segments[0] === 'subscriptions' && segments[2] === 'status' && method === 'PATCH') {
		target = encode(['subscriptions', scoped(segments[1], 'subscriptionId'), 'status']);
	}
	else if (segments.length === 5 && GROUP_TYPES.includes(segments[0]) && OPERATIONS.includes(segments[2])
			&& (method === 'GET' || method === 'POST')) {
		target = encode([segments[0], scoped(segments[1], 'groupId'), segments[2], scoped(segments[3], 'productId'),
			checkId(segments[4], 'featureId')]);
	}
	else {
		throw new Refusal(404, 'This is not a route of the Pmitz REST API.');
	}

	await ensureCatalogLoaded(sandbox);
	const response = await callInternal(method, target, payload);
	await after(response);
	return { status: response.status, body: withoutPrefix(sandbox, response.body) };
}

// ---------------------------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------------------------

const INSTANCE_PROPERTY = {
	type: 'string',
	description: 'The sandbox key returned by pmitz_create_sandbox, for example pmz_ab12cd34ef56_….',
};

const NOTICE = `A sandbox is a temporary Pmitz server for development and testing. It is deleted `
	+ `${LIMITS.lifetimeHours} hours after it is created and is not for production. Do not put personal or `
	+ 'confidential information in it.';

// Told to the user when a sandbox is handed over, not repeated in the tool descriptions.
const FOR_PRODUCTION = 'For production, run Pmitz on your own server from the Docker image.';

function restUrl(sandboxId) {
	return `${settings.publicUrl}/sandbox/${sandboxId}`;
}

function toolsetFor(sandbox) {
	return createToolset({
		server: restUrl(sandbox.id),
		omit: ['pmitz_connection_status'],
		async callPmitz(method, path, body) {
			try {
				return await forward(sandbox, method, path, body);
			}
			catch (error) {
				if (error instanceof Refusal) {
					throw Object.assign(new ToolError(error.message), { status: error.status });
				}
				throw error;
			}
		},
	});
}

const signIn = createSignIn({ pool, settings, limits: LIMITS, allow, logUsage });

const KEEP_TOOL = {
	name: 'pmitz_keep_sandbox',
	description: `Keeps a sandbox for ${LIMITS.keptDays} days instead of ${LIMITS.lifetimeHours} hours, for a user who signs in with `
		+ 'GitHub. Optional: a sandbox works the same without it. Use it only when the user asks to keep a sandbox '
		+ 'longer or to sign in. The first call returns a GitHub address and a short code: show both to the user. '
		+ 'When the user says they entered the code, call it again with the same sandbox key. Only the public '
		+ 'GitHub profile (username, name and company) is read.',
	inputSchema: {
		type: 'object',
		properties: { sandbox: INSTANCE_PROPERTY },
		required: ['sandbox'],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

const OWN_TOOLS = [
	{
		name: 'pmitz_create_sandbox',
		description: 'Creates a new Pmitz sandbox and returns its sandbox key, its REST address and when it '
			+ 'expires. ' + NOTICE + ' Create one only when the user asks for a Pmitz sandbox or needs a server to develop '
			+ 'against, and reuse the key for the rest of the conversation. Show the key to the user: it is the only '
			+ 'way back to the sandbox.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	},
	{
		name: 'pmitz_sandbox_status',
		description: 'Shows when a sandbox expires, which products it holds, how many subscriptions it has, and '
			+ 'the REST address an application can call.',
		inputSchema: {
			type: 'object',
			properties: { sandbox: INSTANCE_PROPERTY },
			required: ['sandbox'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
	{
		name: 'pmitz_export_plans',
		description: 'Returns the product definitions of a sandbox (features, limits and plans) exactly as they '
			+ 'were created, so they can be kept in source control and loaded into another Pmitz server. '
			+ 'Subscriptions and recorded usage are not exported.',
		inputSchema: {
			type: 'object',
			properties: { sandbox: INSTANCE_PROPERTY },
			required: ['sandbox'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
];

// The Pmitz tools of the local MCP server, each with the sandbox key added.
function sharedTools() {
	const listing = createToolset({ omit: ['pmitz_connection_status'] }).listTools();
	return listing.map((tool) => ({
		...tool,
		description: `${tool.description} Acts on one Pmitz sandbox.`,
		inputSchema: {
			...tool.inputSchema,
			properties: { sandbox: INSTANCE_PROPERTY, ...tool.inputSchema.properties },
			required: ['sandbox', ...(tool.inputSchema.required ?? [])],
		},
	}));
}

const ALL_TOOLS = [...OWN_TOOLS, ...(signIn.on ? [KEEP_TOOL] : []), ...sharedTools()];

function describeSandbox(sandbox) {
	return {
		restBaseUrl: restUrl(sandbox.id),
		restAuthentication: 'Send the sandbox key in the X-Api-Key header.',
		expiresAt: sandbox.expiresAt.toISOString(),
		hoursLeft: Math.max(0, Math.round((sandbox.expiresAt.getTime() - Date.now()) / 36000) / 100),
		notice: NOTICE,
	};
}

async function callTool(name, args, context) {
	if (args === null || typeof args !== 'object' || Array.isArray(args)) {
		throw new ToolError('Tool arguments must be an object.');
	}
	if (!ALL_TOOLS.some((tool) => tool.name === name)) {
		throw new ToolError(`Unknown tool: ${name}.`);
	}
	try {
		if (name === 'pmitz_create_sandbox') {
			const created = await createSandbox(context.address);
			context.sandboxId = created.id;
			logUsage('sandbox_created', context, { sandbox: created.id });
			return {
				ok: true,
				tellTheUser: 'In your answer to the user, always include the sandbox key and when the sandbox expires, '
					+ 'even if they did not ask. The key is shown only now and is the only way back to the sandbox.',
				sandbox: created.key,
				...describeSandbox({ id: created.id, expiresAt: created.expiresAt }),
				forProduction: FOR_PRODUCTION,
				...(signIn.on ? { keepLonger: `To keep it ${LIMITS.keptDays} days, the user can sign in with GitHub: pmitz_keep_sandbox.` } : {}),
				next: 'Create a product with pmitz_create_product, then a subscription with pmitz_create_subscription.',
			};
		}
		const sandbox = await authenticate(args.sandbox);
		context.sandboxId = sandbox.id;
		context.user = sandbox.user ?? undefined;
		if (name === 'pmitz_keep_sandbox') {
			return await signIn.keep(sandbox, context);
		}
		if (name === 'pmitz_sandbox_status') {
			const products = await pool.query(
				'SELECT product_id FROM gateway.product WHERE sandbox_id = $1 ORDER BY product_id', [sandbox.id]);
			const subscriptions = await pool.query(
				'SELECT count(*)::int AS n FROM gateway.subscription WHERE sandbox_id = $1', [sandbox.id]);
			return {
				ok: true,
				...describeSandbox(sandbox),
				...(sandbox.user ? { signedInAs: sandbox.user } : {}),
				products: products.rows.map((row) => row.product_id),
				subscriptions: subscriptions.rows[0].n,
			};
		}
		if (name === 'pmitz_export_plans') {
			const products = await pool.query(
				'SELECT definition FROM gateway.product WHERE sandbox_id = $1 ORDER BY product_id', [sandbox.id]);
			return {
				ok: true,
				products: products.rows.map((row) => row.definition),
				howToLoad: 'Send each product object to POST /products of the target Pmitz server, or pass it to the '
					+ 'pmitz_create_product tool of the local Pmitz MCP server. Embedded Java loads the same objects as '
					+ 'one JSON array with InMemoryProductRepository.load.',
			};
		}
		const { sandbox: _key, ...rest } = args;
		return await toolsetFor(sandbox).callTool(name, rest);
	}
	catch (error) {
		if (error instanceof Refusal) {
			if (error.status === 429) {
				logUsage('rate_limited', context, {});
			}
			throw Object.assign(new ToolError(error.message), { status: error.status });
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

// Who is calling. Google's front end appends the address of whoever connected to it as the last entry of
// X-Forwarded-For, and a caller cannot change that entry. Through pmitz-mcp.web.app that sender is a Firebase
// Hosting machine, which has put the caller's address just before its own and discarded anything the caller
// sent. Through the service's own run.app address the sender is the caller, and the earlier entries are whatever
// the caller chose to send. So the entry before the last is believed only when the last one is a machine of
// Google's own, which no customer can send from.

// Google publishes its address ranges (goog.json) and the ones its cloud customers use (cloud.json). Its own
// machines are in the first list and not in the second. These six ranges are where Firebase Hosting was seen
// on 2026-11-23, used until the published lists are loaded or if they cannot be.
const googleRanges = { own: new BlockList(), customers: new BlockList() };
for (const range of ['64.233.160.0/19', '66.102.0.0/20', '66.249.64.0/19', '74.125.0.0/16', '142.250.0.0/15', '192.178.0.0/15']) {
	const [prefix, length] = range.split('/');
	googleRanges.own.addSubnet(prefix, Number(length), 'ipv4');
}

async function loadGoogleRanges() {
	const read = async (name) => {
		const reply = await fetch(`https://www.gstatic.com/ipranges/${name}.json`, { signal: AbortSignal.timeout(5000) });
		const list = new BlockList();
		for (const entry of (await reply.json()).prefixes) {
			const [prefix, length] = (entry.ipv4Prefix ?? entry.ipv6Prefix).split('/');
			list.addSubnet(prefix, Number(length), entry.ipv4Prefix ? 'ipv4' : 'ipv6');
		}
		return list;
	};
	try {
		const [own, customers] = await Promise.all([read('goog'), read('cloud')]);
		googleRanges.own = own;
		googleRanges.customers = customers;
	}
	catch (error) {
		console.error(`could not load Google's address ranges, keeping the previous ones: ${error.message}`);
	}
}

function isGoogleOwnMachine(address) {
	const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
	return isIP(address) !== 0 && googleRanges.own.check(address, family) && !googleRanges.customers.check(address, family);
}

// Who an address belongs to: the network that announces it on the internet (its owner, for example a cloud
// provider, a company or an internet provider) and the country that network is registered in. Read from the
// public-domain tables of iptoasn.com, loaded at start and once a day. The lookup happens in this process;
// no address is sent anywhere.
const networkTables = { v4: null, v6: null };

function v4Number(address) {
	return address.split('.').reduce((number, part) => number * 256 + Number(part), 0);
}

// The upper 64 bits of an IPv6 address, which is as fine as networks are announced.
function v6Upper(address) {
	const [head, tail] = address.split('::');
	const groups = (text) => (text ? text.split(':').flatMap((group) => (group.includes('.') ? ['0', '0'] : [group])) : []);
	const first = groups(head);
	const last = tail === undefined ? [] : groups(tail);
	const all = [...first, ...Array(Math.max(0, 8 - first.length - last.length)).fill('0'), ...last];
	return all.slice(0, 4).reduce((number, group) => (number << 16n) | BigInt(parseInt(group, 16) || 0), 0n);
}

async function readNetworkTable(name, toNumber, Numbers) {
	const reply = await fetch(`https://iptoasn.com/data/ip2asn-${name}.tsv.gz`, { signal: AbortSignal.timeout(60000) });
	if (!reply.ok) {
		throw new Error(`${name} table: HTTP ${reply.status}`);
	}
	const rows = gunzipSync(Buffer.from(await reply.arrayBuffer())).toString('utf8').split('\n')
		.map((line) => line.split('\t')).filter((row) => row.length >= 5 && row[2] !== '0');
	const table = { starts: new Numbers(rows.length), ends: new Numbers(rows.length), owner: new Uint32Array(rows.length), owners: [] };
	const known = new Map();
	rows.forEach(([start, end, number, country, name_], index) => {
		const key = `${number}\t${country}`;
		if (!known.has(key)) {
			known.set(key, table.owners.length);
			table.owners.push({ network: `AS${number} ${name_}`.slice(0, 120), country: /^[A-Z]{2}$/.test(country) ? country : 'unknown' });
		}
		table.starts[index] = toNumber(start);
		table.ends[index] = toNumber(end);
		table.owner[index] = known.get(key);
	});
	return table;
}

async function loadNetworkTables() {
	try {
		networkTables.v4 = await readNetworkTable('v4', v4Number, Float64Array);
		networkTables.v6 = await readNetworkTable('v6', v6Upper, BigUint64Array);
		console.log(`network tables loaded: ${networkTables.v4.starts.length + networkTables.v6.starts.length} ranges`);
	}
	catch (error) {
		console.error(`could not load the network tables, keeping the previous ones: ${error.message}`);
	}
}

const UNKNOWN_NETWORK = { network: 'unknown', country: 'unknown' };

function networkOf(address) {
	let text = String(address);
	if (text.toLowerCase().startsWith('::ffff:') && isIP(text.slice(7)) === 4) {
		text = text.slice(7);
	}
	const kind = isIP(text);
	const table = kind === 4 ? networkTables.v4 : kind === 6 ? networkTables.v6 : null;
	if (!table) {
		return UNKNOWN_NETWORK;
	}
	const value = kind === 4 ? v4Number(text) : v6Upper(text);
	let low = 0;
	let high = table.starts.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if (table.starts[middle] <= value) {
			low = middle;
		}
		else {
			high = middle - 1;
		}
	}
	return table.starts.length > 0 && table.starts[low] <= value && value <= table.ends[low] ? table.owners[table.owner[low]] : UNKNOWN_NETWORK;
}

// Returns the caller's address and how the request arrived: 'hosting' through pmitz-mcp.web.app, 'direct'
// through the run.app address, 'unrecognised' when it names Firebase Hosting but did not come from a machine
// of Google's own (a forged request, or a range missing from the lists), and 'local' with no proxy at all.
function callerOf(request) {
	const hops = String(request.headers['x-forwarded-for'] ?? '').split(',').map((hop) => hop.trim()).filter(Boolean);
	if (hops.length === 0) {
		return { address: request.socket.remoteAddress || 'unknown', via: 'local' };
	}
	const sender = hops.at(-1);
	const namesHosting = /firebase hosting/i.test(String(request.headers.via ?? ''));
	if (namesHosting && hops.length >= 2 && isGoogleOwnMachine(sender)) {
		return { address: hops.at(-2), via: 'hosting' };
	}
	return { address: sender, via: namesHosting ? 'unrecognised' : 'direct' };
}

function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		request.on('data', (chunk) => {
			size += chunk.length;
			if (size > LIMITS.maxBodyBytes) {
				reject(new Refusal(413, `The request body is larger than ${LIMITS.maxBodyBytes / 1024} KB.`));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});
}

function sendJson(response, status, value, headers = {}) {
	const text = JSON.stringify(value);
	response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
	response.end(text);
}

function sendText(response, status, text, type = 'text/plain; charset=utf-8') {
	response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
	response.end(text);
}

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id',
	'Access-Control-Max-Age': '86400',
};

function toolResult(value, isError) {
	const text = (typeof value === 'string') ? value : JSON.stringify(value, null, 2);
	return { content: [{ type: 'text', text }], isError };
}

async function handleRpc(message, context) {
	const { id, method, params } = message;
	const isRequest = id !== undefined && id !== null;
	const result = (value) => ({ jsonrpc: '2.0', id, result: value });

	switch (method) {
		case 'initialize': {
			const requested = params?.protocolVersion;
			logUsage('mcp_connect', context, {
				clientName: String(params?.clientInfo?.name ?? '').slice(0, 60),
				clientVersion: String(params?.clientInfo?.version ?? '').slice(0, 30),
			});
			return result({
				protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
				capabilities: { tools: {} },
				serverInfo: { name: 'pmitz-sandbox', title: 'Pmitz sandbox', version: SERVER_VERSION },
				instructions: 'Gives the user a Pmitz sandbox to develop and test subscription plans, feature access and '
					+ 'usage limits, with no account. Call pmitz_create_sandbox once, show the user the sandbox key, '
					+ 'and pass that key to every other tool. ' + NOTICE,
			});
		}
		case 'ping':
			return result({});
		case 'tools/list':
			return result({ tools: ALL_TOOLS });
		case 'tools/call': {
			const tool = ALL_TOOLS.some((known) => known.name === params?.name) ? params.name : 'unknown';
			const started = Date.now();
			// One connection can carry several calls: what the previous one set does not apply to this one.
			context.sandboxId = undefined;
			context.user = undefined;
			const { sandbox: _key, ...sent } = (params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
				? params.arguments : {};
			const about = () => ({
				tool, ...(tool === 'unknown' ? { asked: forLog(String(params?.name).slice(0, 80)) } : {}),
				...(context.sandboxId ? { sandbox: context.sandboxId } : {}), ms: Date.now() - started, arguments: forLog(sent),
			});
			try {
				const value = await callTool(params?.name, params?.arguments ?? {}, context);
				logUsage('tool_call', context, { ...about(), outcome: value?.ok === false ? 'refused' : 'ok', ...resultSummary(value), result: forLog(value) });
				return result(toolResult(value, value?.ok === false));
			}
			catch (error) {
				if (error instanceof ToolError) {
					const reason = error.status ? refusalReason(error.status) : (tool === 'unknown' ? 'unknown_tool' : 'invalid_arguments');
					logUsage('tool_call', context, { ...about(), outcome: 'refused', reason, result: forLog(error.message) });
					return result(toolResult(error.message, true));
				}
				logUsage('tool_call', context, { ...about(), outcome: 'error', result: forLog(String(error?.message)) });
				console.error(`unexpected error in ${params?.name}: ${error?.message}`);
				return result(toolResult('The service hit an unexpected error.', true));
			}
		}
		default:
			return isRequest ? { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } } : null;
	}
}

async function handleMcp(request, response, context) {
	if (request.method === 'OPTIONS') {
		response.writeHead(204, CORS);
		response.end();
		return;
	}
	if (request.method !== 'POST') {
		sendJson(response, 405, { error: 'Send MCP messages with POST.' }, { Allow: 'POST, OPTIONS', ...CORS });
		return;
	}
	let payload;
	try {
		payload = JSON.parse(await readBody(request));
	}
	catch (error) {
		if (error instanceof Refusal) {
			sendJson(response, error.status, { jsonrpc: '2.0', id: null, error: { code: -32600, message: error.message } }, CORS);
			return;
		}
		sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, CORS);
		return;
	}
	const messages = Array.isArray(payload) ? payload : [payload];
	const replies = [];
	for (const message of messages) {
		if (message === null || typeof message !== 'object' || typeof message.method !== 'string') {
			continue;
		}
		const reply = await handleRpc(message, context);
		if (reply) {
			replies.push(reply);
		}
	}
	if (replies.length === 0) {
		response.writeHead(202, CORS);
		response.end();
		return;
	}
	sendJson(response, 200, Array.isArray(payload) ? replies : replies[0], CORS);
}

async function handleRest(request, response, sandboxId, rest, context) {
	const started = Date.now();
	const sandbox = await authenticate(request.headers['x-api-key'], sandboxId);
	context.user = sandbox.user ?? undefined;
	let body;
	if (request.method === 'POST' || request.method === 'PATCH') {
		const text = await readBody(request);
		if (text.trim() !== '') {
			try {
				body = JSON.parse(text);
			}
			catch {
				throw new Refusal(400, 'The body is not valid JSON.');
			}
		}
	}
	const result = await forward(sandbox, request.method, rest, body);
	// The kind of resource, for the counters. The full path is logged next to it.
	const resource = /^\/([a-z-]{1,30})/.exec(rest)?.[1] ?? 'other';
	logUsage('rest_call', context, {
		sandbox: sandbox.id, method: request.method, resource, status: result.status, ms: Date.now() - started,
		path: forLog(rest), request: forLog(body), response: forLog(result.body),
	});
	if (result.body === null || result.body === undefined) {
		response.writeHead(result.status, { 'Cache-Control': 'no-store' });
		response.end();
		return;
	}
	if (typeof result.body === 'string') {
		sendText(response, result.status, result.body);
		return;
	}
	sendJson(response, result.status, result.body);
}

const HOME_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pmitz sandbox</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#1b1b1f}code{background:#f0f0f3;padding:.1rem .3rem;border-radius:.2rem}</style>
</head><body>
<h1>Pmitz sandbox</h1>
<p>This is the hosted MCP server of <a href="https://terpomosoft.com/pmitz/">Pmitz</a>, the subscription-entitlement and usage-limit product from Terpomo Software.</p>
<p>It gives an AI assistant a Pmitz sandbox to develop and test plans, feature access and usage limits, with no account. A sandbox is temporary: it is deleted ${LIMITS.lifetimeHours} hours after it is created${signIn.on ? `, or ${LIMITS.keptDays} days if you sign in with GitHub,` : ''} and is not for production. Do not put personal or confidential information in it.</p>
<p>MCP endpoint: <code>${settings.publicUrl}/mcp</code></p>
<p>For production, run Pmitz yourself from the <a href="https://hub.docker.com/r/terpomo/pmitz-remoteserver">Docker image</a>, or <a href="https://terpomosoft.com/contact/">contact Terpomo Software</a> about Pmitz SaaS.</p>
<p><a href="https://terpomosoft.com/terms/">Terms of service</a> · <a href="https://terpomosoft.com/privacy/">Privacy policy</a> · <a href="https://github.com/terpomo-io/pmitz-plugin">Source</a></p>
</body></html>`;

const server = createServer(async (request, response) => {
	const { address, via } = callerOf(request);
	const url = new URL(request.url ?? '/', 'http://localhost');
	const context = { address, via };
	try {
		if (url.pathname === '/health') {
			sendText(response, 200, 'ok');
			return;
		}
		context.client = clientKind(request.headers['user-agent']);
		context.caller = callerHash(address);
		Object.assign(context, networkOf(address));
		if (!allow(`address:${address}`, LIMITS.requestsPerAddressPerMinute, 60 * 1000)) {
			throw new Refusal(429, 'Too many requests. Wait a minute.');
		}
		sweepExpired();
		if (url.pathname === '/mcp') {
			await handleMcp(request, response, context);
			return;
		}
		if (url.pathname === '/.well-known/openai-apps-challenge') {
			if (!settings.challenge) {
				throw new Refusal(404, 'Not found.');
			}
			sendText(response, 200, settings.challenge);
			return;
		}
		const rest = /^\/sandbox\/([a-z0-9]{12})(\/.*)$/.exec(url.pathname);
		if (rest) {
			await handleRest(request, response, rest[1], rest[2], context);
			return;
		}
		if (url.pathname === '/' && request.method === 'GET') {
			logUsage('home_page', context, { referrer: forLog(String(request.headers.referer ?? '').slice(0, 300)) });
			sendText(response, 200, HOME_PAGE, 'text/html; charset=utf-8');
			return;
		}
		throw new Refusal(404, 'Not found.');
	}
	catch (error) {
		if (response.headersSent) {
			response.end();
			return;
		}
		if (error instanceof Refusal) {
			if (error.status === 429 && context.caller) {
				logUsage('rate_limited', context, {});
			}
			// Everything refused outside a tool call: a REST call with a bad key or path, an address that does not exist.
			if (context.caller) {
				logUsage('refused_request', context, {
					method: request.method, path: forLog(url.pathname.slice(0, 300)), status: error.status,
					reason: refusalReason(error.status), message: forLog(error.message),
				});
			}
			sendJson(response, error.status, { error: error.message });
			return;
		}
		console.error(`unexpected error for ${request.method} ${url.pathname}: ${error?.message}`);
		sendJson(response, 500, { error: 'The service hit an unexpected error.' });
	}
});

if (!settings.pmitzKey || !settings.databaseUrl) {
	console.error('PMITZ_INTERNAL_KEY and DATABASE_URL must be set.');
	process.exit(1);
}

await prepareStorage();
await signIn.prepareStorage();
await loadGoogleRanges();
setInterval(loadGoogleRanges, 24 * 3600 * 1000).unref();
// Not awaited: the tables are large, and until they are loaded a caller's network is logged as unknown.
loadNetworkTables();
setInterval(loadNetworkTables, 24 * 3600 * 1000).unref();
server.listen(settings.port, () => {
	console.log(`Pmitz hosted MCP listening on ${settings.port}, public address ${settings.publicUrl}`);
});

process.on('SIGTERM', () => {
	server.close(() => pool.end().finally(() => process.exit(0)));
});
