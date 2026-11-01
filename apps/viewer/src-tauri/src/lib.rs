mod billing;
mod device;
mod registry;
mod session;

use registry::{Registry, StdoutSink, Viewer};
use session::{emit, EofAction, Event};
use std::sync::Arc;
use tauri::{Emitter, EventTarget, Manager, RunEvent};
use tauri_plugin_log::{Target, TargetKind};
use time::OffsetDateTime;

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
fn start_watchers(handle: &tauri::AppHandle, viewer: &Arc<Viewer>) {
    let generation = viewer.generation();
    if viewer.session.detached() {
        watch_expiry(handle.clone(), viewer.clone(), generation);
    }
    watch_billing(handle.clone(), viewer.clone(), generation);
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
fn watch_billing(handle: tauri::AppHandle, viewer: Arc<Viewer>, generation: u64) {
    std::thread::spawn(move || {
        let mut last_low = false;
        while viewer.is_current(generation) {
            let creds = viewer.session.credentials();
            let registry = handle.state::<Registry>();
            let result =
                tauri::async_runtime::block_on(device::fetch_device(registry.client(), &creds));
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

pub fn run() {
    if cfg!(target_os = "linux") {
        fail("the warden viewer does not support Linux yet");
    }

    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let start = match session::read_start(&mut reader) {
        Ok(session) => session,
        Err(e) => fail(&e.to_string()),
    };
    drop(reader);
    let title = start.title.clone();
    let viewer = Arc::new(Viewer::new("main", start, Arc::new(StdoutSink)));
    let registry = Registry::new();
    registry.insert(viewer.clone());

    let app =
        tauri::Builder::default()
            .plugin(
                tauri_plugin_log::Builder::new()
                    .level(log::LevelFilter::Info)
                    .clear_targets()
                    .target(Target::new(TargetKind::Stderr))
                    .build(),
            )
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_opener::init())
            .manage(registry)
            .setup(move |app| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title(&title);
                }
                start_watchers(app.handle(), &viewer);
                // The parent holds stdin open for the session; EOF means it died.
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let state = &viewer.session;
                    session::pump_refreshes(std::io::stdin().lock(), state, || {
                        match session::eof_action(state.detached()) {
                            EofAction::Exit => handle.exit(0),
                            EofAction::HoldUntilExpiry => {}
                        }
                    });
                });
                Ok(())
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
            .unwrap_or_else(|e| fail(&format!("could not start the window: {e}")));

    app.run(|_app, event| {
        if let RunEvent::Ready = event {
            emit(&Event::Ready);
        }
    });
}
