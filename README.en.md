# ccserver

**Languages:** [日本語](README.md) | [English](README.en.md) | [Français](README.fr.md)

> **Context & Coordination Server**: a web server for managing context in AI CLI sessions and coordinating multiple agents.

> **Note:** This is an unofficial third-party tool. It is not affiliated with, officially supported by, or endorsed by the vendors or projects of the supported AI CLIs.

ccserver is a web frontend for launching and managing multiple AI CLIs in a selected directory: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [opencode](https://opencode.ai/), [GitHub Copilot CLI](https://github.com/github/copilot-cli), and [OpenAI Codex CLI](https://developers.openai.com/codex/cli/). Select a folder like in VS Code and work in a browser-based terminal.

## Architecture

```
Browser (xterm.js) <── WebSocket ──> Fastify <── node-pty ──> AI CLI
                  <── HTTP REST ──>       (directory API)
```

| Layer | Stack |
|---|---|
| Frontend | React 19 + Vite + xterm.js |
| Backend | Node.js + Fastify + @fastify/websocket + node-pty |

## Requirements

- Node.js >= 22 and npm >= 9
- A C++ compiler for building `node-pty` (`base-devel` on Arch, `build-essential` on Ubuntu)
- At least one supported AI CLI installed on the server. Only installed CLIs can be selected.
- Optional: `bwrap` (bubblewrap), rootless Docker, `rootlesskit`, `uidmap`, and `slirp4netns` for the full sandbox features

Install the CLIs separately by following their official documentation. Claude Code is also used by the Usage feature; opencode, Copilot CLI, and Codex can be used independently when Claude Code is not installed.

## Installation and Startup

```bash
git clone <repo-url> ccserver
cd ccserver
npm install
```

### Development

Run these commands in two terminals:

```bash
# Backend (port 3001)
npm run dev:server

# Frontend (port 5173)
npm run dev:client
```

Open <http://localhost:5173>.

### Production

```bash
npm run build --workspace=client
NODE_ENV=production node server/index.js
```

Open <http://localhost:3001>. Change the port with `PORT`, for example `PORT=8080 NODE_ENV=production node server/index.js`.

## Usage

1. Select a folder in the directory browser. Single-click navigates into a folder; double-click launches the default application in that folder.
2. Use the terminal in the browser.
3. Use the launch menu to choose Claude Code, opencode, GitHub Copilot, or OpenAI Codex, and optionally enable sandboxing, GPG signing, or SSH-agent forwarding.

The selected application and launch options are remembered in the browser's `localStorage`. Combo sessions can run two workers and an orchestrator. Combo sessions support Claude Code and opencode only, because Copilot CLI cannot receive ccserver's MCP tools through CLI arguments or environment variables.

Scheduled prompts can be created with the clock button in the terminal header. They are persisted on disk in `.scheduled-prompts.json` and can fire after the browser is closed or the server restarts. The time is interpreted in the server's timezone.

## MCP Tools

- `ccserver-notify` provides `notify`, `subscribe`, `unsubscribe`, and `list_subscriptions`. Notifications can be delivered to a Discord webhook and runtime webhook subscriptions. Configure them with `notify.discordWebhook`, `notify.subscriptions`, `CCSERVER_DISCORD_WEBHOOK`, or `CCSERVER_HOSTNAME`.
- `ccserver-usage` provides `get_usage` for Claude Code usage snapshots. It is injected only into Claude sessions and only when `usageMcp: true` is explicitly enabled.
- Combo orchestrators can use control tools such as `send_input`, `wait_for_handoff`, and `read_output` to coordinate workers. Keep `send_input` instructions short and on one line, then verify the worker output.

## Sandbox

Choosing **Launch in sandbox** starts the CLI under `bwrap`. Only the selected project and explicitly allowed configuration directories are visible; neighboring projects are not exposed. When available, rootless Docker runs inside the sandbox as well.

Sandbox HOME directories are persistent per project by default, under `~/.local/share/ccserver-sandbox/home/`. Set `persistentHome: false` for a fresh temporary HOME on every session. Persistent HOME directories can contain tools, caches, and shell configuration, so treat them as writable state belonging to that project.

For Docker support on Debian/Ubuntu:

```bash
sudo apt install uidmap slirp4netns
```

GPG forwarding, SSH-agent forwarding, and the git/`gh` broker are independent options. SSH-agent forwarding gives every process in the sandbox access to the forwarded agent, so leave it disabled unless an SSH remote or direct SSH access is required.

## Configuration

```bash
cp server/sandbox.config.example.json server/sandbox.config.json
# Optional alternate path:
# CCSERVER_SANDBOX_CONFIG=/path/to/config.json
```

Example:

```json
{
  "docker": true,
  "persistentHome": true,
  "gpg": false,
  "sshAgent": false,
  "gitBroker": true,
  "forceSandbox": false,
  "defaultApp": "claude",
  "showUsage": true,
  "usageMcp": false,
  "notify": { "discordWebhook": "", "subscriptions": [] },
  "binds": [],
  "env": {}
}
```

Important options include `docker`, `persistentHome`, `gpg`, `sshAgent`, `gitBroker`, `forceSandbox`, `defaultApp`, `showUsage`, `usageMcp`, `binds`, and `env`. See the Japanese README for the complete option reference and security limitations.

## API

Set `CCSERVER_TOKEN` to protect all `/api` and `/ws` requests. Clients may provide `?token=<TOKEN>` or `Authorization: Bearer <TOKEN>`.

```bash
CCSERVER_TOKEN=some-secret NODE_ENV=production node server/index.js
```

Available REST endpoints include:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dirs?path=<path>&showHidden=1` | List directory contents |
| GET | `/api/dirs/home` | Get home directory and available CLIs |
| POST | `/api/dirs` | Create a folder |
| GET / DELETE | `/api/sessions[/:id]` | List or stop sessions |
| GET / POST | `/api/files` | Download or upload files |
| GET | `/api/system-stats` | CPU, memory, temperature, GPU, and storage stats |
| GET | `/api/usage?force=1` | Claude Code usage snapshot |

Terminal I/O and session management use the WebSocket endpoint `/ws/terminal`.

## Running with systemd

Build the client, then install the included unit file:

```bash
npm run build --workspace=client
mkdir -p ~/.config/systemd/user
cp docs/ccserver.service ~/.config/systemd/user/ccserver.service
systemctl --user daemon-reload
systemctl --user enable --now ccserver
systemctl --user status ccserver
```

## HTTPS with Tailscale Serve

After ccserver is running, expose port 3001 to your Tailnet:

```bash
sudo tailscale serve --bg 3001
tailscale serve status
```

## License

MIT
