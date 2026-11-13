//! ICE policy: which local addresses become host candidates, which servers are used, and whether
//! only relayed pairs are allowed.
//!
//! - `auto`: host + srflx (`stun:stun.cloudflare.com:3478`) + any TURN given.
//! - `lan`: host candidates only, and no external call at all.
//! - `turn`: relayed pairs only (needs a TURN server in `--ice-servers`).
//!
//! Host candidates come from explicit per-interface binds, never from the stack's own wildcard
//! expansion, so the rule is ours and testable: every up, routable address, Tailscale's `utun*`
//! (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) included; loopback, link-local and multicast left out.

use crate::signal::Network;
use rtc::peer_connection::configuration::setting_engine::{SettingEngine, SettingEngineBuilder};
use rtc::peer_connection::configuration::RTCIceTransportPolicy;
use rtc::peer_connection::transport::RTCIceServer;
use serde::Deserialize;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

pub const CLOUDFLARE_STUN: &str = "stun:stun.cloudflare.com:3478";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IceMode {
    Auto,
    Lan,
    Turn,
}

impl std::str::FromStr for IceMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "auto" => Ok(Self::Auto),
            "lan" => Ok(Self::Lan),
            "turn" => Ok(Self::Turn),
            other => Err(format!("--ice must be auto, lan or turn, not {other:?}")),
        }
    }
}

/// One local interface address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Iface {
    pub name: String,
    pub ip: IpAddr,
}

/// The machine's interface addresses.
pub fn local_ifaces() -> Vec<Iface> {
    match rtc::shared::ifaces::ifaces() {
        Ok(list) => list
            .into_iter()
            .filter_map(|i| {
                i.addr.map(|a| Iface {
                    name: i.name,
                    ip: a.ip(),
                })
            })
            .collect(),
        Err(e) => {
            log::warn!("ice: cannot enumerate interfaces: {e}");
            Vec::new()
        }
    }
}

fn in_v4(ip: Ipv4Addr, net: [u8; 4], prefix: u32) -> bool {
    let mask = u32::MAX.checked_shl(32 - prefix).unwrap_or(0);
    u32::from(ip) & mask == u32::from(Ipv4Addr::from(net)) & mask
}

fn in_v6(ip: Ipv6Addr, net: Ipv6Addr, prefix: u32) -> bool {
    let mask = u128::MAX.checked_shl(128 - prefix).unwrap_or(0);
    u128::from(ip) & mask == u128::from(net) & mask
}

const TAILNET_V6: Ipv6Addr = Ipv6Addr::new(0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 0);

/// Which network an address is on.
pub fn classify(ip: IpAddr) -> Network {
    match ip {
        IpAddr::V4(v4) if v4.is_loopback() => Network::Loopback,
        IpAddr::V4(v4) if in_v4(v4, [100, 64, 0, 0], 10) => Network::Tailnet,
        IpAddr::V4(v4) if v4.is_private() || v4.is_link_local() => Network::Lan,
        IpAddr::V6(v6) if v6.is_loopback() => Network::Loopback,
        IpAddr::V6(v6) if in_v6(v6, TAILNET_V6, 48) => Network::Tailnet,
        IpAddr::V6(v6)
            if in_v6(v6, Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7)
                || in_v6(v6, Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10) =>
        {
            Network::Lan
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => classify(IpAddr::V4(v4)),
            None => Network::Public,
        },
        IpAddr::V4(_) => Network::Public,
    }
}

fn link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => in_v6(v6, Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10),
    }
}

