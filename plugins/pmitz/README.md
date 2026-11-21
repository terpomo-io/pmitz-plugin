# Pmitz

Use this plugin in Claude Code or Codex to add [Pmitz](https://terpomosoft.com/pmitz/) to an application: subscription plans that decide which features a customer can use and how much of each. It covers embedded Java and the Pmitz REST API.

It includes the Pmitz skill, a Docker Compose template, runnable application examples and the `pmitz-sandbox` MCP server, which creates a Pmitz sandbox in Terpomo's cloud.

## Install from a local marketplace

Extract the Pmitz marketplace archive to a directory you can keep on disk. Run these commands from the application where you want to use the plugin, substituting the absolute path to the extracted directory containing `.claude-plugin`, `.agents` and `plugins`.

**Claude Code**

```bash
claude plugin marketplace add /absolute/path/to/pmitz-marketplace
claude plugin install pmitz@terpomo-pmitz
claude plugin details pmitz@terpomo-pmitz
```

**Codex**

```bash
codex --enable plugins plugin marketplace add /absolute/path/to/pmitz-marketplace
codex --enable plugins plugin add pmitz@terpomo-pmitz
codex --enable plugins plugin list --marketplace terpomo-pmitz
```

Start a new session after installing. If plugins are disabled in your Codex profile, launch that session with `codex --enable plugins`.

Try “Create a Pmitz sandbox with a Free plan of 3 exports and a Pro plan of 100, and show me what a Free customer can do.” Or, in an application: “Use Pmitz to give each workspace five seats. Integrate that rule into my app and verify that removing a member frees a seat.” For a server of your own, the skill includes [Docker startup instructions](skills/pmitz/references/docker-start.md).

## A sandbox: the hosted MCP

The `pmitz-sandbox` MCP server runs at `https://pmitz-mcp.web.app/mcp`. Its `pmitz_create_sandbox` tool creates a Pmitz sandbox, a real Pmitz server, in a few seconds, with no account and nothing to install, and returns a sandbox key. The other tools check access and limits, manage products and subscriptions, record usage, and export the plans.

- **It is temporary.** A sandbox is deleted 72 hours after it is created. It is for development and testing, not for production.
- **Your application can call it.** Each sandbox has a REST address, `https://pmitz-mcp.web.app/sandbox/<id>`, that follows the Pmitz REST API. Send the sandbox key in the `X-Api-Key` header.
- **You keep your plans.** `pmitz_export_plans` returns the product definitions exactly as they were created, ready to load into your own Pmitz server. Subscriptions and recorded usage are not exported.
- **What you put in a sandbox is stored by Terpomo Software** until the sandbox expires. Do not put personal or confidential information in it.

For production, run Pmitz on your own server from the Docker image.

## Your own server: the local MCP server

The plugin does not include an MCP server for your own Pmitz server. The skill works on it through the Pmitz REST API. If you want the assistant to have tools for it as well, there is a separate local MCP server, published on npm as `@terpomosoft/pmitz-mcp`. Its [README](https://github.com/terpomo-io/pmitz-plugin/tree/main/mcp-server#readme) describes how to add it and what it does.

## What the plugin needs, runs and sends

The plugin contains one skill made of instructions, reference documents, example code and a Docker Compose file, and the hosted MCP server described above. It has no hooks. It sends nothing to Terpomo Software unless the assistant uses a sandbox: then what it puts in the sandbox goes to Terpomo's hosted service.

When you ask the assistant to integrate Pmitz, the skill may have it do the following on your machine, with the tools you already have installed:

- Edit your application's source code and configuration to add the Pmitz checks.
- Run Docker Compose to start a local Pmitz server and PostgreSQL. Docker downloads the `terpomo/pmitz-remoteserver` and `postgres` images from Docker Hub.
- Run Gradle for the Java examples, which downloads the Pmitz libraries from Maven Central, or Node.js 22 for the Node example.
- Call the Pmitz server over HTTP with `curl` or your application's HTTP client. These calls send the server's API key in the `X-Api-Key` header to the Pmitz server address you configured, which is `127.0.0.1` in the bundled setup. The key is generated locally into a `.env` file you keep; it is read from the `PMITZ_API_KEY` environment variable and is not sent anywhere else.

Requirements depend on the path you choose: nothing for a sandbox, Docker with Compose v2 for a local server, Java 17 or newer with Gradle for the Java examples, and Node.js 22 for the Node example.

## Support and privacy

Questions and problems: [terpomosoft.com/contact](https://terpomosoft.com/contact/) or the [issue tracker](https://github.com/terpomo-io/pmitz-plugin/issues). Privacy policy: [terpomosoft.com/privacy](https://terpomosoft.com/privacy/). Terms of service: [terpomosoft.com/terms](https://terpomosoft.com/terms/).
