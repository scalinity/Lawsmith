use std::collections::BTreeMap;

/// Native half of the qualification record (SPEC §13.1): facts only the shell can report.
#[tauri::command]
fn runtime_identity(app: tauri::AppHandle) -> BTreeMap<&'static str, String> {
    BTreeMap::from([
        ("tauri", tauri::VERSION.to_string()),
        (
            "webview",
            app.webview_version()
                .unwrap_or_else(|error| format!("unavailable: {error}")),
        ),
        ("arch", std::env::consts::ARCH.to_string()),
        (
            "build",
            if cfg!(debug_assertions) { "debug" } else { "release" }.to_string(),
        ),
    ])
}

/// Writes one qualification line to stderr, so dev and packaged runs leave a capturable record.
#[tauri::command]
fn report(line: String) {
    eprintln!("[lawsmith] {line}");
}

fn main() {
    tauri::Builder::default()
        .runtime(tauri_runtime_wry::Wry::default())
        .invoke_handler(tauri::generate_handler![runtime_identity, report])
        .run(tauri::generate_context!())
        .expect("error while running Lawsmith");
}
