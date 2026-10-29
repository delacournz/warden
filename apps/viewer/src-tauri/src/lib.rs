mod device;
mod session;

use session::{emit, EofAction, Event, SessionState};
use tauri::Emitter;
use time::OffsetDateTime;
use tauri::{Manager, RunEvent};
use tauri_plugin_log::{Target, TargetKind};

/// Report a fatal startup error on the stdout contract and exit 1.
fn fail(message: &str) -> ! {
    emit(&Event::Error { message });
    std::process::exit(1)
}

/// Detached sessions outlive stdin. Wait for the held token to expire, then tell the window to drop
/// the stream; the process stays up until the user closes the window.
fn hold_until_expiry(handle: &tauri::AppHandle) {
    let state = handle.state::<SessionState>();
    let expires_at = state.expires_at();
    while !session::is_expired(&expires_at, OffsetDateTime::now_utc()) {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    let _ = handle.emit("viewer-expired", ());
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
        .manage(SessionState::new(start))
        .manage(device::DeviceState::new())
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&title);
            }
            // The parent holds stdin open for the session; EOF means it died.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let state = handle.state::<SessionState>();
                session::pump_refreshes(std::io::stdin().lock(), &state, || {
                    match session::eof_action(state.detached()) {
                        EofAction::Exit => handle.exit(0),
                        EofAction::HoldUntilExpiry => hold_until_expiry(&handle),
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
