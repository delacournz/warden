mod billing;
mod device;
mod session;

use session::{emit, EofAction, Event, SessionState};
use tauri::Emitter;
use tauri::{Manager, RunEvent};
use tauri_plugin_log::{Target, TargetKind};
use time::OffsetDateTime;

/// Report a fatal startup error on the stdout contract and exit 1.
fn fail(message: &str) -> ! {
    emit(&Event::Error { message });
    std::process::exit(1)
}

/// A detached session ends by expiry, not by stdin. Poll the held token (a refresh may extend it)
/// and tell the window to drop the stream once it expires; the process stays up until the user
/// closes the window.
fn watch_expiry(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        let state = handle.state::<SessionState>();
        while !session::is_expired(&state.expires_at(), OffsetDateTime::now_utc()) {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        let _ = handle.emit("viewer-expired", ());
    });
}

/// Poll the device every 15 s for `stopReason` and `billing.lowBalance`, and tell the window when
/// either changes. The token stays in Rust. 401 and 404 end polling quietly, other failures are
/// logged and retried, and a stopped device ends it after one `viewer-stopped`.
fn watch_billing(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last_low = false;
        loop {
            let creds = handle.state::<SessionState>().credentials();
            let result =
                tauri::async_runtime::block_on(device::fetch_device(&handle.state(), &creds));
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
                                        let _ = handle.emit("viewer-billing", p);
                                    }
                                    billing::Emission::Stopped(p) => {
                                        let _ = handle.emit("viewer-stopped", p);
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
            std::thread::sleep(std::time::Duration::from_secs(billing::POLL_INTERVAL_SECS));
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
        .manage(SessionState::new(start))
        .manage(device::DeviceState::new())
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&title);
            }
            if app.state::<SessionState>().detached() {
                watch_expiry(app.handle().clone());
            }
            watch_billing(app.handle().clone());
            // The parent holds stdin open for the session; EOF means it died.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let state = handle.state::<SessionState>();
                session::pump_refreshes(std::io::stdin().lock(), &state, || {
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
            device::whep_candidate,
            device::whep_close,
            device::tap,
            device::swipe,
            device::input,
            device::open_url,
            device::open_billing,
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