/// The addresses that become host candidates: every interface address a peer could reach.
/// Loopback, unspecified, multicast and link-local (whose scope id never survives into a
/// candidate) are left out; a VPN tunnel such as Tailscale's `utun*` is kept like any other.
pub fn host_ips(ifaces: &[Iface]) -> Vec<IpAddr> {
    let mut out: Vec<IpAddr> = Vec::new();
    for iface in ifaces {
        let ip = iface.ip;
        if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() || link_local(ip) {
            continue;
        }
        if !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

/// UDP sockets to bind: one per host address on an ephemeral port, or the given addresses
/// (`--udp-addr`, e.g. `127.0.0.1:0` for a loopback test). With none usable, the IPv4 wildcard,
/// so a relayed pair can still form.
pub fn udp_bind_addrs(ifaces: &[Iface], explicit: &[SocketAddr]) -> Vec<String> {
    if !explicit.is_empty() {
        return explicit.iter().map(ToString::to_string).collect();
    }
    let addrs: Vec<String> = host_ips(ifaces)
        .into_iter()
        .map(|ip| SocketAddr::new(ip, 0).to_string())
        .collect();
    if addrs.is_empty() {
        vec!["0.0.0.0:0".to_owned()]
    } else {
        addrs
    }
}

/// One entry of the `iceServers` array; `urls` may be a string or an array, as in the browser.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct IceServer {
    #[serde(deserialize_with = "one_or_many")]
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

fn one_or_many<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
    }
    Ok(match OneOrMany::deserialize(d)? {
        OneOrMany::One(url) => vec![url],
        OneOrMany::Many(urls) => urls,
    })
}

/// `--ice-servers`: the `iceServers` array, or the whole `{"iceServers": [...]}` object the
/// credentials endpoint returns.
pub fn parse_ice_servers(json: &str) -> Result<Vec<IceServer>, String> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Shape {
        List(Vec<IceServer>),
        Wrapped {
            #[serde(rename = "iceServers")]
            ice_servers: Vec<IceServer>,
        },
    }
    match serde_json::from_str::<Shape>(json) {
        Ok(Shape::List(list)) | Ok(Shape::Wrapped { ice_servers: list }) => Ok(list),
        Err(e) => Err(format!("--ice-servers is not an iceServers array: {e}")),
    }
}

fn is_turn(url: &str) -> bool {
    url.starts_with("turn:") || url.starts_with("turns:")
}

/// The servers handed to the peer connection for a mode.
pub fn ice_servers(mode: IceMode, given: &[IceServer]) -> Result<Vec<RTCIceServer>, String> {
    let to_rtc = |s: &IceServer, urls: Vec<String>| RTCIceServer {
        urls,
        username: s.username.clone().unwrap_or_default(),
        credential: s.credential.clone().unwrap_or_default(),
    };
    match mode {
        IceMode::Lan => Ok(Vec::new()),
        IceMode::Auto => {
            let mut out = vec![RTCIceServer {
                urls: vec![CLOUDFLARE_STUN.to_owned()],
                ..Default::default()
            }];
            for s in given {
                let urls: Vec<String> = s
                    .urls
                    .iter()
                    .filter(|u| u.as_str() != CLOUDFLARE_STUN)
                    .cloned()
                    .collect();
                if !urls.is_empty() {
                    out.push(to_rtc(s, urls));
                }
            }
            Ok(out)
        }
        IceMode::Turn => {
            let out: Vec<RTCIceServer> = given
                .iter()
                .filter_map(|s| {
                    let urls: Vec<String> = s.urls.iter().filter(|u| is_turn(u)).cloned().collect();
                    (!urls.is_empty()).then(|| to_rtc(s, urls))
                })
                .collect();
            if out.is_empty() {
                Err("--ice turn needs a turn: or turns: server in --ice-servers".to_owned())
            } else {
                Ok(out)
            }
        }
    }
}

/// How long ICE keeps checking for a better pair before it nominates one of each type.
///
/// The stack's defaults (host 0, srflx 500 ms, prflx 1 s, relay 2 s) cost a second whenever the
/// peer's check arrives before its trickled candidate (the pair is then peer-reflexive), and two
/// seconds on every `--ice turn` session. A stream wants the first working pair now: host and
/// prflx at once (a prflx pair on a LAN is the peer's host address seen early), srflx shortly,
/// relay at once when it is the only kind allowed and after a short wait otherwise, so a direct
/// path still wins when there is one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcceptanceWaits {
    pub host: Duration,
    pub srflx: Duration,
    pub prflx: Duration,
    pub relay: Duration,
}

