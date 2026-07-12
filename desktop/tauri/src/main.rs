// LeLab desktop shell.
//
// Lifecycle:
//   1. On setup, spawn the frozen backend bundle (resources/backend/lelab-backend)
//      as a child process. It serves the API + UI on 127.0.0.1:8000.
//   2. Poll the port until it answers, then open a window pointing at it.
//   3. On exit, kill the backend child so no orphan uvicorn survives.
//
// The backend is a one-folder PyInstaller bundle staged by desktop/build.sh into
// resources/backend/ and declared under bundle.resources in tauri.conf.json.

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const BACKEND_ADDR: &str = "127.0.0.1:8000";
const BACKEND_URL: &str = "http://127.0.0.1:8000/";

// Keep the child handle so we can kill it on shutdown.
struct Backend(Mutex<Option<Child>>);

fn backend_binary_name() -> &'static str {
    if cfg!(windows) {
        "lelab-backend.exe"
    } else {
        "lelab-backend"
    }
}

fn wait_for_port(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(BACKEND_ADDR).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

fn main() {
    tauri::Builder::default()
        .manage(Backend(Mutex::new(None)))
        .setup(|app| {
            // resources/backend/ -> <bundle-resources>/backend/
            let backend_dir = app
                .path()
                .resource_dir()
                .expect("resource dir")
                .join("backend");
            let exe = backend_dir.join(backend_binary_name());

            let child = Command::new(&exe)
                .current_dir(&backend_dir)
                .spawn()
                .unwrap_or_else(|e| panic!("failed to start backend {exe:?}: {e}"));
            app.state::<Backend>().0.lock().unwrap().replace(child);

            // Open the window only once the server answers, so the user never
            // sees a connection-refused page.
            let handle = app.handle().clone();
            thread::spawn(move || {
                if !wait_for_port(Duration::from_secs(60)) {
                    eprintln!("backend never came up on {BACKEND_ADDR}");
                    handle.exit(1);
                    return;
                }
                let _ = WebviewWindowBuilder::new(
                    &handle,
                    "main",
                    WebviewUrl::External(BACKEND_URL.parse().unwrap()),
                )
                .title("Nori Lab")
                .inner_size(1400.0, 900.0)
                .resizable(true)
                .build();
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // When the last window closes, tear down the backend child.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(mut child) = window.state::<Backend>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running LeLab");
}
