//! The process the CLI spawns: a headless relay between its stdin/stdout contract and the one
//! viewer host. It never starts Tauri, so it has no window and no dock icon.
//!
//! stdin's first line goes to the host as `open`, every later line as `refresh`, EOF as `eof`.
//! The host's `ready` / `streaming` / `error` come back out on stdout exactly as before.

use crate::ipc::{self, CloseReason, Conn, ToHost, ToRelay};
use crate::session::{self, event_line, Event};
use std::io::{BufRead, Write};
use std::time::Duration;
use tokio::sync::mpsc;

/// How long the relay waits for a host to come up (spawned or already running).
const CONNECT_DEADLINE: Duration = Duration::from_secs(5);
/// A host that was exiting as we connected says `closed: shutdown`; try a fresh one this often.
const ATTEMPTS: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StdinMsg {
    Line(String),
    Eof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Exit(i32),
    /// The host was shutting down before it took the session: reconnect and open again.
    Retry,
}

fn print<W: Write>(out: &mut W, event: &Event) {
    let _ = writeln!(out, "{}", event_line(event));
    let _ = out.flush();
}

/// Aborts the frame reader when the relay ends, so its half of the socket closes with it.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Read frames on their own task: `read_line` is not cancel-safe inside `select!`.
fn frames(
    mut reader: tokio::io::BufReader<Box<dyn tokio::io::AsyncRead + Send + Unpin>>,
) -> (mpsc::UnboundedReceiver<Option<ToRelay>>, AbortOnDrop) {
    let (tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        loop {
            match ipc::read_frame::<_, ToRelay>(&mut reader).await {
                Ok(Some(frame)) => {
                    if tx.send(Some(frame)).is_err() {
                        return;
                    }
                }
                Ok(None) | Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
            }
        }
    });
    (rx, AbortOnDrop(task))
}

/// One connection's worth of relaying. `eof_seen` survives a retry so a reopened session gets its
/// `eof` again (a detached CLI closes stdin right after the first line).
pub async fn relay_once<W: Write>(
    line: &str,
    stdin: &mut mpsc::UnboundedReceiver<StdinMsg>,
    eof_seen: &mut bool,
    conn: Conn,
    out: &mut W,
) -> Outcome {
    let Conn { reader, mut writer } = conn;
    let (mut from_host, _reader_task) = frames(reader);
    let open = ToHost::Open {
        proto: ipc::PROTO,
        line: line.trim_end().to_string(),
    };
    if ipc::write_frame(&mut writer, &open).await.is_err() {
        return Outcome::Retry;
    }
    if *eof_seen && ipc::write_frame(&mut writer, &ToHost::Eof).await.is_err() {
        return Outcome::Retry;
    }
    let mut ready = false;
    loop {
        tokio::select! {
            msg = stdin.recv(), if !*eof_seen => {
                let frame = match msg {
                    Some(StdinMsg::Line(l)) if l.trim().is_empty() => continue,
                    Some(StdinMsg::Line(l)) => ToHost::Refresh { line: l },
                    Some(StdinMsg::Eof) | None => {
                        *eof_seen = true;
                        ToHost::Eof
                    }
                };
                if ipc::write_frame(&mut writer, &frame).await.is_err() {
                    log::warn!("viewer host went away");
                }
            }
            frame = from_host.recv() => match frame.flatten() {
                Some(ToRelay::Ready) => {
                    ready = true;
                    print(out, &Event::Ready);
                }
                Some(ToRelay::Streaming) => print(out, &Event::Streaming),
                Some(ToRelay::Close { release }) => print(out, &Event::Close { release }),
                Some(ToRelay::Error { message }) => {
                    print(out, &Event::Error { message: &message });
                    return Outcome::Exit(1);
                }
                Some(ToRelay::Closed { reason: CloseReason::Shutdown }) if !ready => return Outcome::Retry,
                Some(ToRelay::Closed { .. }) => return Outcome::Exit(0),
                None if ready => return Outcome::Exit(0),
                None => {
                    print(out, &Event::Error { message: "the viewer host closed before the window opened" });
                    return Outcome::Exit(1);
                }
            },
        }
    }
}

