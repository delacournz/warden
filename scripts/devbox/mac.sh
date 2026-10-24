#!/usr/bin/env bash
# mac.sh - idempotent setup of a Namespace macOS devbox for warden's iOS bench (WDN-CPU 0.2).
#
# Runs ON the box, from the repo checkout, inside tmux (an ssh command longer than a few minutes is cut):
#
#   devbox exec <box> -- bash /Users/runner/workspaces/warden/scripts/devbox/mac.sh all
#
# Steps (each safe to re-run; `all` runs them in order):
#   tools       pinned bun, tmux, the GitHub Packages token for @delacournz/* (from ~/.warden-devbox.env)
#   deps        bun install
#   native      warden-simd helper: idb libraries + swift release build (packages/e2e/native/dist)
#   cli         ~/.local/bin/warden shim to this checkout (bun run cli:link)
#   frameworks  argent, agent-device (global), node for tester.army (the box's node must be >= 24.8)
#   app         lease a sim with warden and build/install the example app Release build (warden app ensure)
#   doctor      bun run bench doctor
#
# Progress lines start with "== ". Noisy commands log to ~/devbox-logs/<step>.log, tail printed on failure.
# The box has no hardware virtualization (kern.hv_support 0): the Android emulator cannot run here.
set -eo pipefail

export PATH=$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH LANG=en_US.UTF-8
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BUN_VERSION=${BUN_VERSION:-$(sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' "$REPO/package.json")}
ENV_FILE=${ENV_FILE:-$HOME/.warden-devbox.env} # `export NPM_TOKEN=…` (classic PAT, read:packages), mode 600
LOGS=$HOME/devbox-logs
mkdir -p "$LOGS"

step() { echo "== $(date +%H:%M:%S) $*"; }
quiet() {
	local name=$1
	shift
	"$@" >"$LOGS/$name.log" 2>&1 || {
		echo "!! $name failed, tail of $LOGS/$name.log:" >&2
		tail -30 "$LOGS/$name.log" >&2
		return 1
	}
}

tools() {
	step tools
	if ! command -v bun >/dev/null || [ "$(bun --version)" != "$BUN_VERSION" ]; then
		quiet bun-install bash -c "curl -fsSL https://bun.sh/install | BUN_INSTALL=\$HOME/.bun bash -s bun-v$BUN_VERSION"
	fi
	brew list tmux >/dev/null 2>&1 || quiet brew-tmux brew install -q tmux
	if [ -f "$ENV_FILE" ]; then
		chmod 600 "$ENV_FILE"
		# shellcheck disable=SC1090
		source "$ENV_FILE"
	fi
	[ -n "${NPM_TOKEN:-}" ] || echo "!! NPM_TOKEN is unset: bun install cannot fetch @delacournz/* (put 'export NPM_TOKEN=…' in $ENV_FILE)" >&2
	echo "bun $(bun --version), $(tmux -V), node $(node --version)"
}

deps() {
	step deps
	(cd "$REPO" && quiet deps bun install)
}

native() {
	step native
	(cd "$REPO" && quiet native-deps bun run --cwd packages/e2e native:deps && quiet native-build bun run --cwd packages/e2e native:build)
	"$REPO/packages/e2e/native/dist/warden-simd" --version
}

cli() {
	step cli
	(cd "$REPO" && quiet cli-link bun run cli:link)
	warden --version
}

frameworks() {
	step frameworks
	command -v argent >/dev/null && command -v agent-device >/dev/null || quiet bun-global bun add -g @swmansion/argent agent-device
	echo "argent $(argent --version 2>/dev/null | head -1), agent-device $(agent-device --version 2>/dev/null | head -1), node $(node --version) (tester.army needs ^22.22.3 || >=24.8)"
}

app() {
	step app
	cd "$REPO"
	local lease udid
	lease=$(warden claim ios --ttl 1h --label devbox-setup --json)
	udid=$(echo "$lease" | sed -n 's/.*"udid": *"\([^"]*\)".*/\1/p' | head -1)
	[ -n "$udid" ] || { echo "$lease" >&2; return 1; }
	quiet app-ensure warden app ensure ios --project apps/example --udid "$udid" --json || { warden release --mine --label devbox-setup >/dev/null; return 1; }
	tail -1 "$LOGS/app-ensure.log"
	warden release --mine --label devbox-setup --shutdown >/dev/null
}

doctor() {
	step doctor
	(cd "$REPO" && bun run bench doctor)
}

[ $# -gt 0 ] || { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
for s in "$@"; do
	case $s in
	all) tools; deps; native; cli; frameworks; app; doctor ;;
	tools | deps | native | cli | frameworks | app | doctor) "$s" ;;
	*) echo "unknown step: $s" >&2; exit 1 ;;
	esac
done
step done
