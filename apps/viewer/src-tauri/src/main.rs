// Prevents an extra console window on Windows in release builds. The process contract still holds under the
// GUI subsystem: the parent's redirected stdin/stdout pipes are inherited as the process's standard handles
// (STARTF_USESTDHANDLES), and std::io::{stdin, stdout} read them through GetStdHandle, so no AttachConsole is needed.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    warden_viewer_lib::run()
}
