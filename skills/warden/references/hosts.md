# Hosts: drive another Mac's devices (`warden host`)

A **host** is another Mac (a desk Mac, a Mac mini over Tailscale, EC2 Mac, MacStadium, a teammate's Mac) running its own warden: its own lease store, sims, golden images and helper. The laptop's warden drives it over `ssh`. No warden account is needed.

## Set one up (a person, once per host)

| Step | Command | What happens |
|---|---|---|
| 1 | `warden host add <name> --ssh user@host[:port] [--identity <key>] [--proxy-command <cmd>] [--jump <bastion>] [--host-key 'ssh-ed25519 AAAA…'] [--json]` | First contact: pins the host key in `$WARDEN_HOME/hosts/<name>.known_hosts` (the first key seen, or `--host-key`), reads the host's warden version if it has one. Not reachable = nothing recorded |
| 2 | `warden host setup <name> [--setup-identity <key>] [--binary <file>] [--install-dir <dir>] [--authorized-keys <file>] [--golden] [--no-helper] [--json]` | With the setup key (a normal shell): installs this warden version at `~/.local/bin/warden` (no sudo; the release binary, downloaded on the laptop with `gh` and checked against `checksums.txt`, or `--binary` for a dev/local build), `doctor --fetch-helper` (`--no-helper` skips), `golden ensure` with `--golden`, then `warden host grant` of the laptop's own key (`$WARDEN_HOME/hosts/id_ed25519`, made once, comment `warden:<machineId>:<user>`). The host record switches to that key |
| 3 | `warden host doctor <name> [--json]` | Reachable, key accepted, same version, then the host's `doctor --leases` |

`warden host ls [--json]` · `warden host rm <name>` (also drops the pinned key).

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

Rows 115-123 in troubleshooting.md.
