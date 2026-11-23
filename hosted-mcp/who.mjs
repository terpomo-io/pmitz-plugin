#!/usr/bin/env node
// Who used the sandbox service: one line per caller, from the usage log.
//
//   node who.mjs            the last 7 days
//   node who.mjs 30         the last 30 days
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

const days = Number(process.argv[2] ?? 7);
const project = process.env.GCLOUD_PROJECT ?? 'terpomo-pmitz-mcp';
if (!Number.isInteger(days) || days < 1 || days > 30) {
	console.error('Give a number of days from 1 to 30. Cloud Logging keeps 30 days.');
	process.exit(1);
}

const entries = JSON.parse(execFileSync('gcloud', [
	'logging', 'read', 'jsonPayload.usage.event:*', '--project', project, `--freshness=${days}d`, '--limit=100000', '--format=json',
], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 }));

// One caller is one signed-in user, or one address when nobody is signed in.
const callers = new Map();
for (const entry of entries) {
	const usage = entry.jsonPayload.usage;
	const key = usage.user ? `user:${usage.user}` : `address:${usage.address ?? usage.caller}`;
	const caller = callers.get(key) ?? {
		user: usage.user, userName: null, company: null, addresses: new Set(), clients: new Set(), network: usage.network, country: usage.country,
		first: entry.timestamp, last: entry.timestamp, connections: 0, sandboxes: 0, toolCalls: 0, restCalls: 0, refused: 0,
	};
	callers.set(key, caller);
	if (usage.address) {
		caller.addresses.add(usage.address);
	}
	caller.clients.add(usage.clientName ? `${usage.client} (${usage.clientName})` : usage.client);
	caller.userName = usage.userName ?? caller.userName;
	caller.company = usage.company ?? caller.company;
	caller.first = entry.timestamp < caller.first ? entry.timestamp : caller.first;
	caller.last = entry.timestamp > caller.last ? entry.timestamp : caller.last;
	caller.connections += usage.event === 'mcp_connect' ? 1 : 0;
	caller.sandboxes += usage.event === 'sandbox_created' ? 1 : 0;
	caller.toolCalls += usage.event === 'tool_call' ? 1 : 0;
	caller.restCalls += usage.event === 'rest_call' ? 1 : 0;
	caller.refused += usage.event === 'rate_limited' ? 1 : 0;
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

const sorted = [...callers.values()].sort((one, other) => other.last.localeCompare(one.last));
console.log(`Callers of the sandbox service in the last ${days} day${days === 1 ? '' : 's'}: ${sorted.length}\n`);
for (const caller of sorted) {
	const addresses = [...caller.addresses];
	const found = addresses[0] ? await lookUp(addresses[0]) : { registeredTo: '', hostName: '' };
	const who = caller.user
		? `${caller.user}${caller.userName ? ` (${caller.userName})` : ''}${caller.company ? `, ${caller.company}` : ''}  https://github.com/${caller.user}`
		: (found.registeredTo || caller.network || 'unknown');
	console.log(who);
	console.log(`  seen        ${caller.first.slice(0, 16).replace('T', ' ')} to ${caller.last.slice(0, 16).replace('T', ' ')} UTC`);
	console.log(`  from        ${caller.country ?? 'unknown'}, ${caller.network ?? 'unknown'}`);
	if (caller.user && found.registeredTo) {
		console.log(`  registered  ${found.registeredTo}`);
	}
	if (found.hostName) {
		console.log(`  host name   ${found.hostName}`);
	}
	console.log(`  address     ${addresses.slice(0, 3).join(', ') || 'not recorded'}${addresses.length > 3 ? ` and ${addresses.length - 3} more` : ''}`);
	console.log(`  assistant   ${[...caller.clients].join(', ')}`);
	console.log(`  did         ${caller.connections} connections, ${caller.sandboxes} sandboxes, ${caller.toolCalls} tool calls, ${caller.restCalls} REST calls`
		+ (caller.refused ? `, ${caller.refused} refused by a limit` : ''));
	console.log('');
}
