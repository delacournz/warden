# Hosts: drive another Mac's devices (`warden host`)

A **host** is another Mac (a desk Mac, a Mac mini over Tailscale, EC2 Mac, MacStadium, a teammate's Mac) running its own warden: its own lease store, sims, golden images and helper. The laptop's warden drives it over `ssh`. No warden account is needed.

## Set one up (a person, once per host)

| Step | Command | What happens |
|---|---|---|
| 1 | `warden host add <name> --ssh user@host[:port] [--identity <key>] [--proxy-command <cmd>] [--jump <bastion>] [--host-key 'ssh-ed25519 AAAA…'] [--json]` | First contact: pins the host key in `$WARDEN_HOME/hosts/<name>.known_hosts` (the first key seen, or `--host-key`), reads the host's warden version if it has one. Not reachable = nothing recorded |
| 2 | `warden host setup <name> [--setup-identity <key>] [--binary <file>] [--install-dir <dir>] [--authorized-keys <file>] [--golden] [--no-helper] [--json]` | With the setup key (a normal shell): installs this warden version at `~/.local/bin/warden` (no sudo; the release binary, downloaded on the laptop with `gh` and checked against `checksums.txt`, or `--binary` for a dev/local build), `doctor --fetch-helper` (`--no-helper` skips), `golden ensure` with `--golden`, then `warden host grant` of the laptop's own key (`$WARDEN_HOME/hosts/id_ed25519`, made once, comment `warden:<machineId>:<user>`). The host record switches to that key |
| 3 | `warden host doctor <name> [--json]` | Reachable, key accepted, same version, then the host's `doctor --leases` |

`warden host ls [--json]` · `warden host rm <name>` (also drops the pinned key).

## What the granted key can do

The grant is a forced command in the host's `~/.ssh/authorized_keys`: `command="<warden> __host-serve --key SHA256:…",restrict,port-forwarding <key>`. Whatever the laptop asks for arrives in `SSH_ORIGINAL_COMMAND` and runs only if allowed (as an argv, never a shell):

| Allowed | Notes |
|---|---|
| `version --json`, `ls --json`, `doctor [--leases] --json` | `doctor --fix` / `--fetch-helper` refused |
| `claim … --json` | the session selector refused; no `--ttl` = `WARDEN_REMOTE_TTL` on the host (default `90s`) |
| `heartbeat … --json`, `release … --json` | the session selector, `--all` and `--udid` refused; a lease id held by another owner refused |
| `__driver-serve --lease <id>` | the driver of the caller's own device lease, on stdio |

Anything else exits 2 (`refused: …` on stderr). The owner on the host is `{kind: "host", machineId, user}` from the grant (owner key `host:<machineId>`), never from a flag or env the laptop sends: every session on that laptop is one owner there, so `WARDEN_MAX_PER_OWNER` counts per laptop. Host leases carry no pid: they live by heartbeat + TTL only.

On the host (a person): `warden host grant --key <pub line | .pub file> [--machine <id> --user <name>] [--authorized-keys <file>] [--warden <path>] [--json]` · `warden host revoke --key <SHA256:… | pub | .pub>` · `warden host grants [--json]`.

## ssh

Every call is `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$WARDEN_HOME/hosts/<name>.known_hosts -o ForwardAgent=no -o ForwardX11=no`, keepalives every 15 s, one shared connection per host (`ControlPersist=60s`). A host with no inbound port: `--jump <bastion>` or `--proxy-command` (`cloudflared access ssh --hostname %h`, `tailscale nc %h %p`).

## Errors

| Code | Exit | Meaning |
|---|---|---|
| `HOST_UNREACHABLE` | 12 | ssh could not connect (network, sshd off, proxy / jump) |
| `HOST_AUTH` | 13 | key refused, or the host key changed (re-pin: `host add <name> --host-key …`) |
| `HOST_VERSION_SKEW` | 14 | the host runs another warden version: `warden host setup <name>` |
| `HOST_UNKNOWN` | 15 | no host by that name: `warden host ls` |

Rows 115-119 in troubleshooting.md.
