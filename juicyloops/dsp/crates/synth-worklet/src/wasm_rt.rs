//! Minimal no_std runtime for wasm32: a bump allocator and a panic handler.
//!
//! Allocation only happens at init time (engine construction), so memory is never freed. This keeps the
//! module free of imports and a few hundred bytes smaller than dlmalloc.

use core::alloc::{GlobalAlloc, Layout};
use core::arch::wasm32;

const PAGE: usize = 65_536;

struct Bump;

static mut NEXT: usize = 0;
static mut END: usize = 0;

unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: single-threaded wasm instance.
        unsafe {
            if NEXT == 0 {
                NEXT = wasm32::memory_size(0) * PAGE;
                END = NEXT;
            }
            let start = (NEXT + layout.align() - 1) & !(layout.align() - 1);
            let end = start + layout.size();
            if end > END {
                let pages = (end - END).div_ceil(PAGE);
                if wasm32::memory_grow(0, pages) == usize::MAX {
                    return core::ptr::null_mut();
                }
                END += pages * PAGE;
            }
            NEXT = end;
            start as *mut u8
        }
    }

    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
}

#[global_allocator]
static ALLOC: Bump = Bump;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    wasm32::unreachable()
}
