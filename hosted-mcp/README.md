# Pmitz hosted MCP

The service behind `https://pmitz-mcp.web.app`. It gives an AI assistant a Pmitz sandbox, a temporary Pmitz server with no account, so someone can develop and test plans, feature access and usage limits before installing anything.

## What it does

- **`POST /mcp`** is an MCP server over Streamable HTTP, with no sign-in. `pmitz_create_sandbox` creates a sandbox and returns its key. The other Pmitz tools are the ones of the local MCP server in [`plugins/pmitz/server/pmitz-mcp.mjs`](../plugins/pmitz/server/pmitz-mcp.mjs), with the sandbox key added, plus `pmitz_sandbox_status` and `pmitz_export_plans`.
- **`/sandbox/<id>/...`** is the Pmitz REST API of one sandbox, for the developer's application. The sandbox key goes in the `X-Api-Key` header.
- A sandbox is deleted 72 hours after it is created, or 30 days for a user who signs in with GitHub, which is optional. It is for development and testing, not for production.

## How it works

One real Pmitz server runs next to the gateway. Each sandbox is a private slice of it: the gateway prefixes the product, subscription and subject IDs of a sandbox with its ID, and removes the prefix from every answer, so sandboxes cannot see each other.

Pmitz keeps its catalog in memory, so the gateway stores every product definition of a sandbox and sends it again after the Pmitz process restarts. That stored copy is also what `pmitz_export_plans` returns.

There are no accounts: the optional GitHub sign-in only records who keeps a sandbox. Product definitions, subscriptions and usage are kept in Pmitz's own form, so a sandbox can be moved by replaying them through the Pmitz API.

Limits, in `server.mjs`: 10 products and 500 subscriptions per sandbox, 120 requests a minute per sandbox, 64 KB per request, and a cap on new sandboxes per hour.

## Run and test it locally

```bash
cd hosted-mcp
cp .env.example .env          # fill in two random values
docker compose up -d --wait   # Pmitz and PostgreSQL
npm install
set -a; . ./.env; set +a
export DATABASE_URL="postgres://pmitz:${POSTGRES_PASSWORD}@127.0.0.1:15432/pmitz"
PORT=18090 PUBLIC_URL=http://127.0.0.1:18090 PMITZ_INTERNAL_URL=http://127.0.0.1:18080 \
  OPENAI_APPS_CHALLENGE=test-token SWEEP_SECONDS=1 node server.mjs &
GATEWAY_URL=http://127.0.0.1:18090 RESTART_PMITZ="docker restart pmitz-hosted-pmitz-1 && sleep 25" node test.mjs
```

The test covers the MCP surface, the REST surface, isolation between sandboxes, a restart of Pmitz, the limits against abuse, expiry and clean-up. Against the deployed service, `LIVE=1 GATEWAY_URL=https://pmitz-mcp.web.app node test.mjs` runs the parts that need no database access.

## Usage log

The gateway writes one JSON line per event to standard output, which Cloud Run stores as a structured log entry under `jsonPayload.usage`:

| `event` | When | Fields |
|---|---|---|
| `mcp_connect` | An assistant opens an MCP connection | `clientName`, `clientVersion` |
| `sandbox_created` | A sandbox is created | `sandbox` |
| `tool_call` | A tool is called | `tool`, `outcome` (`ok`, `refused` or `error`) |
| `rest_call` | An application calls the REST address of a sandbox | `sandbox`, `method`, `resource`, `status` |
| `rate_limited` | A request is refused by a limit | |
| `signed_in` | A user signs in with GitHub to keep a sandbox | `sandbox`, `userName`, `company`, `firstTime` |

Every entry also has:

