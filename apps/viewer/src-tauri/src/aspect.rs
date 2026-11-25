//! Keeps a device window's video area at the device's aspect ratio while the user resizes it.
//!
//! The window is the video plus fixed chrome (bar and insets), so the ratio is not proportional
//! and `NSWindow.contentAspectRatio` cannot express it. Instead the platform resize callback
//! (`windowWillResize:toSize:` on macOS, `WM_SIZING` on Windows) asks [`constrain`] for the size.
//! Locks are keyed by the native window handle, the only thing those callbacks know.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Smallest portrait logical content size; matches the window builder's `min_inner_size`.
pub const MIN_WIDTH: f64 = 260.0;
pub const MIN_HEIGHT: f64 = 420.0;

/// One window's ratio: the video area has `aspect` (w / h) inside `chrome_height` of bar and
/// insets and `pad_x` of side insets, all logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Lock {
    pub aspect: f64,
    pub chrome_height: f64,
    pub pad_x: f64,
}

/// What decides the size: one dragged axis (an edge drag), or both (a corner drag).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Drive {
    Width,
    Height,
    Free,
}

fn still(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.5
}

/// How a proposed size was dragged, without a session: a still axis means the other one drives,
/// both moving is a corner drag. Fallback only; see [`Session`].
pub fn drive_from(current: (f64, f64), proposed: (f64, f64)) -> Drive {
    if still(proposed.1, current.1) && !still(proposed.0, current.0) {
        Drive::Width
    } else if still(proposed.0, current.0) {
        Drive::Height
    } else {
        Drive::Free
    }
}

/// One live resize. macOS proposes the size the drag started at plus the pointer's travel, not
/// the size returned last frame, so an edge drag keeps the other axis at its *start* size. Compared
/// with the current size instead, a corner drag now and then lines up on one axis, reads as an edge
/// drag and jumps. Once both axes have moved the drag stays free until it ends.
#[derive(Debug, Clone, Copy)]
pub struct Session {
    start: (f64, f64),
    free: bool,
}

impl Session {
    pub fn new(start: (f64, f64)) -> Self {
        Self { start, free: false }
    }

    pub fn drive(&mut self, proposed: (f64, f64)) -> Drive {
        if self.free {
            return Drive::Free;
        }
        let drive = drive_from(self.start, proposed);
        self.free = drive == Drive::Free;
        drive
    }
}

fn sessions() -> &'static Mutex<HashMap<usize, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<usize, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}

/// A live resize of a native window started at this content size.
pub fn begin(native: usize, start: (f64, f64)) {
    sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(native, Session::new(start));
}

/// The live resize ended.
pub fn end(native: usize) {
    sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&native);
}

/// The drive for a proposal within the window's live resize, `None` outside one.
pub fn drive_in_session(native: usize, proposed: (f64, f64)) -> Option<Drive> {
    sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(&native)
        .map(|s| s.drive(proposed))
}

fn width_for(lock: &Lock, height: f64) -> f64 {
    (height - lock.chrome_height).max(1.0) * lock.aspect + lock.pad_x
}

fn height_for(lock: &Lock, width: f64) -> f64 {
    (width - lock.pad_x).max(1.0) / lock.aspect + lock.chrome_height
}

/// Height of the size with the lock's ratio nearest the proposed one (least squares). It moves
/// continuously with the pointer, so a corner drag never jumps between two candidate sizes.
fn closest_height(lock: &Lock, (w, h): (f64, f64)) -> f64 {
    let a = lock.aspect;
    (h + a * a * lock.chrome_height + a * (w - lock.pad_x)) / (1.0 + a * a)
}

/// Smallest logical content size for an aspect: the builder's portrait minimum, swapped for a
/// landscape picture so a rotated window can still shrink.
pub fn min_size(aspect: f64) -> (f64, f64) {
    if aspect > 1.0 {
        (MIN_HEIGHT, MIN_WIDTH)
    } else {
        (MIN_WIDTH, MIN_HEIGHT)
    }
}