/// `relay_once` for a caller that does not retry: a retry reads as a failed start.
#[cfg(test)]
pub async fn relay<W: Write>(
    line: String,
    mut stdin: mpsc::UnboundedReceiver<StdinMsg>,
    conn: Conn,
    out: &mut W,
) -> i32 {
    let mut eof_seen = false;
    match relay_once(&line, &mut stdin, &mut eof_seen, conn, out).await {
        Outcome::Exit(code) => code,
        Outcome::Retry => {
            print(
                out,
                &Event::Error {
                    message: "the viewer host went away",
                },
            );
            1
        }
    }
}

fn fail(message: &str) -> ! {
    print(&mut std::io::stdout().lock(), &Event::Error { message });
    std::process::exit(1)
}

/// Entry point for a CLI-spawned process: validate the session line, reach (or start) the host,
/// relay until the window is gone or stdin ends.
pub fn run_relay() -> ! {
    let mut line = String::new();
    match std::io::stdin().lock().read_line(&mut line) {
        Ok(0) => fail(&session::StartError::Eof.to_string()),
        Ok(_) => {}
        Err(e) => fail(&session::StartError::Read(e.to_string()).to_string()),
    }
    if let Err(e) = session::parse_session(&line) {
        fail(&e.to_string());
    }
    let exe = std::env::current_exe()
        .unwrap_or_else(|e| fail(&format!("could not find the viewer executable: {e}")));
    let key = ipc::instance_key(env!("CARGO_PKG_VERSION"), &exe);
    let ep = ipc::endpoint(&key)
        .unwrap_or_else(|e| fail(&format!("could not prepare the viewer socket: {e}")));

    let (tx, mut rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for l in std::io::stdin().lock().lines() {
            let Ok(l) = l else { break };
            if tx.send(StdinMsg::Line(l)).is_err() {
                return;
            }
        }
        let _ = tx.send(StdinMsg::Eof);
    });

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|e| fail(&format!("could not start the relay: {e}")));
    let code = runtime.block_on(async {
        let mut eof_seen = false;
        for _ in 0..ATTEMPTS {
            let conn = match ipc::connect_or_spawn(
                &ep,
                || ipc::spawn_host_detached(&exe, &ep.log),
                CONNECT_DEADLINE,
            )
            .await
            {
                Ok(c) => c,
                Err(e) => fail(&format!("could not reach the viewer host: {e}")),
            };
            let mut out = std::io::stdout().lock();
            match relay_once(&line, &mut rx, &mut eof_seen, conn, &mut out).await {
                Outcome::Exit(code) => return code,
                Outcome::Retry => continue,
            }
        }
        fail("the viewer host kept shutting down")
    });
    std::process::exit(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (Conn, Conn) {
        let (a, b) = tokio::io::duplex(64 * 1024);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        (
            Conn {
                reader: tokio::io::BufReader::new(Box::new(ar)),
                writer: Box::new(aw),
            },
            Conn {
                reader: tokio::io::BufReader::new(Box::new(br)),
                writer: Box::new(bw),
            },
        )
    }

    #[tokio::test]
    async fn sends_open_refresh_and_eof_in_order() {
        let (relay_conn, mut host) = pair();
        let (tx, mut rx) = mpsc::unbounded_channel();
        tx.send(StdinMsg::Line(
            "{\"token\":\"t2\",\"expiresAt\":\"e\"}".into(),
        ))
        .unwrap();
        tx.send(StdinMsg::Line("  ".into())).unwrap();
        tx.send(StdinMsg::Eof).unwrap();
        let task = tokio::spawn(async move {
            let mut out = Vec::new();
            let mut eof = false;
            let o = relay_once("{\"x\":1}\n", &mut rx, &mut eof, relay_conn, &mut out).await;
            (o, eof, String::from_utf8(out).unwrap())
        });
        let f1: ToHost = ipc::read_frame(&mut host.reader).await.unwrap().unwrap();
        assert_eq!(
            f1,
            ToHost::Open {
                proto: ipc::PROTO,
                line: "{\"x\":1}".into()
            }
        );
        let f2: ToHost = ipc::read_frame(&mut host.reader).await.unwrap().unwrap();
        assert_eq!(
            f2,
            ToHost::Refresh {
                line: "{\"token\":\"t2\",\"expiresAt\":\"e\"}".into()
            }
        );
        let f3: ToHost = ipc::read_frame(&mut host.reader).await.unwrap().unwrap();
        assert_eq!(f3, ToHost::Eof);
        ipc::write_frame(&mut host.writer, &ToRelay::Ready)
            .await
            .unwrap();
        ipc::write_frame(
            &mut host.writer,
            &ToRelay::Closed {
                reason: CloseReason::Eof,
            },
        )
        .await
        .unwrap();
        let (o, eof, out) = task.await.unwrap();
        assert_eq!(o, Outcome::Exit(0));
        assert!(eof);
        assert_eq!(out, "{\"event\":\"ready\"}\n");
    }

    #[tokio::test]
    async fn shutdown_before_ready_asks_for_a_retry_and_replays_eof() {
        let (relay_conn, mut host) = pair();
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let mut eof = true;
        let task = tokio::spawn(async move {
            let mut out = Vec::new();
            relay_once("{}", &mut rx, &mut eof, relay_conn, &mut out).await
        });
        let _: ToHost = ipc::read_frame(&mut host.reader).await.unwrap().unwrap();
        let replay: ToHost = ipc::read_frame(&mut host.reader).await.unwrap().unwrap();
        assert_eq!(replay, ToHost::Eof);
        ipc::write_frame(
            &mut host.writer,
            &ToRelay::Closed {
                reason: CloseReason::Shutdown,
            },
        )
        .await
        .unwrap();
        assert_eq!(task.await.unwrap(), Outcome::Retry);
    }

    #[tokio::test]
    async fn a_host_that_drops_before_ready_is_a_failed_start() {
        let (relay_conn, host) = pair();
        let (_tx, rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut out = Vec::new();
            let code = relay("{}".into(), rx, relay_conn, &mut out).await;
            (code, String::from_utf8(out).unwrap())
        });
        drop(host);
        let (code, out) = task.await.unwrap();
        assert_eq!(code, 1);
        assert!(out.starts_with("{\"event\":\"error\""));
    }

    #[tokio::test]
    async fn a_host_that_drops_after_ready_exits_0() {
        let (relay_conn, mut host) = pair();
        let (_tx, rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut out = Vec::new();
            relay("{}".into(), rx, relay_conn, &mut out).await
        });
        let _: ToHost = ipc::read_frame(&mut host.reader).await.unwrap().unwrap();
        ipc::write_frame(&mut host.writer, &ToRelay::Ready)
            .await
            .unwrap();
        drop(host);
        assert_eq!(task.await.unwrap(), 0);
    }

    #[tokio::test]
    async fn an_error_frame_prints_and_exits_1() {
        let (relay_conn, mut host) = pair();
        let (_tx, rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut out = Vec::new();
            let code = relay("{}".into(), rx, relay_conn, &mut out).await;
            (code, String::from_utf8(out).unwrap())
        });
        let _: ToHost = ipc::read_frame(&mut host.reader).await.unwrap().unwrap();
        ipc::write_frame(
            &mut host.writer,
            &ToRelay::Error {
                message: "boom".into(),
            },
        )
        .await
        .unwrap();
        let (code, out) = task.await.unwrap();
        assert_eq!(code, 1);
        assert_eq!(out, "{\"event\":\"error\",\"message\":\"boom\"}\n");
    }
}
