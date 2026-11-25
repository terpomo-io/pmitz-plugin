#!/usr/bin/env node
// Who used the sandbox service: one line per caller, from the usage log.
//
//   node who.mjs            the last 7 days
//   node who.mjs 30         the last 30 days
//   node who.mjs 7 all      every call of every caller, not only the first 30
//
// Reads the log with gcloud, so gcloud must be signed in to an account that can read the logs of the project
// (set GCLOUD_PROJECT to use another project than terpomo-pmitz-mcp).
//
// The log holds each caller's address, the network that announces it and its country. This report adds who
// the address is registered to and the host name it resolves to. The network is often an internet provider;
// the internet registries (ARIN, RIPE and the others) also record who each block was assigned to, which can
// be the provider's customer: a company. They are asked here and not by the service, because they limit
// requests per sender and the service shares its outgoing addresses with other Google Cloud customers.

import { execFileSync } from 'node:child_process';
import { reverse } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const days = Number(process.argv[2] && process.argv[2] !== 'all' ? process.argv[2] : 7);
const project = process.env.GCLOUD_PROJECT ?? 'terpomo-pmitz-mcp';
if (!Number.isInteger(days) || days < 1 || days > 30) {
	console.error('Give a number of days from 1 to 30. Cloud Logging keeps 30 days.');
	process.exit(1);
}

const entries = JSON.parse(execFileSync('gcloud', [
	'logging', 'read', 'jsonPayload.usage.event:*', '--project', project, `--freshness=${days}d`, '--limit=100000', '--format=json',
], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 }));

// One caller is everything that shares a signed-in user, an address or a sandbox. An assistant's service can
// call from several addresses within one conversation; the sandbox they all use ties them together.
const groupOf = new Map();
function find(key) {
	while (groupOf.get(key) !== key) {
		groupOf.set(key, groupOf.get(groupOf.get(key)));
		key = groupOf.get(key);
	}
	return key;
}
function join(one, other) {
	for (const key of [one, other]) {
		if (!groupOf.has(key)) {
			groupOf.set(key, key);
		}
	}
	groupOf.set(find(one), find(other));
}
entries.sort((one, other) => one.timestamp.localeCompare(other.timestamp));
const lastOfBlock = new Map();
for (const entry of entries) {
	const usage = entry.jsonPayload.usage;
	const keys = [usage.user && `user:${usage.user}`, `address:${usage.address ?? usage.caller}`, usage.sandbox && `sandbox:${usage.sandbox}`].filter(Boolean);
	keys.forEach((key) => join(keys[0], key));
	// A service that calls from several addresses uses neighbouring ones. Calls from the same block of
	// addresses within a quarter of an hour are taken as one caller.
	const block = String(usage.address ?? '').includes(':')
		? String(usage.address).split(':').slice(0, 3).join(':')
		: String(usage.address ?? '').split('.').slice(0, 2).join('.');
	if (block) {
		const previous = lastOfBlock.get(block);
		if (previous && Date.parse(entry.timestamp) - Date.parse(previous.at) < 15 * 60 * 1000) {
			join(keys[0], previous.key);
		}
		lastOfBlock.set(block, { at: entry.timestamp, key: keys[0] });
	}
}

const callers = new Map();
for (const entry of entries) {
	const usage = entry.jsonPayload.usage;
	const key = find(usage.user ? `user:${usage.user}` : `address:${usage.address ?? usage.caller}`);
	const caller = callers.get(key) ?? {
		user: null, userName: null, company: null, addresses: new Set(), clients: new Set(), networks: new Set(), sandboxes: new Set(),
		first: entry.timestamp, last: entry.timestamp, connections: 0, toolCalls: 0, restCalls: 0, refused: 0, calls: [],
	};
	callers.set(key, caller);
	caller.user = usage.user ?? caller.user;
	caller.userName = usage.userName ?? caller.userName;
	caller.company = usage.company ?? caller.company;
	if (usage.address) {
		caller.addresses.add(usage.address);
	}
	if (usage.sandbox) {
		caller.sandboxes.add(usage.sandbox);
	}
	if (usage.network && usage.network !== 'unknown') {
		caller.networks.add(`${usage.country}, ${usage.network}`);
	}
	caller.clients.add(usage.clientName ? `${usage.client} (${usage.clientName})` : usage.client);
	caller.last = entry.timestamp;
	caller.connections += usage.event === 'mcp_connect' ? 1 : 0;
	caller.toolCalls += usage.event === 'tool_call' ? 1 : 0;
	caller.restCalls += usage.event === 'rest_call' ? 1 : 0;
	caller.refused += (usage.outcome === 'refused' || usage.event === 'refused_request' || usage.event === 'rate_limited') ? 1 : 0;
	if (['tool_call', 'rest_call', 'refused_request', 'signed_in'].includes(usage.event)) {
		caller.calls.push({ at: entry.timestamp, ...usage });
	}
}