/// Logical content size for a proposed one: keep the driven axis, derive the other, then grow
/// both until the minimum size holds. Rounded to whole logical pixels.
pub fn constrain(lock: &Lock, proposed: (f64, f64), drive: Drive) -> (f64, f64) {
    let (min_w, min_h) = min_size(lock.aspect);
    let mut height = match drive {
        Drive::Width => height_for(lock, proposed.0),
        Drive::Height => proposed.1,
        Drive::Free => closest_height(lock, proposed),
    };
    height = height.max(min_h).max(height_for(lock, min_w));
    (width_for(lock, height).round(), height.round())
}

/// Content size that gives the video area the lock's aspect, keeping the current video area's
/// long edge (so a rotation swaps the screen, as Simulator.app does), shrunk to fit `bound` when
/// given.
pub fn fit(lock: &Lock, current: (f64, f64), bound: Option<(f64, f64)>) -> (f64, f64) {
    let long = (current.0 - lock.pad_x)
        .max(current.1 - lock.chrome_height)
        .max(1.0);
    let mut height = if lock.aspect >= 1.0 {
        long / lock.aspect
    } else {
        long
    } + lock.chrome_height;
    if let Some((max_w, max_h)) = bound {
        height = height.min(max_h).min(height_for(lock, max_w));
    }
    constrain(lock, (0.0, height), Drive::Height)
}

fn locks() -> &'static Mutex<HashMap<usize, (String, Lock)>> {
    static LOCKS: OnceLock<Mutex<HashMap<usize, (String, Lock)>>> = OnceLock::new();
    LOCKS.get_or_init(Default::default)
}

/// Set (or replace) the lock for a native window.
pub fn set(native: usize, label: &str, lock: Lock) {
    locks()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(native, (label.to_string(), lock));
}

pub fn get(native: usize) -> Option<Lock> {
    locks()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&native)
        .map(|(_, lock)| *lock)
}

