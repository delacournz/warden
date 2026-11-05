# warden-stream

The device stream publisher (plan WDN-STRM, STRM-4). Reads H.264 access units from the `warden-simd` helper's stream socket (or a file) and publishes them over WebRTC. Signalling is NDJSON on stdio, so the caller (`warden __device-stream`, STRM-5) relays it over the channel it already authenticates (ssh stdio, the relay). Not shipped yet: the binary is not staged into `@delacour/warden-darwin-*` (see Packaging).

## Layout

| File | What |
|---|---|
| `src/signal.rs` | the stdio protocol: `Out` (stdout) and `In` (stdin), `serde(tag = "t")` |
| `src/framing.rs` | socket framing parser (incremental), Annex-B → access units, `rtp_timestamp` |
| `src/ice.rs` | `--ice auto\|lan\|turn`, host addresses (Tailscale `utun*` kept), ICE servers, acceptance waits |
| `src/source.rs` | `--au-socket` reader / `--au-file` replay, backlog cut (`BACKLOG` = 4) |
| `src/publisher.rs` | the peer connection: trickle, hold until connected, PLI/NACK, data channels, stats |
| `src/stats.rs` | the `stats` line from our counters + the peer connection's report |
| `src/testpeer.rs` | an answering peer + `Session` harness for tests and benches; the binary never uses it |
| `src/args.rs`, `src/main.rs` | command line, stdio wiring, stderr logger |
| `tests/loopback.rs` | publisher → test peer, fixture at 60 fps, byte-identical; data channels; PLI; close |
| `tests/binary.rs` | the real binary over its stdin/stdout |
| `tests/fixtures/fixture.h264` | 120 pictures, 320×640, Constrained Baseline 3.1, one IDR (`ffmpeg -f lavfi -i testsrc=size=320x640:rate=60 -t 2 -pix_fmt yuv420p -c:v libx264 -profile:v baseline -bf 0 -g 120 -f h264`) |

## Command line

```
warden-stream (--au-socket <path> | --au-file <path> [--fps 60] [--loop])
              [--ice auto|lan|turn] [--ice-servers <json>] [--udp-addr <ip:port>]... [--stats-ms 1000]
```

- `--au-socket`: connect to the helper's socket (`stream.start` → `{path}`); retried for 5 s while the helper starts.
- `--au-file`: Annex-B (split into access units, pts at `--fps`) or the socket framing (pts kept). Replay starts on the first keyframe request, i.e. when the peer connects.
- `--ice-servers`: the `iceServers` array, or the whole `{"iceServers": [...]}` the credentials endpoint returns; `urls` may be a string or an array.
- `--udp-addr`: bind exactly these (tests use `127.0.0.1:0`); default one ephemeral socket per host address.
- `--whip <url>`: one `error` line `UNSUPPORTED`, exit 2.
- Logs: stderr only, `WARDEN_STREAM_LOG=error|warn|info|debug|off` (default `warn`). Stdout carries the protocol and nothing else.
- Exit: 0 after `close` or stdin EOF; 1 when the source or the connection failed (an `error` line or state `failed` was written); 2 usage / unsupported.

## Stdio protocol

One JSON object per line, UTF-8, `\n`-terminated, tagged by `t`. Candidate fields use the browser's names, so a line can go straight to `RTCPeerConnection.addIceCandidate`.

### stdout (publisher → caller)

| `t` | Fields | When |
|---|---|---|
| `offer` | `sdp` | once, first line, as soon as the local description is set |
| `candidate` | `candidate`, `sdpMid`?, `sdpMLineIndex`? | each local candidate as it is gathered (never before `offer`) |
| `end-of-candidates` | | gathering complete |
| `state` | `state`: `new` `connecting` `connected` `disconnected` `failed` `closed` | each peer connection state change |
| `keyframe-request` | `reason`: `connected` \| `pli` \| `drop` | ask the encoder for an IDR: send `stream.keyframe` to the helper |
| `input` | `channel`: `input` \| `input-moves`, `data` | each data channel text message, verbatim (binary messages are dropped) |
| `stats` | see below | every `--stats-ms` |
| `error` | `code`: `USAGE` `UNSUPPORTED` `SOURCE` `RTC` `SIGNAL`, `message` | `SIGNAL` (a bad stdin line) is not fatal; the others end the process |

