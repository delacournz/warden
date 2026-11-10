# Hosts: drive another Mac's devices (`warden host`)

A **host** is another Mac (a desk Mac, a Mac mini over Tailscale, EC2 Mac, MacStadium, a teammate's Mac) running its own warden: its own lease store, sims, golden images and helper. The laptop's warden drives it over `ssh`. No warden account is needed.

## Set one up (a person, once per host)

| Step | Command | What happens |
|---|---|---|
| 1 | `warden host add <name> --ssh user@host[:port] [--identity <key>] [--proxy-command <cmd>] [--jump <bastion>] [--host-key 'ssh-ed25519 AAAA…'] [--json]` | First contact: pins the host key in `$WARDEN_HOME/hosts/<name>.known_hosts` (the first key seen, or `--host-key`), reads the host's warden version if it has one. Not reachable = nothing recorded |
| 2 | `warden host setup <name> [--setup-identity <key>] [--binary <file>] [--install-dir <dir>] [--authorized-keys <file>] [--golden] [--no-helper] [--json]` | With the setup key (a normal shell): installs this warden version at `~/.local/bin/warden` (no sudo; the release binary, downloaded on the laptop with `gh` and checked against `checksums.txt`, or `--binary` for a dev/local build), `doctor --fetch-helper` (`--no-helper` skips), `golden ensure` with `--golden`, then `warden host grant` of the laptop's own key (`$WARDEN_HOME/hosts/id_ed25519`, made once, comment `warden:<machineId>:<user>`). The host record switches to that key |
| 3 | `warden host doctor <name> [--json]` | Reachable, key accepted, same version (any of these failing = exit 1 or its `HOST_*` code), then the host's `doctor --leases`: drift there (stale rows, orphan claim keys) is a `warn` line with the finding kinds (`checks[].warning: true`, still exit 0); fix it on the host with `warden doctor --leases --fix` |

`warden host ls [--json]` · `warden host rm <name>` (also drops the pinned key).

## A machine with no inbound ssh: CI runner, fresh hosted Mac (`host attach`)

| Where | Command | What happens |
|---|---|---|
| laptop | `warden host key [--json]` | Prints this laptop's warden key (made on first use) → `{ publicKey, identity }` |
| the machine | `warden host attach --grant <key line \| .pub> [--as <name>] [--listen <addr>] [--port <p>] [--tailscale \| --advertise <addr> \| --jump <user@bastion> --jump-port <p> [--jump-identity <key>]] [--for <duration>] [--json]` | No sudo: a user-level sshd (`/usr/sbin/sshd`, keys only, no root/agent/X11; `$WARDEN_HOME/attach/`) whose only key is the laptop's, through the forced `__host-serve`. `--tailscale` listens on `tailscale ip -4`; `--advertise` names the address the laptop dials (a userspace tailscaled forwards to loopback); `--jump` dials out `ssh -N -R <jump-port>:127.0.0.1:<port>`. Prints the laptop's `warden host add …` line (JSON: `{ name, port, hostKey, add }`), then a live log on stderr while it holds: the laptop's first connection, each command it runs (`heartbeat` is quiet), refused commands, and any other or refused key. Holds until Ctrl-C / SIGTERM / `--for`, then stops sshd |
| laptop | the printed `warden host add <name> --ssh <user>@<addr>:<port> [--jump …] --host-key '…' --granted` | `--granted`: the host already grants this laptop's key, so it is used at once and no `host setup` is needed. Then `warden host doctor <name>` |

Example GitHub Actions workflow (macOS runner, userspace tailscaled, `TS_AUTHKEY` secret): `.github/workflows/remote-host.yml` in the warden repo.

## No inbound at all: through warden-api (`host uplink`, `host add --cloud`)

| Where | Command | What happens |
|---|---|---|
| the machine | `WARDEN_HOST_TOKEN=<t> warden host uplink [--api <url>] [--token-file <file>]` | One outbound WebSocket to warden-api (`--api`, else `$WARDEN_API_URL`, else the hosted one); the token comes from `--token-file` or `$WARDEN_HOST_TOKEN`, never a flag value. Each command a laptop sends runs through the same forced `__host-serve`, allowlist and TTL leases as ssh. Redials 1 s → 30 s; holds until Ctrl-C / SIGTERM, or exits 1 when warden-api ends it for good (token refused or revoked, another uplink for the host took over, hosted session over) |
| laptop | `warden host add <name> --cloud [--host-id <id>] [--json]` | Uses this laptop's `warden login` session (account + org pinned on the record): picks `--host-id`, else the account's host called `<name>`, else its only one. Records it with the hosted session's end (`expiresAt`) and reads its warden if it is online. Can't go with `--ssh`, `--identity`, `--proxy-command`, `--jump`, `--host-key`, `--granted` |

Then `claim --host`, `ui`, `app ensure`, `host run`, `host fetch` and `host doctor` work as over ssh. Not yet over the relay: `warden dev --host` (no port forward for Metro; row 126). A hosted Mac's leases are capped at its `expiresAt` and end `LEASE_LOST` `host_expired`. A relay failure is exit 255 like ssh's: `HOST_AUTH` for a refused session, else `HOST_UNREACHABLE` (`relay: HOST_OFFLINE` = no uplink).

## Claim on a host (`claim --host`)

`warden claim ios|android --host <name> [--profile <slug>] [--runtime <r>] [--count <n>] [--max <n>] [--wait <d> | --no-wait] [--priority <n>] [--label <x>] [--ttl <d>] [--idempotency-key <k>] [--json]`

→ `{ leases: [{ leaseId, host, remoteLeaseId, platform, udid, name, action, ttlMs, expiresAt?, label? }], udids }`

| Step | What happens |
|---|---|
| claim | The host's warden runs `claim <platform> --json --idempotency-key <key> --ttl <WARDEN_REMOTE_TTL, default 90s>` with the flags above: allocation, the boot queue and capacity are the host's. Its wait lines are printed here as `<host>: …` |
| unreachable | Tried 3 times with the same key, so a claim that landed before the link dropped comes back, not twice. Then exit 12 `HOST_UNREACHABLE`. `HOST_AUTH` is not retried |
| host refused | Its claim error keeps its code and exit (`NO_DEVICE` 5, `NO_CAPACITY` 7, …), prefixed `<host>: ` |
| lease | One local `host-device` lease per device, owned by the caller, `--ttl` as usual (default 30m). A hosted Mac's session end caps it (`expiresAt`) |
| keepalive | A detached `warden __host-keepalive --host <name>` (one per host) renews the host leases every 30 s while the local ones live |

`warden heartbeat` / `warden release [--shutdown]` on a host lease forward to the host (`heartbeat <remote ids> --json`, `release <remote ids> --json [--shutdown]`). An unreachable host on release is a note: the lease is gone here, and the host's expires within its TTL. `warden ls` shows a `HOST` column when there are host leases; `warden ls --hosts` lists only them. `warden check --udid <udid>` knows host leases. `warden host rm <name>` refuses while it backs leases.

`--host` can't go with `--remote`, `--view`, `--physical`, `--serial` or `--udid` (exit 1).

How a host lease ends without a release (`host_lost` in `warden events`; a `warden run` / `warden dev` holding it stops with `LEASE_LOST`, exit 11):

| `reason` | When |
|---|---|
| `unreachable` | 3 renewals in a row could not reach the host (≈ 90 s) |
| `remote_gone` | the host no longer holds the lease (its gc expired it, or a person released it there) |
| `host_expired` | a hosted Mac's session ended (`expiresAt`); heartbeats warn from 10 min before. Renewing is a person's call, never automatic |

A laptop that vanishes (sleep, crash, network) holds the host's device for at most its TTL: the host's lease has no pid, only heartbeat + TTL, and the host's gc reaps it.

## Drive a host's device (`warden ui`)

After `claim --host`, `warden ui` picks the host lease like any other (the only one held, `--lease <id>`, or `--udid <udid>`). The driver runs on the host (`<host's warden> __driver-serve --lease <remote id>` over its own ssh connection) and every call crosses ssh.

| Works on a host device | Not yet (exit 1 `usage`: `warden ui <verb> does not drive a host's device`) |
|---|---|
| `status`, `open <bundleId\|url>`, `snapshot`, `find`, `get`, `is`, `wait`, `press`, `tap`, `fill`, `type`, `key`, `scroll`, `gesture …`, `close [--release]` | `screen …` (screenshot, rotate, video, appearance), `home`, `back`, `alert`, conditions (`net`, `location`, `clock`, …), devtools (`eval`, `logs`, `tree`, …), `record …`, `bench` |

Put the app on it first: `warden app ensure --lease <host lease id> [--kind <dev|simulator|release>] [--json]` (or `--udid <udid>`) resolves the build here (cache, EAS or a local build, as for a local device), sends it to the host once per content hash (`$WARDEN_HOME/uploads/<sha256>/<name>` there; unused for 7 days = pruned), and installs that copy through the host's driver → `{ appPath, hash, source, installed: true, host, hostPath }`. `--install-mode` / `--reset-keychain` are refused there. `open --metro`, `--kind` and `--project` are refused on a host device: `app ensure` it, then open it by bundle id.

`warden e2e` / `warden batch` on a host's devices: not yet. `close --release` releases the lease on the host too. Someone else's host lease is `device_foreign` (exit 2).

A person watches or drives it: `warden view [<host lease id>] [--watch] [--json]` serves a page on `127.0.0.1` (a random token path; only that host and origin) and opens the browser (not with `--json`, which prints `{ leaseId, host, url, watch }`). Frames come from the driver's screenshot (half scale, one at a time, a few per second); a click is a tap, a drag a swipe, keys type (Enter / Backspace / Tab / arrows as keys, Esc = home). `--watch` refuses input. Input needs portrait (rotated: watch only, use `warden ui`). Holds until Ctrl-C (exit 0, the lease stays yours) or the lease ends (exit 11). `--detach` is for hosted devices only.

## Dev client on a host's device (`warden dev --host`)

`warden dev [ios|android] --host <name> [--port <from:span>] [--no-open] [--json] [-- <expo start args>]`: claims a device on the host (like `claim --host`; `--profile`, `--runtime`, `--ttl`, `--label`, `--wait`, `--priority` pass on), leases a Metro port **here** and starts Metro here, sends + installs the dev build there (as `app ensure`, while Metro warms up), then opens one `ssh -R <host port>:127.0.0.1:<port>` so Metro answers on the host's loopback, and points the dev client at it (iOS `http://127.0.0.1:<host port>`, Android `http://10.0.2.2:<host port>`). The host leases its end of the forward (`port claim` there, from 8091) and holds it only while that ssh lives. Devtools and fast refresh ride the same port.

- Plain output only (no dashboard). `--json` prints one line `{ host, udid, leaseId, port, remotePort, metroUrl }` once the dev client is pointed.
- Ends on Ctrl-C (exit 0), Metro exiting (its code), the tunnel dropping (1) or the host lease lost (`LEASE_LOST`, 1); always stops Metro, closes the tunnel and releases both leases (here and on the host).
- Refused with `--host`: `--udid`, `--lease`, `--install-mode`, `--reset-keychain`, `--clean`, `--hud`, `--devtools`, `--physical`; a bare React Native app (Expo dev clients only).

## Run a warden command there (`host run`, `--host`)

`warden host run <name> -- <warden command…>` (short: `warden --host <name> <command…>`) runs one allowed command with the host's warden over ssh (a TTY when this terminal is one): its output, its exit code. ssh's own failure is `HOST_UNREACHABLE` / `HOST_AUTH`; a command the host refuses exits 2.

| Runs there | Notes |
|---|---|
| `perf <sub> …` (every subcommand) | device-bound ones act on your own lease only: a local host lease id after `--lease` becomes the host's; no `--lease` = your only device on that host (none or several → error). `--udid`, `--serial`, `--claim`, `--force`, `--allow-mutate-foreign` refused. `report` / `query` / `diff` / `ls` / `tools` take no lease |
| `golden ls`, `golden ensure` | `golden prune` refused |
| `builds ls` | `builds rm` / `prune` / `import` refused |
| `capacity`, `queue` | the host's budget and boot queue |

`warden e2e` / `warden batch` are not run this way (they would run code on the host).

Evidence back: `warden host fetch <name> perf <session id> [--out <dir>] [--json]` copies the session's directory (report, metrics, traces) into this machine's perf dir (`$WARDEN_HOME/perf/<id>`, so `warden perf report <id>` / `query` / `diff` read it here) or `--out`. Fetch before you release: the host sends a session only to whoever holds its device → `{ host, session, dir }`.

A spec process reaches a host's device the same way when `WARDEN_HOST` (its name) and `WARDEN_HOST_DRIVER` (JSON argv of the ssh command that serves the driver) are set.

## What the granted key can do

The grant is a forced command in the host's `~/.ssh/authorized_keys`: `command="<warden> __host-serve --key SHA256:…",restrict,port-forwarding <key>`. Whatever the laptop asks for arrives in `SSH_ORIGINAL_COMMAND` and runs only if allowed (as an argv, never a shell):

| Allowed | Notes |
|---|---|
| `version --json`, `ls --json`, `doctor [--leases] --json` | `doctor --fix` / `--fetch-helper` refused |
| `claim … --json` | the session selector refused; no `--ttl` = `WARDEN_REMOTE_TTL` on the host (default `90s`) |
| `heartbeat … --json`, `release … --json` | the session selector, `--all` and `--udid` refused; a lease id held by another owner refused |
| `__driver-serve --lease <id>` | the driver of the caller's own device lease, on stdio |
| `__host-recv … --json` | an app build as a tar on stdin, named by its content hash: unpacked into the host's uploads only if its content matches; `app ensure` asks first whether the host has it |
| `port claim … --json`, `port release … --json`, `port ls --json` | the host end of `dev --host`'s forward; `port release --force` refused |
| `perf <sub>`, `golden ls\|ensure`, `builds ls`, `capacity`, `queue` (text or `--json`) | `host run`; see above |
| `__host-send --perf <id>` | a perf session's files as a tar, only to the holder of its device (`host fetch`) |
| `__host-tunnel … --json` | the far end of `dev --host`'s `ssh -R`: checks Metro answers through it, holds the caller's port lease until the ssh closes, then releases it |

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

Rows 115-126 in troubleshooting.md.
