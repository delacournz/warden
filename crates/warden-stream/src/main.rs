//! `warden-stream`: stdout carries the NDJSON protocol and nothing else; logs go to stderr
//! (`WARDEN_STREAM_LOG=error|warn|info|debug`, default `warn`).
//!
//! Exit codes: 0 after `close` or stdin EOF, 1 when the source or the peer connection failed,
//! 2 for a usage error or an unsupported option.

use std::io::Write;
use std::process::ExitCode;
use tokio::io::AsyncBufReadExt;
use tokio::sync::mpsc;
use warden_stream::args::{self, ArgsError, Input};
use warden_stream::publisher::{Config, Publisher};
use warden_stream::signal::{In, Out};
use warden_stream::source::{self, Spec};

struct StderrLog(log::LevelFilter);

impl log::Log for StderrLog {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= self.0
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("warden-stream {} {}", record.level(), record.args());
        }
    }

    fn flush(&self) {}
}

fn init_log() {
    let level = match std::env::var("WARDEN_STREAM_LOG").as_deref() {
        Ok("error") => log::LevelFilter::Error,
        Ok("info") => log::LevelFilter::Info,
        Ok("debug") => log::LevelFilter::Debug,
        Ok("off") => log::LevelFilter::Off,
        _ => log::LevelFilter::Warn,
    };
    if log::set_boxed_logger(Box::new(StderrLog(level))).is_ok() {
        log::set_max_level(level);
    }
}

fn print(out: &Out) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{}", out.line());
    let _ = stdout.flush();
}

fn error(code: &str, message: impl Into<String>) -> Out {
    Out::Error {
        code: code.to_owned(),
        message: message.into(),
    }
}

fn main() -> ExitCode {
    init_log();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match args::parse(&argv) {
        Ok(a) => a,
        Err(ArgsError::Help) => {
            eprint!("{}", args::USAGE);
            return ExitCode::SUCCESS;
        }
        Err(ArgsError::Usage(m)) => {
            print(&error("USAGE", m));
            eprint!("{}", args::USAGE);
            return ExitCode::from(2);
        }
        Err(ArgsError::Unsupported(m)) => {
            print(&error("UNSUPPORTED", m));
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            print(&error("RTC", format!("runtime: {e}")));
            return ExitCode::from(1);
        }
    };
    let code = runtime.block_on(run(args));
    // The stdin reader is a blocking read that only ends when the caller closes stdin; never wait for it.
    runtime.shutdown_background();
    code
}

async fn run(args: args::Args) -> ExitCode {
    let spec = match args.input {
        Input::Socket(path) => Spec::Socket(path),
        Input::File { path, fps, looped } => Spec::File { path, fps, looped },
    };
    let source = source::start(spec);
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();
    let config = Config {
        ice: args.ice,
        ice_servers: args.ice_servers,
        udp_addrs: args.udp_addrs,
        stats_every: args.stats_every,
    };
    let publisher = match Publisher::start(config, source, out_tx, None).await {
        Ok(p) => p,
        Err(e) => {
            while let Ok(out) = out_rx.try_recv() {
                print(&out);
            }
            print(&error("RTC", e));
            return ExitCode::from(1);
        }
    };

    let stdin_publisher = publisher.clone();
    let (signal_errors_tx, mut signal_errors) = mpsc::unbounded_channel::<Out>();
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) if line.trim().is_empty() => {}
                Ok(Some(line)) => {
                    let result = match In::parse(&line) {
                        Ok(msg) => stdin_publisher.handle(msg).await,
                        Err(e) => Err(format!("bad stdin line: {e}")),
                    };
                    if let Err(e) = result {
                        let _ = signal_errors_tx.send(error("SIGNAL", e));
                    }
                }
                Ok(None) | Err(_) => {
                    stdin_publisher.close().await;
                    return;
                }
            }
        }
    });

    let mut failed = false;
    let closed = publisher.closed();
    tokio::pin!(closed);
    loop {
        tokio::select! {
            Some(out) = out_rx.recv() => {
                failed |= matches!(&out, Out::Error { .. });
                failed |= matches!(&out, Out::State { state } if state == "failed");
                print(&out);
            }
            Some(out) = signal_errors.recv() => print(&out),
            () = &mut closed => break,
        }
    }
    while let Ok(out) = out_rx.try_recv() {
        failed |= matches!(&out, Out::Error { .. });
        print(&out);
    }
    if failed {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}