pub fn acceptance_waits(mode: IceMode) -> AcceptanceWaits {
    AcceptanceWaits {
        host: Duration::ZERO,
        srflx: Duration::from_millis(100),
        prflx: Duration::ZERO,
        relay: match mode {
            IceMode::Turn => Duration::ZERO,
            IceMode::Auto | IceMode::Lan => Duration::from_millis(500),
        },
    }
}

/// The setting engine every peer of ours uses: the acceptance waits above, and an SRTP replay
/// window wide enough for a reordered keyframe (the 64-packet default discards its late half).
pub fn setting_engine(mode: IceMode) -> SettingEngine {
    let waits = acceptance_waits(mode);
    SettingEngineBuilder::new()
        .with_host_acceptance_min_wait(Some(waits.host))
        .with_srflx_acceptance_min_wait(Some(waits.srflx))
        .with_prflx_acceptance_min_wait(Some(waits.prflx))
        .with_relay_acceptance_min_wait(Some(waits.relay))
        .with_srtp_replay_protection_window(4096)
        .build()
}

pub fn transport_policy(mode: IceMode) -> RTCIceTransportPolicy {
    match mode {
        IceMode::Turn => RTCIceTransportPolicy::Relay,
        IceMode::Auto | IceMode::Lan => RTCIceTransportPolicy::All,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iface(name: &str, ip: &str) -> Iface {
        Iface {
            name: name.into(),
            ip: ip.parse().unwrap(),
        }
    }

    /// A Mac on Wi-Fi with Tailscale up and a few other tunnels that only have link-local addresses.
    fn mac() -> Vec<Iface> {
        vec![
            iface("lo0", "127.0.0.1"),
            iface("lo0", "::1"),
            iface("lo0", "fe80::1"),
            iface("en0", "fe80::1c2b:3d4e:5f60:7182"),
            iface("en0", "192.168.1.23"),
            iface("en0", "2404:4400:1:2::23"),
            iface("utun0", "fe80::abcd:1"),
            iface("utun3", "100.101.102.103"),
            iface("utun3", "fd7a:115c:a1e0::1234:5678"),
            iface("bridge100", "169.254.10.1"),
            iface("en0", "192.168.1.23"),
        ]
    }

    #[test]
    fn host_candidates_include_tailscale_utun_and_skip_loopback_and_link_local() {
        let ips = host_ips(&mac());
        let want: Vec<IpAddr> = [
            "192.168.1.23",
            "2404:4400:1:2::23",
            "100.101.102.103",
            "fd7a:115c:a1e0::1234:5678",
        ]
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
        assert_eq!(ips, want);
    }

    #[test]
    fn a_tailnet_only_host_still_has_host_candidates() {
        let ifaces = vec![iface("lo0", "127.0.0.1"), iface("utun4", "100.64.0.1")];
        assert_eq!(
            udp_bind_addrs(&ifaces, &[]),
            vec!["100.64.0.1:0".to_owned()]
        );
    }

    #[test]
    fn bind_addrs_are_one_ephemeral_socket_per_host_address() {
        let addrs = udp_bind_addrs(&mac(), &[]);
        assert_eq!(addrs.len(), 4);
        assert!(addrs.contains(&"[fd7a:115c:a1e0::1234:5678]:0".to_owned()));
        assert!(addrs.iter().all(|a| a.ends_with(":0")));
    }

    #[test]
    fn explicit_bind_addrs_win_and_no_interfaces_falls_back_to_the_wildcard() {
        let explicit: SocketAddr = "127.0.0.1:0".parse().unwrap();
        assert_eq!(
            udp_bind_addrs(&mac(), &[explicit]),
            vec!["127.0.0.1:0".to_owned()]
        );
        assert_eq!(
            udp_bind_addrs(&[iface("lo0", "127.0.0.1")], &[]),
            vec!["0.0.0.0:0".to_owned()]
        );
    }

    #[test]
    fn classifies_lan_tailnet_loopback_and_public() {
        let cases = [
            ("127.0.0.1", Network::Loopback),
            ("::1", Network::Loopback),
            ("192.168.1.23", Network::Lan),
            ("10.0.0.2", Network::Lan),
            ("172.20.1.1", Network::Lan),
            ("fd12:3456::1", Network::Lan),
            ("100.64.0.1", Network::Tailnet),
            ("100.127.255.254", Network::Tailnet),
            ("100.128.0.1", Network::Public),
            ("100.63.255.255", Network::Public),
            ("fd7a:115c:a1e0::1", Network::Tailnet),
            ("fd7a:115c:a1e1::1", Network::Lan),
            ("::ffff:100.100.1.1", Network::Tailnet),
            ("104.30.1.1", Network::Public),
            ("2404:4400::1", Network::Public),
        ];
        for (ip, want) in cases {
            assert_eq!(classify(ip.parse().unwrap()), want, "{ip}");
        }
    }

    fn servers() -> Vec<IceServer> {
        parse_ice_servers(
            r#"{"iceServers":[{"urls":["stun:stun.cloudflare.com:3478","turn:turn.cloudflare.com:3478?transport=udp","turns:turn.cloudflare.com:443?transport=tcp"],"username":"u","credential":"c"}]}"#,
        )
        .unwrap()
    }

    #[test]
    fn parses_the_wrapped_object_the_bare_array_and_a_string_url() {
        assert_eq!(servers()[0].urls.len(), 3);
        let bare = parse_ice_servers(r#"[{"urls":"turn:t:3478","username":"u","credential":"c"}]"#)
            .unwrap();
        assert_eq!(bare[0].urls, vec!["turn:t:3478".to_owned()]);
        assert_eq!(bare[0].credential.as_deref(), Some("c"));
        assert!(parse_ice_servers("{}").is_err());
        assert!(parse_ice_servers("nope").is_err());
    }

    #[test]
    fn lan_uses_no_servers_at_all() {
        assert!(ice_servers(IceMode::Lan, &servers()).unwrap().is_empty());
        assert_eq!(transport_policy(IceMode::Lan), RTCIceTransportPolicy::All);
    }

    #[test]
    fn auto_adds_cloudflare_stun_once_plus_the_given_turn() {
        let out = ice_servers(IceMode::Auto, &servers()).unwrap();
        assert_eq!(out[0].urls, vec![CLOUDFLARE_STUN.to_owned()]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].urls.len(), 2, "the duplicate STUN url is dropped");
        assert_eq!(out[1].username, "u");
        assert_eq!(ice_servers(IceMode::Auto, &[]).unwrap().len(), 1);
        assert_eq!(transport_policy(IceMode::Auto), RTCIceTransportPolicy::All);
    }

    #[test]
    fn turn_keeps_only_turn_urls_and_requires_one() {
        let out = ice_servers(IceMode::Turn, &servers()).unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].urls.iter().all(|u| u.starts_with("turn")));
        assert_eq!(out[0].credential, "c");
        assert_eq!(
            transport_policy(IceMode::Turn),
            RTCIceTransportPolicy::Relay
        );
        let stun_only = parse_ice_servers(r#"[{"urls":"stun:s:3478"}]"#).unwrap();
        assert!(ice_servers(IceMode::Turn, &stun_only).is_err());
        assert!(ice_servers(IceMode::Turn, &[]).is_err());
    }

    #[test]
    fn nominates_without_the_stack_default_waits() {
        for mode in [IceMode::Auto, IceMode::Lan, IceMode::Turn] {
            let w = acceptance_waits(mode);
            assert_eq!(w.host, Duration::ZERO);
            assert_eq!(
                w.prflx,
                Duration::ZERO,
                "a prflx pair is the peer seen before its candidate"
            );
            assert!(w.srflx <= Duration::from_millis(100));
        }
        assert_eq!(acceptance_waits(IceMode::Turn).relay, Duration::ZERO);
        let auto = acceptance_waits(IceMode::Auto).relay;
        assert!(
            auto > Duration::ZERO && auto <= Duration::from_millis(500),
            "a direct pair still wins"
        );
    }

    #[test]
    fn parses_modes() {
        assert_eq!("auto".parse::<IceMode>(), Ok(IceMode::Auto));
        assert_eq!("lan".parse::<IceMode>(), Ok(IceMode::Lan));
        assert_eq!("turn".parse::<IceMode>(), Ok(IceMode::Turn));
        assert!("relay".parse::<IceMode>().is_err());
    }
}