/// Drop every lock of a window by label, once it is destroyed (its handle may be reused).
pub fn forget(label: &str) {
    locks()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|_, (l, _)| l != label);
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCK: Lock = Lock {
        aspect: 440.0 / 956.0,
        chrome_height: 48.0,
        pad_x: 12.0,
    };

    fn video_aspect((w, h): (f64, f64)) -> f64 {
        (w - LOCK.pad_x) / (h - LOCK.chrome_height)
    }

    #[test]
    fn a_height_drag_derives_the_width() {
        let (w, h) = constrain(&LOCK, (999.0, 900.0), Drive::Height);
        assert_eq!(h, 900.0);
        assert!((video_aspect((w, h)) - LOCK.aspect).abs() < 0.005);
    }

    #[test]
    fn a_width_drag_derives_the_height() {
        let (w, h) = constrain(&LOCK, (500.0, 10.0), Drive::Width);
        assert_eq!(w, 500.0);
        assert!((video_aspect((w, h)) - LOCK.aspect).abs() < 0.005);
    }

    #[test]
    fn grows_to_the_minimum_size_keeping_the_ratio() {
        let (w, h) = constrain(&LOCK, (100.0, 100.0), Drive::Width);
        assert!(w >= MIN_WIDTH && h >= MIN_HEIGHT);
        assert!((video_aspect((w, h)) - LOCK.aspect).abs() < 0.005);
    }

    #[test]
    fn a_wide_device_is_held_to_the_minimum_width() {
        let wide = Lock {
            aspect: 2.0,
            ..LOCK
        };
        let (w, _) = constrain(&wide, (300.0, 100.0), Drive::Height);
        assert!(w >= MIN_WIDTH);
    }

    #[test]
    fn rounds_to_whole_pixels() {
        let (w, h) = constrain(&LOCK, (433.3, 801.7), Drive::Height);
        assert_eq!((w.fract(), h.fract()), (0.0, 0.0));
    }

    #[test]
    fn an_edge_drag_is_driven_by_the_axis_that_moved() {
        assert_eq!(drive_from((400.0, 900.0), (450.0, 900.0)), Drive::Width);
        assert_eq!(drive_from((400.0, 900.0), (400.0, 950.0)), Drive::Height);
        assert_eq!(drive_from((400.0, 900.0), (400.0, 900.0)), Drive::Height);
    }

    #[test]
    fn a_corner_drag_is_free() {
        assert_eq!(drive_from((400.0, 900.0), (440.0, 910.0)), Drive::Free);
    }

    #[test]
    fn a_free_drag_lands_on_the_closest_size_with_the_ratio() {
        let (w, h) = constrain(&LOCK, (500.0, 1000.0), Drive::Free);
        assert!((video_aspect((w, h)) - LOCK.aspect).abs() < 0.005);
        assert!(w > 404.0 && w < 500.0 && h > 900.0 && h < 1100.0);
    }

    #[test]
    fn a_free_drag_moves_smoothly_with_the_pointer() {
        let mut last = constrain(&LOCK, (404.0, 900.0), Drive::Free);
        for step in 1..200 {
            let wobble = if step % 2 == 0 { 3.0 } else { -3.0 };
            let next = constrain(
                &LOCK,
                (
                    404.0 + step as f64 + wobble,
                    900.0 + step as f64 * 2.0 - wobble,
                ),
                Drive::Free,
            );
            assert!(
                (next.1 - last.1).abs() <= 6.0,
                "jumped {last:?} -> {next:?}"
            );
            last = next;
        }
    }

    #[test]
    fn a_session_reads_an_edge_drag_against_the_start_size() {
        let mut drag = Session::new((404.0, 900.0));
        assert_eq!(drag.drive((450.0, 900.0)), Drive::Width);
        assert_eq!(drag.drive((470.0, 900.0)), Drive::Width);
        let mut drag = Session::new((404.0, 900.0));
        assert_eq!(drag.drive((404.0, 990.0)), Drive::Height);
    }

    #[test]
    fn a_corner_drag_stays_free_even_when_one_axis_lines_up() {
        let mut drag = Session::new((404.0, 900.0));
        assert_eq!(drag.drive((412.0, 902.0)), Drive::Free);
        assert_eq!(drag.drive((458.0, 900.0)), Drive::Free);
        assert_eq!(drag.drive((404.0, 950.0)), Drive::Free);
    }

    #[test]
    fn a_session_is_kept_per_window_until_the_drag_ends() {
        begin(0xB1, (404.0, 900.0));
        assert_eq!(drive_in_session(0xB1, (412.0, 902.0)), Some(Drive::Free));
        assert_eq!(drive_in_session(0xB1, (458.0, 900.0)), Some(Drive::Free));
        end(0xB1);
        assert_eq!(drive_in_session(0xB1, (458.0, 900.0)), None);
    }

    #[test]
    fn forget_drops_every_lock_of_a_label() {
        set(0xA1, "dev-a", LOCK);
        set(0xA2, "dev-b", LOCK);
        forget("dev-a");
        assert_eq!(get(0xA1), None);
        assert_eq!(get(0xA2), Some(LOCK));
        forget("dev-b");
    }

    #[test]
    fn the_minimum_follows_the_orientation() {
        assert_eq!(min_size(0.46), (MIN_WIDTH, MIN_HEIGHT));
        assert_eq!(min_size(2.17), (MIN_HEIGHT, MIN_WIDTH));
    }

    #[test]
    fn a_landscape_window_shrinks_below_the_portrait_minimum_height() {
        let land = Lock {
            aspect: 2868.0 / 1320.0,
            ..LOCK
        };
        let (w, h) = constrain(&land, (500.0, 10.0), Drive::Width);
        assert_eq!(w, 500.0);
        assert!(h < MIN_HEIGHT);
    }

    #[test]
    fn fit_keeps_the_long_edge_so_rotation_swaps_the_screen() {
        let portrait = fit(&LOCK, (404.0, 900.0), None);
        assert_eq!(portrait, (404.0, 900.0));
        let land = Lock {
            aspect: 956.0 / 440.0,
            ..LOCK
        };
        let (w, h) = fit(&land, portrait, None);
        assert_eq!(w - LOCK.pad_x, 852.0);
        assert!((h - LOCK.chrome_height - 852.0 / land.aspect).abs() <= 1.0);
        assert_eq!(fit(&LOCK, (w, h), None), portrait);
    }

    #[test]
    fn fit_shrinks_to_the_bound_keeping_the_ratio() {
        let (w, h) = fit(&LOCK, (404.0, 900.0), Some((2000.0, 600.0)));
        assert!(h <= 600.0);
        assert!((video_aspect((w, h)) - LOCK.aspect).abs() < 0.005);
    }
}
