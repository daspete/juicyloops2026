//! The main thread with a display: a winit event loop that runs the engine's jobs between window events and makes
//! the windows plugin editors live in. On Linux it asks for X11 (plugin editors are X11 windows, also under
//! Wayland via XWayland).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalSize, Size};
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Icon, Window, WindowId};

use crate::engine::{Engine, MainMessage, Windows};
use crate::error::BridgeError;

/// The Juicy Loops icon of plugin windows: 64x64 RGBA rendered by `scripts/icons.sh`, so no image decoder is needed.
/// Windows and X11 show it; macOS shows the app bundle's icon instead, and Wayland has no per-window icons.
fn app_icon() -> Option<Icon> {
    Icon::from_rgba(include_bytes!("../assets/icon-64.rgba").to_vec(), 64, 64).ok()
}

/// Makes the event loop, or `None` when there is no display to talk to.
pub fn event_loop() -> Option<EventLoop<()>> {
    let mut builder = EventLoop::<()>::with_user_event();
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use winit::platform::x11::EventLoopBuilderExtX11;
        builder.with_x11();
    }
    match builder.build() {
        Ok(event_loop) => Some(event_loop),
        Err(error) => {
            log::info!("no display ({error}): plugin windows are off");
            None
        }
    }
}

/// The size units editors speak: logical points on macOS, pixels elsewhere.
fn editor_size(width: u32, height: u32) -> Size {
    if cfg!(target_os = "macos") { LogicalSize::new(width, height).into() } else { PhysicalSize::new(width, height).into() }
}

struct WinitWindows<'a> {
    event_loop: &'a ActiveEventLoop,
    windows: &'a mut HashMap<u32, Window>,
    ids: &'a mut HashMap<WindowId, u32>,
}

impl Windows for WinitWindows<'_> {
    fn available(&self) -> bool {
        true
    }

    fn open(&mut self, instance: u32, title: &str, width: u32, height: u32, resizable: bool) -> Result<RawWindowHandle, BridgeError> {
        self.close(instance);
        let attributes =
            Window::default_attributes().with_title(title).with_inner_size(editor_size(width, height)).with_resizable(resizable).with_window_icon(app_icon());
        let window = self.event_loop.create_window(attributes).map_err(|error| BridgeError::internal(format!("Could not make a window: {error}")))?;
        let handle = window.window_handle().map_err(|error| BridgeError::internal(format!("The window has no handle: {error}")))?.as_raw();
        self.ids.insert(window.id(), instance);
        self.windows.insert(instance, window);
        Ok(handle)
    }

    fn resize(&mut self, instance: u32, width: u32, height: u32) {
        if let Some(window) = self.windows.get(&instance) {
            let _ = window.request_inner_size(editor_size(width, height));
        }
    }

    fn close(&mut self, instance: u32) {
        if let Some(window) = self.windows.remove(&instance) {
            self.ids.remove(&window.id());
        }
    }
}

pub struct App {
    engine: Engine,
    receiver: Receiver<MainMessage>,
    windows: HashMap<u32, Window>,
    ids: HashMap<WindowId, u32>,
    quit: bool,
}

impl App {
    pub fn new(engine: Engine, receiver: Receiver<MainMessage>) -> Self {
        Self { engine, receiver, windows: HashMap::new(), ids: HashMap::new(), quit: false }
    }

    fn drain(&mut self, event_loop: &ActiveEventLoop) {
        while let Ok(message) = self.receiver.try_recv() {
            let mut windows = WinitWindows { event_loop, windows: &mut self.windows, ids: &mut self.ids };
            if !self.engine.handle(message, &mut windows) {
                self.quit = true;
            }
        }
        if self.quit {
            let mut windows = WinitWindows { event_loop, windows: &mut self.windows, ids: &mut self.ids };
            self.engine.shutdown(&mut windows);
            event_loop.exit();
        }
    }
}

impl ApplicationHandler<()> for App {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn user_event(&mut self, event_loop: &ActiveEventLoop, _event: ()) {
        self.drain(event_loop);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, window_id: WindowId, event: WindowEvent) {
        let Some(&instance) = self.ids.get(&window_id) else { return };
        match event {
            WindowEvent::CloseRequested => {
                let mut windows = WinitWindows { event_loop, windows: &mut self.windows, ids: &mut self.ids };
                self.engine.window_closed(instance, &mut windows);
            }
            WindowEvent::Resized(size) => {
                let scale = self.windows.get(&instance).map_or(1.0, |window| window.scale_factor());
                let mut windows = WinitWindows { event_loop, windows: &mut self.windows, ids: &mut self.ids };
                self.engine.window_resized(instance, size.width, size.height, scale, &mut windows);
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.drain(event_loop);
        self.engine.idle();
        // Plugins' timers want ticks every 10 ms or so, window or not.
        event_loop.set_control_flow(ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(10)));
    }
}

/// Runs the event loop until quit; returns when it ends.
pub fn run(event_loop: EventLoop<()>, engine: Engine, receiver: Receiver<MainMessage>) {
    let mut app = App::new(engine, receiver);
    if let Err(error) = event_loop.run_app(&mut app) {
        log::error!("the window loop failed: {error}");
    }
}