- `client`: the kind of assistant, read from its User-Agent (`Claude`, `Codex`, `ChatGPT` or the program's name).
- `via`: how the request arrived (`hosting`, `direct`, `unrecognised` or `local`, explained under Monitoring).
- `address`: the caller's IP address.
- `network`: the owner of the network that address belongs to, for example `AS15169 GOOGLE - Google LLC`. It tells a cloud provider from a company or a home connection.
- `country`: the country that network is registered in.
- `caller`: a keyed hash of the address and the date, a short value to count distinct callers of one day.

`network` and `country` come from the public-domain tables of [iptoasn.com](https://iptoasn.com), which the gateway downloads at start and once a day and searches in memory. No address is sent to anyone. Until the tables are loaded, and for an address with no public owner, both are `unknown`.

Every entry about a sandbox whose user signed in also has `user`, the GitHub username.

The log never holds the content of a request, a sandbox key, or an identifier chosen by the developer. `test.mjs` checks that when `GATEWAY_LOG` names the file the gateway's output was redirected to. Cloud Logging keeps the entries for 30 days.

### Who uses it

```bash
node who.mjs        # the last 7 days; `node who.mjs 30` for 30
```

prints one block per caller: who it is, when it was seen, from where, with which assistant, and what it did. A signed-in caller is shown by GitHub username, name and company. Any other caller is shown by who its address is registered to. The network in the log is often an internet provider; the internet registries (ARIN, RIPE and the others) also record who each block was assigned to, which can be the provider's customer, a company. `who.mjs` asks them, and the DNS for the host name. It runs on your machine with `gcloud` signed in, not in the service: the registries limit requests per sender, and the service shares its outgoing addresses with other Google Cloud customers.

To read the raw log:

```bash
gcloud logging read 'resource.labels.service_name="pmitz-mcp" AND jsonPayload.usage.event="sandbox_created"' \
  --project terpomo-pmitz-mcp --freshness 7d --format 'value(timestamp, jsonPayload.usage.client, jsonPayload.usage.address, jsonPayload.usage.country, jsonPayload.usage.network)'
```

## Sign-in with GitHub (optional)

A sandbox never needs a sign-in. When the gateway is given the client ID of a GitHub OAuth app in `GITHUB_CLIENT_ID`, it also offers the tool `pmitz_keep_sandbox`: a user who signs in with GitHub keeps their sandbox for 30 days instead of 72 hours, and the usage log then names them. Without `GITHUB_CLIENT_ID` the tool is not listed and nothing else changes.

An assistant has no browser of its own, so this is GitHub's device flow. The first call of the tool returns GitHub's address and a short code for the user to enter in their own browser; the second call, once they have, signs them in. [`sign-in.mjs`](sign-in.mjs) holds it.

- The gateway asks GitHub for no permission. It reads the public profile (username, name, company), stores it in `gateway.account`, and does not keep GitHub's token. It needs no secret of the OAuth app.
- The sandbox is recorded under its user (`gateway.sandbox.owner_github_id`). One account keeps at most five sandboxes.
- The OAuth app needs "Enable Device Flow" ticked. Its callback address is not used; give it the service's address.

`node test-sign-in.mjs` tests it against a stand-in for GitHub, with the same local stack as `test.mjs`.

To see who signed in:

```sql
SELECT login, name, company, first_seen, last_seen FROM gateway.account ORDER BY last_seen DESC;
```

## Monitoring

Set up in the Google Cloud project `terpomo-pmitz-mcp`, from the files in [`monitoring/`](monitoring):

- **Health check.** `Pmitz sandbox server` calls `https://pmitz-mcp.web.app/health` every minute from several regions.
- **Alerts**, sent by email: `alert-down.json` when the health check fails from more than one region for two minutes, `alert-abuse.json` when more than 200 requests are refused by a limit within five minutes, and `alert-unrecognised.json` when more than 20 connections in an hour name Firebase Hosting without coming from a machine of Google's own.
- **Counters** built from the usage log, one file each: `pmitz_sandboxes_created`, `pmitz_mcp_connects`, `pmitz_tool_calls`, `pmitz_rest_calls`, `pmitz_rate_limited` and `pmitz_unrecognised_senders`.
- **Dashboard** `Pmitz sandbox service` (`dashboard.json`): the counters by assistant, tool and outcome, all requests by response class, response time and the health check.

To recreate them: `gcloud logging metrics create NAME --config-from-file monitoring/NAME.yaml`, `gcloud alpha monitoring policies create --policy-from-file monitoring/alert-down.json`, and `gcloud monitoring dashboards create --config-from-file monitoring/dashboard.json`.

The number of distinct callers is not a counter. Read it from the usage log, for example the distinct `caller` values of `sandbox_created` for one day.

### Whose address a request is counted under

The limits per address and the `caller` of the usage log need the caller's address, and a caller must not be able to choose it.

- Google's front end appends the address of whoever connected to it as the last entry of `X-Forwarded-For`. A caller cannot change that entry.
- Through `pmitz-mcp.web.app` that sender is a Firebase Hosting machine. Hosting discards any `X-Forwarded-For` the caller sent and puts the caller's address just before its own. The entry before the last is the caller (`via: hosting`).
- Through the service's own `run.app` address the sender is the caller, and the earlier entries are whatever the caller chose to send. The last entry is the caller (`via: direct`).
- The entry before the last is believed only when the request names Firebase Hosting and the last entry is a machine of Google's own: in Google's published list `goog.json` and not in `cloud.json`, the ranges its cloud customers use. The lists are loaded at start and once a day; six ranges where Hosting was seen are built in for when they cannot be loaded.
- A request that names Firebase Hosting but does not come from such a machine is counted under its sender (`via: unrecognised`). That is either a forged request or a Hosting range missing from the lists; the alert in `alert-unrecognised.json` tells which by its volume.

`test.mjs` sends each of these cases. Switching the `run.app` address off (`--no-default-url`) or making the service private both cut Firebase Hosting off as well; that was tried on a throwaway service on 2026-11-23.

What is left: someone who can relay a request through another Google service that sends from Google's own machines and lets them set `X-Forwarded-For` and `Via`. The limit on new sandboxes per hour for the whole service applies to them like to everyone.

## Deployment

It runs in the Google Cloud project `terpomo-pmitz-mcp` of the terpomosoft.com organization:

- Cloud Run service `pmitz-mcp` in `us-central1`, defined in [`service.yaml`](service.yaml): the gateway, the Pmitz server image and the Cloud SQL proxy in one instance.
- Cloud SQL for PostgreSQL instance `pmitz-instant`, used by both Pmitz and the gateway.
- Secrets `pmitz-internal-key`, `pmitz-db-password` and `pmitz-database-url` in Secret Manager.
- Firebase Hosting site `pmitz-mcp`, which forwards every request to the Cloud Run service and provides the `pmitz-mcp.web.app` address.

To release a change, build the image from the repository root and replace the service:

```bash
gcloud builds submit --config hosted-mcp/cloudbuild.yaml .
gcloud run services replace hosted-mcp/service.yaml --region us-central1
```

`OPENAI_APPS_CHALLENGE` holds the token OpenAI asks for when it verifies the domain; the service answers it at `/.well-known/openai-apps-challenge`.

One copy of the service is kept running (`autoscaling.knative.dev/minScale: "1"` in `service.yaml`), because a start from zero takes about 20 seconds. A new revision still takes that long to start.
