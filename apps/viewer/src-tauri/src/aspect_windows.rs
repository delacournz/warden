//! Windows: constrain live resizes in `WM_SIZING` through a window subclass.
//!
//! The dragged edge comes in `wParam`; the `RECT` (physical pixels, outer window) is changed in
//! place, moving the side opposite the anchored one. Without a lock the message passes through.

use crate::aspect::{self, Drive};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetWindowRect, WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_LEFT, WMSZ_RIGHT, WMSZ_TOP,
    WMSZ_TOPLEFT, WMSZ_TOPRIGHT, WM_SIZING,
};

const SUBCLASS_ID: usize = 0x5744_4e41; // "WDNA"

unsafe extern "system" fn proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if msg == WM_SIZING && lparam.0 != 0 {
        if let Some(lock) = aspect::get(hwnd.0 as usize) {
            let rect = &mut *(lparam.0 as *mut RECT);
            constrain_rect(hwnd, &lock, wparam.0 as u32, rect);
            return LRESULT(1);
        }
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

unsafe fn constrain_rect(hwnd: HWND, lock: &aspect::Lock, edge: u32, rect: &mut RECT) {
    let scale = match GetDpiForWindow(hwnd) {
        0 => 1.0,
        dpi => dpi as f64 / 96.0,
    };
    let (mut outer, mut client) = (RECT::default(), RECT::default());
    let _ = GetWindowRect(hwnd, &mut outer);
    let _ = GetClientRect(hwnd, &mut client);
    let extra_w = ((outer.right - outer.left) - (client.right - client.left)) as f64;
    let extra_h = ((outer.bottom - outer.top) - (client.bottom - client.top)) as f64;
    let to_logical = |w: i32, h: i32| ((w as f64 - extra_w) / scale, (h as f64 - extra_h) / scale);
    let proposed = to_logical(rect.right - rect.left, rect.bottom - rect.top);
    let drive = match edge {
        WMSZ_LEFT | WMSZ_RIGHT => Drive::Width,
        WMSZ_TOP | WMSZ_BOTTOM => Drive::Height,
        _ => Drive::Free,
    };
    let (w, h) = aspect::constrain(lock, proposed, drive);
    let w = (w * scale + extra_w).round() as i32;
    let h = (h * scale + extra_h).round() as i32;
    if matches!(edge, WMSZ_LEFT | WMSZ_TOPLEFT | WMSZ_BOTTOMLEFT) {
        rect.left = rect.right - w;
    } else {
        rect.right = rect.left + w;
    }
    if matches!(edge, WMSZ_TOP | WMSZ_TOPLEFT | WMSZ_TOPRIGHT) {
        rect.top = rect.bottom - h;
    } else {
        rect.bottom = rect.top + h;
    }
}

/// Install the resize hook for one window (idempotent: same id replaces). UI thread only.
pub fn install(hwnd: usize) {
    // SAFETY: a live HWND owned by this thread; the subclass is removed with the window.
    unsafe {
        let _ = SetWindowSubclass(HWND(hwnd as *mut _), Some(proc), SUBCLASS_ID, 0);
    }
}
