mod billing;
mod device;
mod host;
mod ipc;
mod registry;
mod relay;
mod session;

use host::{Host, WindowOps};
use registry::{Registry, Viewer};
use session::{emit, Event};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{
    Emitter, EventTarget, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_log::{Target, TargetKind};
use time::OffsetDateTime;

/// How long the host lingers with no window and no relay, so a racing `open` doesn't land on a
/// dying host.
const IDLE_GRACE: Duration = Duration::from_secs(2);
/// A freshly spawned host waits this long for its first relay.
const STARTUP_GRACE: Duration = Duration::from_secs(10);

/// Report a fatal startup error on the stdout contract and exit 1.
fn fail(message: &str) -> ! {
    emit(&Event::Error { message });
    std::process::exit(1)
}

/// Emit a webview event to one device window only, never a broadcast.
fn emit_to_window<S: serde::Serialize + Clone>(
    handle: &tauri::AppHandle,
    label: &str,
    event: &str,
    payload: S,
) {
    let _ = handle.emit_to(EventTarget::webview_window(label), event, payload);
}

/// Start the per-window watchers for the viewer's current generation. A takeover or a closed
/// window stales the generation and the threads end on their next tick.
fn start_watchers(handle: &tauri::AppHandle, client: &reqwest::Client, viewer: &Arc<Viewer>) {
    let generation = viewer.generation();
    if viewer.session.detached() {
        watch_expiry(handle.clone(), viewer.clone(), generation);
    }
    watch_billing(handle.clone(), client.clone(), viewer.clone(), generation);
}

/// A detached session ends by expiry, not by stdin. Poll the held token (a refresh may extend it)
/// and tell the window to drop the stream once it expires; the window stays until the user
/// closes it.
fn watch_expiry(handle: tauri::AppHandle, viewer: Arc<Viewer>, generation: u64) {
    std::thread::spawn(move || {
        while !session::is_expired(&viewer.session.expires_at(), OffsetDateTime::now_utc()) {
            if !viewer.is_current(generation) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        if viewer.is_current(generation) {
            emit_to_window(&handle, viewer.label(), "viewer-expired", ());
        }
    });
}

/// Poll the device every 15 s for `stopReason` and `billing.lowBalance`, and tell its window when
/// either changes. The token stays in Rust. 401 and 404 end polling quietly, other failures are
/// logged and retried, and a stopped device ends it after one `viewer-stopped`.
fn watch_billing(
    handle: tauri::AppHandle,
    client: reqwest::Client,
    viewer: Arc<Viewer>,
    generation: u64,
) {
    std::thread::spawn(move || {
        let mut last_low = false;
        while viewer.is_current(generation) {
            let creds = viewer.session.credentials();
            let result = tauri::async_runtime::block_on(device::fetch_device(&client, &creds));
            if !viewer.is_current(generation) {
                return;
            }
            match result {
                Err(e) => log::warn!("billing poll failed: {}", e.without_url()),
                Ok((status, body)) => match billing::classify_status(status) {
                    billing::HttpAction::StopQuietly => return,
                    billing::HttpAction::Retry => log::warn!("billing poll got HTTP {status}"),
                    billing::HttpAction::Parse => match billing::parse_device(&body) {
                        Err(e) => log::warn!("billing poll: bad body: {e}"),
                        Ok(snap) => {
                            let decision = billing::decide(last_low, &snap);
                            for emission in decision.emit {
                                match emission {
                                    billing::Emission::Billing(p) => {
                                        last_low = p.low_balance;
                                        emit_to_window(
                                            &handle,
                                            viewer.label(),
                                            "viewer-billing",
                                            p,
                                        );
                                    }
                                    billing::Emission::Stopped(p) => {
                                        emit_to_window(
                                            &handle,
                                            viewer.label(),
                                            "viewer-stopped",
                                            p,
                                        );
                                    }
                                }
                            }
                            if decision.done {
                                return;
                            }
                        }
                    },
                },
            }
            for _ in 0..billing::POLL_INTERVAL_SECS {
                if !viewer.is_current(generation) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
    });
}

/// The windowing side of the host: one undecorated window per device, built at runtime.
struct TauriWindows {
    handle: tauri::AppHandle,
    client: reqwest::Client,
    endpoint: ipc::Endpoint,
}

impl WindowOps for TauriWindows {
    fn create(&self, viewer: &Arc<Viewer>) -> Result<(), String> {
        WebviewWindowBuilder::new(
            &self.handle,
            viewer.label(),
            WebviewUrl::App("index.html".into()),
        )
        .title(viewer.session.title())
        .inner_size(420.0, 900.0)
        .min_inner_size(260.0, 420.0)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .maximizable(false)
        .build()
        .map_err(|e| e.to_string())?;
        start_watchers(&self.handle, &self.client, viewer);
        Ok(())
    }

    fn take_over(&self, viewer: &Arc<Viewer>) {
        if let Some(window) = self.handle.get_webview_window(viewer.label()) {
            let _ = window.set_title(&viewer.session.title());
            let _ = window.reload();
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        start_watchers(&self.handle, &self.client, viewer);
    }

    fn close(&self, label: &str) {
        if let Some(window) = self.handle.get_webview_window(label) {
            let _ = window.destroy();
        }
    }

    fn exit(&self) {
        unlink_endpoint(&self.endpoint);
        self.handle.exit(0);
    }
}

#[cfg(unix)]
fn unlink_endpoint(ep: &ipc::Endpoint) {
    let _ = std::fs::remove_file(&ep.socket);
}

#[cfg(windows)]
fn unlink_endpoint(_ep: &ipc::Endpoint) {}

fn instance_endpoint() -> Result<(PathBuf, ipc::Endpoint), String> {
    let exe = std::env::current_exe().map_err(|e| format!("no executable path: {e}"))?;
    let key = ipc::instance_key(env!("CARGO_PKG_VERSION"), &exe);
    let ep = ipc::endpoint(&key).map_err(|e| format!("socket dir: {e}"))?;
    Ok((exe, ep))
}

type TauriHost = Arc<Host<TauriWindows>>;

/// `warden-viewer --host`: the one Tauri app. Started detached by a relay; never by the CLI.
fn run_host() {
    let (_, endpoint) = match instance_endpoint() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("warden viewer host: {e}");
            std::process::exit(1)
        }
    };
    let listener = match tauri::async_runtime::block_on(ipc::Listener::bind(&endpoint)) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!("warden viewer host: another host is running");
            std::process::exit(0)
        }
        Err(e) => {
            eprintln!("warden viewer host: could not listen: {e}");
            std::process::exit(1)
        }
    };
    let registry = Arc::new(Registry::new());

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .clear_targets()
                .target(Target::new(TargetKind::Stderr))
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(registry.clone())
        .setup(move |app| {
            let windows = TauriWindows {
                handle: app.handle().clone(),
                client: registry.client().clone(),
                endpoint,
            };
            let host: TauriHost = Arc::new(Host::new(windows, registry, IDLE_GRACE));
            app.manage(host.clone());
            tauri::async_runtime::spawn(async move {
                host.exit_when_idle(STARTUP_GRACE);
                let mut listener = listener;
                loop {
                    match listener.accept().await {
                        Ok(conn) => {
                            tokio::spawn(host.clone().serve(conn));
                        }
                        Err(e) => log::warn!("accept failed: {e}"),
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if let Some(host) = window.app_handle().try_state::<TauriHost>() {
                    let host = host.inner().clone();
                    let label = window.label().to_string();
                    tauri::async_runtime::spawn(async move { host.on_window_closed(&label) });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            device::viewer_info,
            device::viewer_streaming,
            device::fit_window,
            device::whep_offer,
            device::whep_close,
            device::tap,
            device::swipe,
            device::input,
            device::open_url,
            device::open_billing,
            device::close_viewer,
            device::screenshot,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("warden viewer host: could not start: {e}");
            std::process::exit(1)
        });

    app.run(|app, event| match event {
        // Closing the last window must not end the host: it decides when to exit (idle grace).
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        RunEvent::Exit => {
            if let Some(host) = app.try_state::<TauriHost>() {
                for viewer_label in host.registry().labels() {
                    host.registry().remove(&viewer_label);
                }
            }
        }
        _ => {}
    });
}

/// Entry point. The CLI spawns the binary with no args: that is a relay. `--host` is internal and
/// only ever passed by a relay starting the host.
pub fn run() {
    if cfg!(target_os = "linux") {
        fail("the warden viewer does not support Linux yet");
    }
    if std::env::args().nth(1).as_deref() == Some("--host") {
        run_host();
    } else {
        relay::run_relay();
    }
}
