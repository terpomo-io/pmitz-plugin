// Optional sign-in with GitHub for the hosted MCP server.
//
// A sandbox needs no sign-in. A user who does sign in keeps their sandbox longer, and Terpomo learns who
// uses the service. It is on when GITHUB_CLIENT_ID names a GitHub OAuth app with the device flow enabled.
//
// The assistant has no browser of its own, so this is GitHub's device flow:
//   1. pmitz_keep_sandbox asks GitHub for a short code and gives it to the user with GitHub's address.
//   2. The user opens that address in their own browser, signs in and types the code.
//   3. pmitz_keep_sandbox, called again, asks GitHub whether the code was confirmed. If it was, the gateway
//      reads the user's public profile, records the sandbox under them and extends it.
//
// The gateway asks GitHub for no permission: the token it receives can read the public profile (username,
// name, company) and nothing else, and is not kept. No secret of the OAuth app is needed or held.
//
// Someone could create a sandbox and trick another person into typing its code at GitHub. They would gain a
// sandbox that lasts longer and is recorded under that person's name, and no access to anything of theirs.

const START_LIMIT_PER_HOUR = 10;

export function createSignIn({ pool, settings, limits, allow, logUsage }) {
	const on = Boolean(settings.githubClientId);
	// The sign-in in progress of each sandbox. In memory: it lasts a few minutes and can simply be restarted.
	const pending = new Map();

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
			ALTER TABLE gateway.sandbox ADD COLUMN IF NOT EXISTS owner_github_id BIGINT;
		`);
		setInterval(() => {
			for (const [sandboxId, entry] of pending) {
				if (entry.expiresAt <= Date.now()) {
					pending.delete(sandboxId);
				}
			}
		}, 10 * 60 * 1000).unref();
	}

	async function github(path, body) {
		const reply = await fetch(`${settings.githubUrl}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ client_id: settings.githubClientId, ...body }),
			signal: AbortSignal.timeout(10000),
		});
		return reply.json();
	}

	async function profileOf(token) {
		const reply = await fetch(`${settings.githubApiUrl}/user`, {
			headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pmitz-sandbox' },
			signal: AbortSignal.timeout(10000),
		});
		const profile = reply.ok ? await reply.json() : null;
		if (!profile || !Number.isSafeInteger(profile.id) || typeof profile.login !== 'string') {
			return null;
		}
		const text = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null);
		return { githubId: profile.id, login: profile.login.slice(0, 60), name: text(profile.name), company: text(profile.company) };
	}

	function askTheUser(entry, note) {
		return {
			ok: true,
			signedIn: false,
			tellTheUser: `${note} Open ${entry.address} in your browser, sign in to GitHub and enter the code ${entry.code}. `
				+ 'Say when it is done. We read only your public GitHub profile (username, name and company).',
			address: entry.address,
			code: entry.code,
			minutesLeft: Math.max(1, Math.round((entry.expiresAt - Date.now()) / 60000)),
			next: 'When the user says they entered the code, call pmitz_keep_sandbox again with the same sandbox key.',
		};
	}

	async function start(sandbox, context) {
		if (!allow(`sign-in:${context.address}`, START_LIMIT_PER_HOUR, 3600 * 1000)) {
			return { ok: false, error: 'Too many sign-ins were started from here. Try again in an hour.' };
		}
		const reply = await github('/login/device/code', {});
		if (typeof reply.device_code !== 'string' || typeof reply.user_code !== 'string') {
			return { ok: false, error: 'GitHub did not start the sign-in. Try again in a minute.' };
		}
		const entry = {
			deviceCode: reply.device_code,
			code: reply.user_code,
			address: typeof reply.verification_uri === 'string' ? reply.verification_uri : `${settings.githubUrl}/login/device`,
			intervalMs: (Number(reply.interval) || 5) * 1000,
			expiresAt: Date.now() + (Number(reply.expires_in) || 900) * 1000,
			askedAt: Date.now(),
		};
		pending.set(sandbox.id, entry);
		return askTheUser(entry, `To keep this sandbox for ${limits.keptDays} days, sign in with GitHub.`);
	}

	// Signs the user of a sandbox in, in two calls, and extends the sandbox once they are.
	async function keep(sandbox, context) {
		if (sandbox.user) {
			return { ok: true, signedIn: true, signedInAs: sandbox.user, expiresAt: sandbox.expiresAt.toISOString() };
		}
		const entry = pending.get(sandbox.id);
		if (!entry || entry.expiresAt <= Date.now()) {
			return start(sandbox, context);
		}
		// GitHub asks not to be asked more often than its interval.
		if (Date.now() - entry.askedAt < entry.intervalMs) {
			return askTheUser(entry, 'GitHub has not confirmed the code yet.');
		}
		entry.askedAt = Date.now();
		const reply = await github('/login/oauth/access_token', { device_code: entry.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
		if (reply.error === 'authorization_pending' || reply.error === 'slow_down') {
			entry.intervalMs += reply.error === 'slow_down' ? 5000 : 0;
			return askTheUser(entry, 'GitHub has not confirmed the code yet.');
		}
		pending.delete(sandbox.id);
		if (typeof reply.access_token !== 'string') {
			return reply.error === 'access_denied'
				? { ok: false, error: 'The sign-in was cancelled at GitHub. The sandbox is unchanged.' }
				: start(sandbox, context);
		}
		const account = await profileOf(reply.access_token);
		if (!account) {
			return { ok: false, error: 'GitHub did not return the profile. Try again in a minute.' };
		}
		const kept = await pool.query(
			'SELECT count(*)::int AS n FROM gateway.sandbox WHERE owner_github_id = $1 AND expires_at > now()', [account.githubId]);
		if (kept.rows[0].n >= limits.keptSandboxesPerAccount) {
			return { ok: false, error: `${account.login} already keeps ${limits.keptSandboxesPerAccount} sandboxes, the most one account can. This one is unchanged.` };
		}
		const stored = await pool.query(
			`INSERT INTO gateway.account (github_id, login, name, company) VALUES ($1, $2, $3, $4)
			 ON CONFLICT (github_id) DO UPDATE SET login = $2, name = $3, company = $4, last_seen = now()
			 RETURNING (xmax = 0) AS is_new`,
			[account.githubId, account.login, account.name, account.company]);
		const extended = await pool.query(
			`UPDATE gateway.sandbox SET owner_github_id = $2, expires_at = greatest(expires_at, created_at + make_interval(days => $3))
			 WHERE id = $1 RETURNING expires_at`,
			[sandbox.id, account.githubId, limits.keptDays]);
		logUsage('signed_in', { ...context, user: account.login },
			{ sandbox: sandbox.id, userName: account.name, company: account.company, firstTime: stored.rows[0].is_new });
		return {
			ok: true,
			signedIn: true,
			signedInAs: account.login,
			expiresAt: extended.rows[0].expires_at.toISOString(),
			tellTheUser: `Signed in as ${account.login}. The sandbox is now kept for ${limits.keptDays} days from its creation.`,
		};
	}

	return { on, prepareStorage, keep };
}
