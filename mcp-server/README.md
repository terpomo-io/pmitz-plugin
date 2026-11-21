# Pmitz MCP server (local)

A local MCP server that lets a coding assistant read and change your own [Pmitz](https://github.com/terpomo-io/pmitz) server through its REST API. It needs Node.js 18 or newer and has no dependencies.

```bash
codex mcp add pmitz-local -- npx -y @terpomosoft/pmitz-mcp@0.1.1
claude mcp add pmitz-local -- npx -y @terpomosoft/pmitz-mcp@0.1.1
```

Set these in the environment the assistant starts from:

| Variable | Meaning |
|---|---|
| `PMITZ_BASE_URL` | Base URL of your Pmitz server, for example `http://127.0.0.1:8080` |
| `PMITZ_API_KEY` | API key of that server. It is sent only to that URL, in the `X-Api-Key` header. |
| `PMITZ_MCP_READ_ONLY` | Optional. Set to `true` to offer only the tools that read. |

The server offers eleven tools: it checks entitlements and limits, reads subscriptions, creates and removes products and subscriptions, and records or reduces usage. A Pmitz API key has full authority over its server, so connect a development server, or use read-only mode.

| Tool | What it does |
|---|---|
| `pmitz_connection_status` | Shows the configured server, whether it answers, and whether writes are enabled |
| `pmitz_verify_entitlement` | Checks whether a subscription, user or group may use a feature |
| `pmitz_check_limits` | Previews whether requested units fit, without recording anything |
| `pmitz_get_remaining_limits` | Reads the remaining units of a feature's limits |
| `pmitz_find_subscription` | Reads a subscription's status and plans |
| `pmitz_create_product`, `pmitz_remove_product` | Creates or removes a product definition |
| `pmitz_create_subscription`, `pmitz_update_subscription_status` | Creates a subscription or changes its status |
| `pmitz_record_usage`, `pmitz_reduce_usage` | Records or subtracts usage |

The first five tools only read. The others change the server. Claude Code and Codex ask you before running a tool that changes something. The assistant cannot change the settings, the destination or the key through a tool call.

The server runs as a Node.js process on your machine. It makes HTTP requests only to the Pmitz server URL you configured, and sends the API key only to that URL. It does not log the key or return it in tool results.

The [Pmitz plugin](https://github.com/terpomo-io/pmitz-plugin/tree/main/plugins/pmitz) for Claude Code and Codex is separate: it has the Pmitz skill and a hosted MCP server that creates a Pmitz sandbox for development and testing. This local server is not part of it.
