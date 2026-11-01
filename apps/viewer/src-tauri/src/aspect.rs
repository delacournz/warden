//! Keeps a device window's video area at the device's aspect ratio while the user resizes it.
//!
//! The window is the video plus fixed chrome (bar and insets), so the ratio is not proportional
//! and `NSWindow.contentAspectRatio` cannot express it. Instead the platform resize callback
//! (`windowWillResize:toSize:` on macOS, `WM_SIZING` on Windows) asks [`constrain`] for the size.
//! Locks are keyed by the native window handle, the only thing those callbacks know.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Smallest logical content size; matches the window builder's `min_inner_size`.
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

/// Which axis the user is dragging; the other one follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Drive {
    Width,
    Height,
}

/// The axis that changed more, relative to its size, between `current` and `proposed`. An edge
/// drag changes one axis only; a corner drag follows the larger move.
pub fn drive_from(current: (f64, f64), proposed: (f64, f64)) -> Drive {
    let dw = (proposed.0 - current.0).abs() / current.0.max(1.0);
    let dh = (proposed.1 - current.1).abs() / current.1.max(1.0);
    if dw > dh {
        Drive::Width
    } else {
        Drive::Height
    }
}

fn width_for(lock: &Lock, height: f64) -> f64 {
    (height - lock.chrome_height).max(1.0) * lock.aspect + lock.pad_x
}

fn height_for(lock: &Lock, width: f64) -> f64 {
    (width - lock.pad_x).max(1.0) / lock.aspect + lock.chrome_height
}

/// Logical content size for a proposed one: keep the driven axis, derive the other, then grow
/// both until the minimum size holds. Rounded to whole logical pixels.
pub fn constrain(lock: &Lock, proposed: (f64, f64), drive: Drive) -> (f64, f64) {
    let mut height = match drive {
        Drive::Width => height_for(lock, proposed.0),
        Drive::Height => proposed.1,
    };
    height = height.max(MIN_HEIGHT).max(height_for(lock, MIN_WIDTH));
    (width_for(lock, height).round(), height.round())
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
    fn the_axis_that_moved_more_drives() {
        assert_eq!(drive_from((400.0, 900.0), (450.0, 900.0)), Drive::Width);
        assert_eq!(drive_from((400.0, 900.0), (400.0, 950.0)), Drive::Height);
        assert_eq!(drive_from((400.0, 900.0), (440.0, 910.0)), Drive::Width);
        assert_eq!(drive_from((400.0, 900.0), (400.0, 900.0)), Drive::Height);
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
}
