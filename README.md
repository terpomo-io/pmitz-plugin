# Pmitz plugin

The [Pmitz](https://github.com/terpomo-io/pmitz) plugin for AI coding assistants, and the service behind its sandboxes. Pmitz adds subscription plans, feature access and usage limits to an application.

| Folder | What it is |
|---|---|
| [`plugins/pmitz`](plugins/pmitz) | The plugin for Claude Code and Codex: the Pmitz skill, application examples and the hosted MCP server that creates sandboxes. |
| [`mcp-server`](mcp-server) | A local MCP server for your own Pmitz server, published on npm as `@terpomosoft/pmitz-mcp`. It is separate from the plugin. |
| [`hosted-mcp`](hosted-mcp) | The service at `https://pmitz-mcp.web.app`, which gives an assistant a temporary Pmitz sandbox for development and testing. |
| [`plugins/tools`](plugins/tools) | Scripts that build the plugin archives and test the local MCP server. |

`.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` list the plugin for Claude Code and Codex.

Pmitz itself, its documentation and its issue tracker are in [terpomo-io/pmitz](https://github.com/terpomo-io/pmitz).

Licensed under the [Apache License 2.0](LICENSE). Made by [Terpomo Software](https://terpomosoft.com/).
