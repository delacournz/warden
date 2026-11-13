//! macOS: constrain live resizes in `windowWillResize:toSize:`, with `windowWillStartLiveResize:`
//! / `windowDidEndLiveResize:` bracketing each drag so edge and corner drags are told apart
//! against the start size (`aspect::Session`).
//!
//! tao's `TaoWindowDelegate` implements none of these, so they are added to the class once at
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
    let native = sender as *const AnyObject as usize;
    let proposed_content = (content.width, content.height);
    let drive = aspect::drive_in_session(native, proposed_content)
        .unwrap_or_else(|| aspect::drive_from((current.width, current.height), proposed_content));
    let (w, h) = aspect::constrain(&lock, (content.width, content.height), drive);
    NSSize::new(w + frame_extra.0, h + frame_extra.1)
}

/// The NSWindow a window notification is about.
///
/// SAFETY: `notification` is an NSNotification posted by an NSWindow.
unsafe fn notified_window(notification: &AnyObject) -> *mut AnyObject {
    msg_send![notification, object]
}

extern "C-unwind" fn will_start_live_resize(
    _this: &AnyObject,
    _cmd: Sel,
    notification: &AnyObject,
) {
    // SAFETY: AppKit posts this with the window as the object; plain NSWindow getters.
    unsafe {
        let window = notified_window(notification);
        if window.is_null() || aspect::get(window as usize).is_none() {
            return;
        }
        let frame: NSRect = msg_send![window, frame];
        let content: NSRect = msg_send![window, contentRectForFrameRect: frame];
        aspect::begin(window as usize, (content.size.width, content.size.height));
    }
}

extern "C-unwind" fn did_end_live_resize(_this: &AnyObject, _cmd: Sel, notification: &AnyObject) {
    // SAFETY: AppKit posts this with the window as the object.
    let window = unsafe { notified_window(notification) };
    aspect::end(window as usize);
}

/// Add one method to tao's delegate class; an existing one is left as is.
///
/// SAFETY: `imp` must match `sel` and `types`.
unsafe fn add(class: &AnyClass, sel: Sel, imp: Imp, types: &std::ffi::CStr) {
    if !class_addMethod(
        class as *const AnyClass as *mut AnyClass,
        sel,
        imp,
        types.as_ptr(),
    )
    .as_bool()
    {
        log::warn!(
            "aspect: {} already defined on the window delegate, left as is",
            sel.name().to_string_lossy()
        );
    }
}

fn add_method() {
    static ADD: Once = Once::new();
    ADD.call_once(|| {
        let Some(class) = AnyClass::get(c"TaoWindowDelegate") else {
            log::warn!("aspect: TaoWindowDelegate not found, resizes are unconstrained");
            return;
        };
        type Resize = extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, NSSize) -> NSSize;
        type Notify = extern "C-unwind" fn(&AnyObject, Sel, &AnyObject);
        // SAFETY: each function's signature matches its selector and type encoding; the class is
        // tao's, registered before any window exists.
        unsafe {
            add(
                class,
                sel!(windowWillResize:toSize:),
                std::mem::transmute::<Resize, Imp>(will_resize),
                c"{CGSize=dd}@:@{CGSize=dd}",
            );
            add(
                class,
                sel!(windowWillStartLiveResize:),
                std::mem::transmute::<Notify, Imp>(will_start_live_resize),
                c"v@:@",
            );
            add(
                class,
                sel!(windowDidEndLiveResize:),
                std::mem::transmute::<Notify, Imp>(did_end_live_resize),
                c"v@:@",
            );
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