// One line per call: when, what, how it ended, and what was sent.
function describe(call) {
	const short = (value, length) => {
		const text = value === undefined ? '' : JSON.stringify(value);
		return text.length > length ? `${text.slice(0, length)}…` : text;
	};
	const time = call.at.slice(11, 19);
	if (call.event === 'tool_call') {
		const ending = [call.outcome, call.reason, call.decision].filter(Boolean).join(', ');
		return `${time}  ${call.tool.replace(/^pmitz_/, '')}  [${ending}]  ${short(call.arguments, 160)}`;
	}
	if (call.event === 'rest_call') {
		return `${time}  REST ${call.method} ${call.path ?? `/${call.resource}`}  [${call.status}]  ${short(call.request, 160)}`;
	}
	if (call.event === 'signed_in') {
		return `${time}  signed in with GitHub as ${call.user}`;
	}
	return `${time}  refused ${call.method} ${call.path}  [${call.status}, ${call.reason}]`;
}

// Which registry holds an address, from the list IANA publishes.
const registries = { 4: [], 6: [] };
for (const family of [4, 6]) {
	const reply = await fetch(`https://data.iana.org/rdap/ipv${family}.json`, { signal: AbortSignal.timeout(15000) });
	registries[family] = (await reply.json()).services.map(([prefixes, urls]) => {
		const list = new BlockList();
		for (const prefix of prefixes) {
			const [start, length] = prefix.split('/');
			list.addSubnet(start, Number(length), `ipv${family}`);
		}
		return { list, url: (urls.find((url) => url.startsWith('https:')) ?? '').replace(/\/+$/, '') };
	}).filter((registry) => registry.url);
}

async function registeredTo(address) {
	const family = isIP(address);
	const registry = registries[family]?.find((entry) => entry.list.check(address, `ipv${family}`));
	if (!registry) {
		return '';
	}
	const reply = await fetch(`${registry.url}/ip/${address}`, { headers: { Accept: 'application/rdap+json' }, signal: AbortSignal.timeout(15000) });
	if (!reply.ok) {
		return `(registry answered ${reply.status})`;
	}
	const block = await reply.json();
	const names = (block.entities ?? []).filter((entity) => entity.roles?.includes('registrant')).map((entity) => {
		const card = Array.isArray(entity.vcardArray?.[1]) ? entity.vcardArray[1] : [];
		const value = (field) => card.find((item) => item[0] === field)?.[3];
		return { name: typeof value('fn') === 'string' ? value('fn').trim() : '', kind: value('kind') };
	}).filter((entry) => entry.name);
	return (names.find((entry) => entry.kind === 'org') ?? names[0])?.name || block.name || '';
}

const known = new Map();
async function lookUp(address) {
	if (!known.has(address)) {
		known.set(address, {
			registeredTo: await registeredTo(address).catch((error) => `(${error.message})`),
			hostName: await reverse(address).then((names) => names[0] ?? '').catch(() => ''),
		});
	}
	return known.get(address);
}

const everything = process.argv.includes('all');
const sorted = [...callers.values()].sort((one, other) => other.last.localeCompare(one.last));
console.log(`Callers of the sandbox service in the last ${days} day${days === 1 ? '' : 's'}: ${sorted.length}\n`);
for (const caller of sorted) {
	const addresses = [...caller.addresses];
	const found = addresses[0] ? await lookUp(addresses[0]) : { registeredTo: '', hostName: '' };
	const who = caller.user
		? `${caller.user}${caller.userName ? ` (${caller.userName})` : ''}${caller.company ? `, ${caller.company}` : ''}  https://github.com/${caller.user}`
		: (found.registeredTo || [...caller.networks][0] || 'unknown');
	console.log(who);
	console.log(`  seen        ${caller.first.slice(0, 16).replace('T', ' ')} to ${caller.last.slice(0, 16).replace('T', ' ')} UTC`);
	console.log(`  from        ${[...caller.networks].join('; ') || 'unknown'}`);
	if (caller.user && found.registeredTo) {
		console.log(`  registered  ${found.registeredTo}`);
	}
	if (found.hostName) {
		console.log(`  host name   ${found.hostName}`);
	}
	console.log(`  address     ${addresses.slice(0, 3).join(', ') || 'not recorded'}${addresses.length > 3 ? ` and ${addresses.length - 3} more` : ''}`);
	console.log(`  assistant   ${[...caller.clients].join(', ')}`);
	console.log(`  did         ${caller.connections} connections, ${caller.sandboxes.size} sandboxes, ${caller.toolCalls} tool calls, ${caller.restCalls} REST calls`
		+ (caller.refused ? `, ${caller.refused} refused` : ''));
	const shown = everything ? caller.calls : caller.calls.slice(0, 30);
	for (const call of shown) {
		console.log(`    ${describe(call)}`);
	}
	if (caller.calls.length > shown.length) {
		console.log(`    and ${caller.calls.length - shown.length} more calls: add "all" to see them`);
	}
	console.log('');
}
