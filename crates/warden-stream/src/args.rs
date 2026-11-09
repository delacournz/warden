//! Command line of the `warden-stream` binary.

use crate::ice::{self, IceMode, IceServer};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

pub const USAGE: &str = "\
warden-stream: publish a device's live H.264 over WebRTC; signalling is NDJSON on stdio.

  --au-socket <path>     read access units from the helper's stream socket
  --au-file <path>       replay an Annex-B or framed file instead (tests, benches)
  --fps <n>              replay rate for --au-file (default 60)
  --loop                 replay --au-file forever
  --ice auto|lan|turn    candidate policy (default auto)
  --ice-servers <json>   the iceServers array (or {\"iceServers\": [...]}) for TURN
  --udp-addr <ip:port>   bind exactly this (repeatable); default one socket per host address
  --stats-ms <n>         stats line interval (default 1000)
  --whip <url>           publish to an SFU over WHIP (not supported yet)

stdout: offer, candidate, end-of-candidates, state, keyframe-request, input, stats, error
stdin:  answer, candidate, end-of-candidates, close
";

#[derive(Debug, Clone, PartialEq)]
pub enum Input {
    Socket(PathBuf),
    File {
        path: PathBuf,
        fps: f64,
        looped: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Args {
    pub input: Input,
    pub ice: IceMode,
    pub ice_servers: Vec<IceServer>,
    pub udp_addrs: Vec<SocketAddr>,
    pub stats_every: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgsError {
    Help,
    Usage(String),
    Unsupported(String),
}

pub fn parse(argv: &[String]) -> Result<Args, ArgsError> {
    let mut socket = None;
    let mut file = None;
    let mut fps = 60.0;
    let mut fps_given = false;
    let mut looped = false;
    let mut ice = IceMode::Auto;
    let mut ice_servers = Vec::new();
    let mut udp_addrs = Vec::new();
    let mut stats_ms: u64 = 1000;
    let usage = |m: String| ArgsError::Usage(m);
    let mut it = argv.iter();
    while let Some(flag) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| usage(format!("{name} needs a value")))
        };
        match flag.as_str() {
            "-h" | "--help" => return Err(ArgsError::Help),
            "--au-socket" => socket = Some(PathBuf::from(value(flag)?)),
            "--au-file" => file = Some(PathBuf::from(value(flag)?)),
            "--fps" => {
                fps = value(flag)?
                    .parse()
                    .ok()
                    .filter(|f: &f64| *f > 0.0 && *f <= 240.0)
                    .ok_or_else(|| usage("--fps must be a number in (0, 240]".to_owned()))?;
                fps_given = true;
            }
            "--loop" => looped = true,
            "--ice" => ice = value(flag)?.parse().map_err(usage)?,
            "--ice-servers" => {
                ice_servers = ice::parse_ice_servers(&value(flag)?).map_err(usage)?
            }
            "--udp-addr" => udp_addrs.push(
                value(flag)?
                    .parse()
                    .map_err(|e| usage(format!("--udp-addr: {e}")))?,
            ),
            "--stats-ms" => {
                stats_ms = value(flag)?
                    .parse()
                    .ok()
                    .filter(|ms| *ms >= 100)
                    .ok_or_else(|| usage("--stats-ms must be an integer >= 100".to_owned()))?;
            }
            "--whip" => {
                let url = value(flag)?;
                return Err(ArgsError::Unsupported(format!(
                    "--whip {url}: publishing to an SFU is not supported yet; use the offer/answer on stdio"
                )));
            }
            other => return Err(usage(format!("unknown argument {other:?}"))),
        }
    }
    let input = match (socket, file) {
        (Some(path), None) => {
            if fps_given || looped {
                return Err(usage("--fps and --loop only apply to --au-file".to_owned()));
            }
            Input::Socket(path)
        }
        (None, Some(path)) => Input::File { path, fps, looped },
        (Some(_), Some(_)) => {
            return Err(usage(
                "give one of --au-socket or --au-file, not both".to_owned(),
            ))
        }
        (None, None) => {
            return Err(usage(
                "--au-socket <path> or --au-file <path> is required".to_owned(),
            ))
        }
    };
    ice::ice_servers(ice, &ice_servers).map_err(usage)?;
    Ok(Args {
        input,
        ice,
        ice_servers,
        udp_addrs,
        stats_every: Duration::from_millis(stats_ms),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Result<Args, ArgsError> {
        let argv: Vec<String> = s.split_whitespace().map(str::to_owned).collect();
        parse(&argv)
    }

    #[test]
    fn a_socket_with_defaults() {
        let a = args("--au-socket /tmp/s.sock").unwrap();
        assert_eq!(a.input, Input::Socket("/tmp/s.sock".into()));
        assert_eq!(a.ice, IceMode::Auto);
        assert!(a.ice_servers.is_empty() && a.udp_addrs.is_empty());
        assert_eq!(a.stats_every, Duration::from_secs(1));
    }

    #[test]
    fn a_looped_file_replay_on_loopback_with_lan_ice() {
        let a = args(
            "--au-file f.h264 --fps 30 --loop --ice lan --udp-addr 127.0.0.1:0 --stats-ms 500",
        )
        .unwrap();
        assert_eq!(
            a.input,
            Input::File {
                path: "f.h264".into(),
                fps: 30.0,
                looped: true
            }
        );
        assert_eq!(a.ice, IceMode::Lan);
        assert_eq!(
            a.udp_addrs,
            vec!["127.0.0.1:0".parse::<SocketAddr>().unwrap()]
        );
        assert_eq!(a.stats_every, Duration::from_millis(500));
    }

    #[test]
    fn turn_needs_a_turn_server() {
        assert!(matches!(
            args("--au-socket s --ice turn"),
            Err(ArgsError::Usage(_))
        ));
        let a = args(r#"--au-socket s --ice turn --ice-servers [{"urls":"turn:t:3478","username":"u","credential":"c"}]"#)
            .unwrap();
        assert_eq!(a.ice, IceMode::Turn);
        assert_eq!(a.ice_servers[0].urls, vec!["turn:t:3478".to_owned()]);
    }

    #[test]
    fn whip_is_reported_unsupported() {
        assert!(matches!(
            args("--au-socket s --whip https://sfu.example/whip"),
            Err(ArgsError::Unsupported(m)) if m.contains("not supported")
        ));
    }

    #[test]
    fn usage_errors() {
        for bad in [
            "",
            "--au-socket a --au-file b",
            "--au-socket a --fps 30",
            "--au-socket a --loop",
            "--au-file f --fps 0",
            "--au-file f --fps x",
            "--au-socket a --ice relay",
            "--au-socket a --udp-addr nope",
            "--au-socket a --stats-ms 5",
            "--au-socket",
            "--au-socket a --bogus",
        ] {
            assert!(matches!(args(bad), Err(ArgsError::Usage(_))), "{bad:?}");
        }
        assert_eq!(args("--help"), Err(ArgsError::Help));
    }
}