`stats` fields (rates over the last interval, the rest totals since start): `fps`, `bitrate` (RTP bits/s), `rttMs`? (selected pair), `packetsSent`, `packetsLost` (receiver reports), `nacks`, `plis`, `unitsSent`, `unitsDropped` (before connect, cut backlog, waiting for a keyframe), `path`? (`host` `srflx` `prflx` `relay`: the selected pair's local candidate), `network`? (`loopback` `lan` `tailnet` `public`: its remote address), `relayedBytes` (bytes sent on the selected pair while it was `relay`: the STRM-8 metering number), `bytesSent`.

### stdin (caller → publisher)

| `t` | Fields |
|---|---|
| `answer` | `sdp` |
| `candidate` | `candidate`, `sdpMid`?, `sdpMLineIndex`? (an empty `candidate` is ignored) |
| `end-of-candidates` | |
| `close` | |

Remote candidates that arrive before `answer` are held and applied after it. Stdin EOF closes like `close`.

### Example

```
→ {"t":"offer","sdp":"v=0\r\n…"}
→ {"t":"candidate","candidate":"candidate:2693830880 1 udp 2130706431 100.101.1.2 50123 typ host","sdpMid":"0","sdpMLineIndex":0}
→ {"t":"end-of-candidates"}
← {"t":"answer","sdp":"v=0\r\n…"}
← {"t":"candidate","candidate":"candidate:… typ host","sdpMid":"0","sdpMLineIndex":0}
→ {"t":"state","state":"connecting"}
→ {"t":"state","state":"connected"}
→ {"t":"keyframe-request","reason":"connected"}
→ {"t":"input","channel":"input","data":"{\"type\":\"touch\",\"phase\":\"down\",\"x\":0.5,\"y\":0.5}"}
→ {"t":"stats","fps":59.0,"bitrate":3500000,"rttMs":0.4,"packetsSent":1200,"packetsLost":0,"nacks":0,"plis":1,"unitsSent":120,"unitsDropped":3,"path":"host","network":"tailnet","relayedBytes":0,"bytesSent":440000}
← {"t":"close"}
```

## Media

- One sendonly H.264 track, payload type 102, `codec::h264` (`42e01f`, packetization-mode 1, `nack`, `nack pli`), packetized by `warden_rtc::packetize`. RTP timestamp = `pts_us * 90 / 1000` (wrapping).
- Data channels created by the publisher (it is the offerer): `input` (ordered, reliable) and `input-moves` (ordered, `maxRetransmits: 0`).
- Nothing is sent before `connected`. Then `keyframe-request` `connected`, and deltas are skipped until an IDR: the first unit the peer gets is a keyframe.
- PLI and FIR reach the application through an interceptor at the end of the chain (`KeyframeRequests`); requests within 200 ms coalesce into one line. NACKs are answered by the default interceptors' responder.
- Backlog: units queue for the sender; at 4 the queue is cut, `unitsDropped` counts them, a `keyframe-request` `drop` goes out and deltas are skipped to the next IDR. Latency never grows.

## ICE

- Host candidates come from explicit per-address binds (`ice::udp_bind_addrs`), not the stack's wildcard expansion: every interface address except loopback, unspecified, multicast and link-local. Tailscale's `utun*` (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) is kept.
- `auto`: + `stun:stun.cloudflare.com:3478` and any TURN given. `lan`: no servers at all. `turn`: relay policy, only `turn:`/`turns:` urls, at least one required.
- Acceptance waits (`ice::acceptance_waits`): host 0, prflx 0, srflx 100 ms, relay 0 in `turn` and 500 ms otherwise. The stack defaults (prflx 1 s, relay 2 s) cost a second whenever the peer's check beats its trickled candidate, and two on every relayed session. The viewer side (STRM-7) should use `ice::setting_engine` too.

## Tests

`cargo test --manifest-path crates/warden-stream/Cargo.toml` (and `crates/warden-rtc`): signoff check `stream`, CI job `stream`, path-gated on `crates/warden-stream/**` + `crates/warden-rtc/**`. Measured on loopback (M-series, 2026-11-05): connected 210 ms after the offer, 119/119 units byte-identical, 59.9 fps, arrival gap p50 16.8 ms.

## Packaging (not done)

Stage it like `warden-simd`: build `--release` per darwin target in the release workflow, copy into the `@delacour/warden-darwin-<arch>` package next to `warden-simd` (`apps/cli/src/npm/helper-stage.ts`), add to the GitHub Release assets and `SHA256SUMS`. Release build ≈ a few MB (lto, strip).
