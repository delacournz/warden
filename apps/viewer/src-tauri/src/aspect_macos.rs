//! macOS: constrain live resizes in `windowWillResize:toSize:`.
//!
//! tao's `TaoWindowDelegate` does not implement that method, so it is added to the class once at
//! runtime. AppKit caches which delegate methods exist when the delegate is set, so each window's
//! delegate is set again after the method is added. Without a lock the proposed size is returned
//! unchanged.

use crate::aspect;
use objc2::ffi::class_addMethod;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::sel;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use std::sync::Once;

extern "C-unwind" fn will_resize(
    _this: &AnyObject,
    _cmd: Sel,
    sender: &AnyObject,
    proposed: NSSize,
) -> NSSize {
    let Some(lock) = aspect::get(sender as *const AnyObject as usize) else {
        return proposed;
    };
    let zero = NSPoint::new(0.0, 0.0);
    // SAFETY: `sender` is the NSWindow being resized; these are plain NSWindow getters.
    let (current, content, frame_extra) = unsafe {
        let frame: NSRect = msg_send![sender, frame];
        let content: NSRect =
            msg_send![sender, contentRectForFrameRect: NSRect::new(zero, proposed)];
        let current: NSRect = msg_send![sender, contentRectForFrameRect: frame];
        let extra = (
            proposed.width - content.size.width,
            proposed.height - content.size.height,
        );
        (current.size, content.size, extra)
    };
    let drive = aspect::drive_from(
        (current.width, current.height),
        (content.width, content.height),
    );
    let (w, h) = aspect::constrain(&lock, (content.width, content.height), drive);
    NSSize::new(w + frame_extra.0, h + frame_extra.1)
}

fn add_method() {
    static ADD: Once = Once::new();
    ADD.call_once(|| {
        let Some(class) = AnyClass::get(c"TaoWindowDelegate") else {
            log::warn!("aspect: TaoWindowDelegate not found, resizes are unconstrained");
            return;
        };
        // SAFETY: the signature matches `-(NSSize)windowWillResize:(NSWindow *)toSize:(NSSize)`
        // and the type encoding below; the class is tao's, registered before any window exists.
        unsafe {
            let imp: Imp = std::mem::transmute::<
                extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, NSSize) -> NSSize,
                Imp,
            >(will_resize);
            let added = class_addMethod(
                class as *const AnyClass as *mut AnyClass,
                sel!(windowWillResize:toSize:),
                imp,
                c"{CGSize=dd}@:@{CGSize=dd}".as_ptr(),
            );
            if !added.as_bool() {
                log::warn!("aspect: windowWillResize:toSize: already defined, left as is");
            }
        }
    });
}

/// Install the resize hook for one window. Main thread only.
pub fn install(ns_window: usize) {
    add_method();
    let window = ns_window as *mut AnyObject;
    // SAFETY: a live NSWindow on the main thread; tao keeps its delegate alive, so clearing the
    // (unretained) delegate for one call cannot free it.
    unsafe {
        let delegate: *mut AnyObject = msg_send![window, delegate];
        if delegate.is_null() {
            return;
        }
        let none: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![window, setDelegate: none];
        let _: () = msg_send![window, setDelegate: delegate];
    }
}
