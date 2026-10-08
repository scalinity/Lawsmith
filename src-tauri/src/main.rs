mod document_io;
mod recovery;

use std::{
    collections::BTreeMap,
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WindowEvent,
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

use document_io::{Destinations, IoFailure, Kind, RUN_LIMIT, SCENE_LIMIT, display_name, is_run_name, is_scene_name, read_bounded_utf8, replace_file};
use recovery::{RecoveryStore, Slots};

/// One value of a property list's `<key>` as the `<string>` that follows it, as SystemVersion.plist writes it.
fn plist_string(text: &str, key: &str) -> Option<String> {
    let after = &text[text.find(&format!("<key>{key}</key>"))?..];
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")?;
    Some(after[start..start + end].trim().to_string())
}

/// The macOS product version and build, read from the system's own record rather than inferred.
fn macos_version() -> (String, String) {
    match std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist") {
        Ok(text) => (
            plist_string(&text, "ProductVersion").unwrap_or_else(|| "unavailable: no ProductVersion".into()),
            plist_string(&text, "ProductBuildVersion").unwrap_or_else(|| "unavailable: no ProductBuildVersion".into()),
        ),
        Err(error) => (format!("unavailable: {error}"), format!("unavailable: {error}")),
    }
}

/// Native half of the qualification record (SPEC §13.1): facts only the shell can report. The Tauri
/// family is the one Cargo.lock resolved for this build (set by build.rs), not a guess from a version range.
#[tauri::command]
fn runtime_identity(app: AppHandle) -> BTreeMap<&'static str, String> {
    let (macos, macos_build) = macos_version();
    let info = app.package_info();
    BTreeMap::from([
        ("app", format!("{} {}", info.name, info.version)),
        ("macos", macos),
        ("macosBuild", macos_build),
        ("tauriRuntime", env!("LAWSMITH_LOCKED_TAURI_RUNTIME").to_string()),
        ("tauriRuntimeWry", env!("LAWSMITH_LOCKED_TAURI_RUNTIME_WRY").to_string()),
        ("wry", env!("LAWSMITH_LOCKED_WRY").to_string()),
        ("tao", env!("LAWSMITH_LOCKED_TAO").to_string()),
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
        (
            "recovery",
            if recovery_override().is_some() { "override" } else { "app-local" }.to_string(),
        ),
    ])
}

/// Writes one qualification line to stderr, so dev and packaged runs leave a capturable record.
#[tauri::command]
fn report(line: String) {
    eprintln!("[lawsmith] {line}");
}

/// Runs blocking file and dialog work off both the UI thread and the async workers.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, IoFailure> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| IoFailure::new("io", "task", e.to_string()))
}

fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "lowercase", rename_all_fields = "camelCase")]
enum OpenOutcome {
    Canceled,
    Opened { token: u64, name: String, text: String, read_ms: f64 },
}

/// Open Scene (SPEC §15.3): one native Open dialog, then a bounded strict UTF-8 read of exactly the
/// chosen file. The frontend validates the text; the destination token binds only if it commits.
#[tauri::command]
async fn open_scene(window: WebviewWindow, destinations: State<'_, Destinations>) -> Result<OpenOutcome, IoFailure> {
    let dialog = window.dialog().file().set_parent(&window).set_title("Open Scene").add_filter("Lawsmith scene", &["json"]);
    let Some(chosen) = blocking(move || dialog.blocking_pick_file()).await? else {
        return Ok(OpenOutcome::Canceled);
    };
    let path = chosen.into_path().map_err(|e| IoFailure::new("not-found", "dialog", e.to_string()))?;
    let start = Instant::now();
    let read_path = path.clone();
    let text = blocking(move || read_bounded_utf8(&read_path, SCENE_LIMIT)).await??;
    let read_ms = elapsed_ms(start);
    Ok(OpenOutcome::Opened { name: display_name(&path), token: destinations.issue(path, Kind::Scene), text, read_ms })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Read {
    text: String,
    read_ms: f64,
}

/// Reads the file behind a dialog-issued token again, bounded and strict UTF-8: an Open whose guard
/// saved first must commit what that file holds now.
#[tauri::command]
async fn read_scene(destinations: State<'_, Destinations>, token: u64) -> Result<Read, IoFailure> {
    let path = destinations.path(token, Kind::Scene).ok_or_else(|| IoFailure::new("unknown-destination", "read", "this file was not chosen in this session"))?;
    let start = Instant::now();
    let text = blocking(move || read_bounded_utf8(&path, SCENE_LIMIT)).await??;
    Ok(Read { text, read_ms: elapsed_ms(start) })
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
enum ChooseOutcome {
    Canceled,
    Chosen { token: u64, name: String },
    /// A name without the `.lawsmith.json` suffix: nothing is bound or written.
    Refused { name: String },
}

/// The Save Scene As dialog. Choosing a path is not a save: the token binds only after a write succeeds.
#[tauri::command]
async fn choose_scene_destination(window: WebviewWindow, destinations: State<'_, Destinations>, suggested_name: String) -> Result<ChooseOutcome, IoFailure> {
    let dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Save Scene As")
        .set_file_name(suggested_name)
        .add_filter("Lawsmith scene", &["json"]);
    let Some(chosen) = blocking(move || dialog.blocking_save_file()).await? else {
        return Ok(ChooseOutcome::Canceled);
    };
    let path = chosen.into_path().map_err(|e| IoFailure::new("not-found", "dialog", e.to_string()))?;
    let name = display_name(&path);
    // Renaming after the dialog could replace a file the user never confirmed, so refuse instead.
    if !is_scene_name(&name) {
        return Ok(ChooseOutcome::Refused { name });
    }
    Ok(ChooseOutcome::Chosen { name, token: destinations.issue(path, Kind::Scene) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Written {
    write_ms: f64,
}

/// Reliably replaces the file behind a dialog-issued token with `text`. Writes are serialized.
#[tauri::command]
async fn write_scene(destinations: State<'_, Destinations>, writes: State<'_, WriteLock>, token: u64, text: String) -> Result<Written, IoFailure> {
    let path = destinations.path(token, Kind::Scene).ok_or_else(|| IoFailure::new("unknown-destination", "write", "this destination was not chosen in this session"))?;
    if text.len() as u64 > SCENE_LIMIT {
        return Err(IoFailure::new("too-large", "write", "the scene exceeds 5 MiB"));
    }
    let lock = writes.0.clone();
    blocking(move || {
        let _serialized = lock.lock().unwrap();
        let start = Instant::now();
        replace_file(&path, |f| f.write_all(text.as_bytes())).map(|()| Written { write_ms: elapsed_ms(start) })
    })
    .await?
}

struct WriteLock(std::sync::Arc<std::sync::Mutex<()>>);

/// Open Recording (SPEC §15.3): the same narrow path as Open Scene, with the run kind and its 16 MiB bound.
#[tauri::command]
async fn open_run(window: WebviewWindow, destinations: State<'_, Destinations>) -> Result<OpenOutcome, IoFailure> {
    let dialog = window.dialog().file().set_parent(&window).set_title("Open Recording").add_filter("Lawsmith recording", &["json"]);
    let Some(chosen) = blocking(move || dialog.blocking_pick_file()).await? else {
        return Ok(OpenOutcome::Canceled);
    };
    let path = chosen.into_path().map_err(|e| IoFailure::new("not-found", "dialog", e.to_string()))?;
    let start = Instant::now();
    let read_path = path.clone();
    let text = blocking(move || read_bounded_utf8(&read_path, RUN_LIMIT)).await??;
    let read_ms = elapsed_ms(start);
    Ok(OpenOutcome::Opened { name: display_name(&path), token: destinations.issue(path, Kind::Run), text, read_ms })
}

/// Reads an opened recording again: an Open Recording whose guard saved first opens what the file holds now.
#[tauri::command]
async fn read_run(destinations: State<'_, Destinations>, token: u64) -> Result<Read, IoFailure> {
    let path = destinations.path(token, Kind::Run).ok_or_else(|| IoFailure::new("unknown-destination", "read", "this recording was not chosen in this session"))?;
    let start = Instant::now();
    let text = blocking(move || read_bounded_utf8(&path, RUN_LIMIT)).await??;
    Ok(Read { text, read_ms: elapsed_ms(start) })
}

/// The Save Recording dialog. A name without `.lawsmith-run.json` is refused, never renamed.
#[tauri::command]
async fn choose_run_destination(window: WebviewWindow, destinations: State<'_, Destinations>, suggested_name: String) -> Result<ChooseOutcome, IoFailure> {
    let dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Save Recording")
        .set_file_name(suggested_name)
        .add_filter("Lawsmith recording", &["json"]);
    let Some(chosen) = blocking(move || dialog.blocking_save_file()).await? else {
        return Ok(ChooseOutcome::Canceled);
    };
    let path = chosen.into_path().map_err(|e| IoFailure::new("not-found", "dialog", e.to_string()))?;
    let name = display_name(&path);
    if !is_run_name(&name) {
        return Ok(ChooseOutcome::Refused { name });
    }
    Ok(ChooseOutcome::Chosen { name, token: destinations.issue(path, Kind::Run) })
}

/// Reliably replaces the file behind a run token with the recording's complete text.
#[tauri::command]
async fn write_run(destinations: State<'_, Destinations>, writes: State<'_, WriteLock>, token: u64, text: String) -> Result<Written, IoFailure> {
    let path = destinations.path(token, Kind::Run).ok_or_else(|| IoFailure::new("unknown-destination", "write", "this destination was not chosen in this session"))?;
    if text.len() as u64 > RUN_LIMIT {
        return Err(IoFailure::new("too-large", "write", "the recording exceeds 16 MiB"));
    }
    let lock = writes.0.clone();
    blocking(move || {
        let _serialized = lock.lock().unwrap();
        let start = Instant::now();
        replace_file(&path, |f| f.write_all(text.as_bytes())).map(|()| Written { write_ms: elapsed_ms(start) })
    })
    .await?
}

#[tauri::command]
async fn recovery_load(store: State<'_, std::sync::Arc<RecoveryStore>>) -> Result<Slots, IoFailure> {
    let store = store.inner().clone();
    blocking(move || store.load()).await
}

#[tauri::command]
async fn recovery_write(store: State<'_, std::sync::Arc<RecoveryStore>>, generation: u64, revision: u64, text: String) -> Result<(), IoFailure> {
    let store = store.inner().clone();
    blocking(move || store.write(generation, revision, &text)).await?
}

#[tauri::command]
async fn recovery_retire(store: State<'_, std::sync::Arc<RecoveryStore>>, generation: u64, through: u64) -> Result<(), IoFailure> {
    let store = store.inner().clone();
    blocking(move || store.retire(generation, through)).await?
}

/// The frontend validated the earlier session's current snapshot at launch.
#[tauri::command]
async fn recovery_current_valid(store: State<'_, std::sync::Arc<RecoveryStore>>) -> Result<(), IoFailure> {
    let store = store.inner().clone();
    blocking(move || store.validated_current()).await
}

/// Retires a generation's recovery entirely (an accepted Discard).
#[tauri::command]
async fn recovery_discard(store: State<'_, std::sync::Arc<RecoveryStore>>, generation: u64) -> Result<(), IoFailure> {
    let store = store.inner().clone();
    blocking(move || store.retire(generation, u64::MAX)).await?
}

/// Discards the unsaved work an earlier session left (the launch offer's Discard).
#[tauri::command]
async fn recovery_discard_earlier(store: State<'_, std::sync::Arc<RecoveryStore>>) -> Result<(), IoFailure> {
    let store = store.inner().clone();
    blocking(move || store.discard_earlier()).await?
}

/// The unsaved-work guard's native alert: Save, Don't Save (⌘D) or Cancel (Esc).
#[tauri::command]
async fn ask_unsaved(window: WebviewWindow, title: String) -> Result<&'static str, IoFailure> {
    let dialog = window
        .dialog()
        .message("Your changes will be lost if you don't save them.")
        .title(format!("Do you want to save the changes you made to “{title}”?"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom("Save".into(), "Don't Save".into(), "Cancel".into()))
        .parent(&window);
    let result = blocking(move || dialog.blocking_show_with_result()).await?;
    Ok(match result {
        MessageDialogResult::Custom(label) if label == "Save" => "save",
        MessageDialogResult::Custom(label) if label == "Don't Save" => "discard",
        _ => "cancel",
    })
}

/// The guard's alert for an unsaved recording: Save Recording (then its dialog), Don't Save, or Cancel.
#[tauri::command]
async fn ask_unsaved_recording(window: WebviewWindow, title: String, detail: String) -> Result<&'static str, IoFailure> {
    let dialog = window
        .dialog()
        .message(detail)
        .title(format!("Do you want to save the recording of “{title}”?"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom("Save Recording…".into(), "Don't Save".into(), "Cancel".into()))
        .parent(&window);
    let result = blocking(move || dialog.blocking_show_with_result()).await?;
    Ok(match result {
        MessageDialogResult::Custom(label) if label == "Save Recording…" => "save",
        MessageDialogResult::Custom(label) if label == "Don't Save" => "discard",
        _ => "cancel",
    })
}

/// Close and Quit wait for the frontend's guard once it is ready; before that they proceed normally.
#[derive(Default)]
struct Guard {
    ready: AtomicBool,
    exiting: AtomicBool,
    /// The frontend's report of unsaved changes, for quit requests AppKit must answer synchronously.
    dirty: AtomicBool,
}

impl Guard {
    fn intercepts(&self) -> bool {
        self.ready.load(Ordering::SeqCst) && !self.exiting.load(Ordering::SeqCst)
    }
}

#[tauri::command]
fn guard_ready(guard: State<'_, Guard>) {
    guard.ready.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn guard_state(guard: State<'_, Guard>, dirty: bool) {
    guard.dirty.store(dirty, Ordering::SeqCst);
}

/// Dock Quit, logout and an Apple Event quit send `terminate:`, which TAO's app delegate does not
/// answer, so the process would end without the guard. This adds the public delegate method
/// `applicationShouldTerminate:` to TAO's delegate class. It proceeds at once only when nothing could
/// be lost or come back as unsaved: no unsaved changes and no recovery snapshot held, so a clean
/// Lawsmith never blocks a logout. Otherwise it cancels the termination and runs the shared guard,
/// which finishes or refuses a pending recovery retirement and exits through `exit_app`.
#[cfg(target_os = "macos")]
mod terminate {
    use std::sync::{OnceLock, atomic::Ordering};

    use objc2::{
        ffi,
        runtime::{AnyClass, AnyObject, Imp, Sel},
        sel,
    };
    use tauri::{AppHandle, Manager};

    use crate::recovery::RecoveryStore;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    const TERMINATE_CANCEL: usize = 0;
    const TERMINATE_NOW: usize = 1;

    extern "C-unwind" fn should_terminate(_this: &AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
        let Some(app) = APP.get() else { return TERMINATE_NOW };
        let guard = app.state::<super::Guard>();
        if !guard.intercepts() || (!guard.dirty.load(Ordering::SeqCst) && app.state::<std::sync::Arc<RecoveryStore>>().close_if_empty()) {
            return TERMINATE_NOW;
        }
        super::request_guard(app, "quit");
        TERMINATE_CANCEL
    }

    /// True when the method was added; false if the class is missing or already answers it.
    pub fn install(app: AppHandle) -> bool {
        let _ = APP.set(app);
        let Some(class) = AnyClass::get(c"TaoAppDelegateParent") else { return false };
        let method: extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize = should_terminate;
        // SAFETY: the type encoding "Q@:@" matches the signature: NSUInteger return, self, _cmd, sender.
        unsafe {
            let imp: Imp = std::mem::transmute(method);
            ffi::class_addMethod(class as *const AnyClass as *mut AnyClass, sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr()).as_bool()
        }
    }
}

/// Exits after the frontend's guard has committed.
#[tauri::command]
fn exit_app(app: AppHandle, guard: State<'_, Guard>) {
    guard.exiting.store(true, Ordering::SeqCst);
    app.exit(0);
}

const QUIT_ID: &str = "lawsmith-quit";

/// Tauri's default macOS menu with one change: Quit is Lawsmith's own item. The predefined one sends
/// `terminate:`, which this TAO release cannot intercept, so it would skip the unsaved-work guard.
fn menu<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let about = AboutMetadata { name: Some(info.name.clone()), version: Some(info.version.to_string()), ..Default::default() };
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, QUIT_ID, format!("Quit {}", info.name), true, Some("CmdOrCtrl+Q"))?,
                ],
            )?,
            &Submenu::with_items(app, "File", true, &[&PredefinedMenuItem::close_window(app, None)?])?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
        ],
    )
}

/// Asks the frontend to run the shared guard for a close or quit request.
fn request_guard<R: tauri::Runtime>(app: &AppHandle<R>, request: &str) {
    let _ = app.emit("lawsmith://guard-request", request);
}

/// `LAWSMITH_RECOVERY_DIR` isolates recovery state for QA runs, so tests never touch the owner's.
fn recovery_override() -> Option<PathBuf> {
    std::env::var_os("LAWSMITH_RECOVERY_DIR").filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn main() {
    let app = tauri::Builder::default()
        .runtime(tauri_runtime_wry::Wry::default())
        .plugin(tauri_plugin_dialog::init())
        .menu(menu)
        .on_menu_event(|app, event| {
            if event.id() == QUIT_ID {
                if app.state::<Guard>().intercepts() {
                    request_guard(app, "quit");
                } else {
                    app.state::<Guard>().exiting.store(true, Ordering::SeqCst);
                    app.exit(0);
                }
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<Guard>().intercepts() {
                    api.prevent_close();
                    request_guard(window.app_handle(), "close");
                }
            }
        })
        .manage(Destinations::default())
        .manage(Guard::default())
        .manage(WriteLock(Default::default()))
        .setup(|app| {
            let dir = match recovery_override() {
                Some(dir) => dir,
                None => app.path().app_local_data_dir()?.join("recovery"),
            };
            app.manage(std::sync::Arc::new(RecoveryStore::new(dir)));
            #[cfg(target_os = "macos")]
            eprintln!("[lawsmith] {{\"kind\":\"native\",\"terminateGuard\":{}}}", terminate::install(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_identity,
            report,
            open_scene,
            read_scene,
            choose_scene_destination,
            write_scene,
            recovery_load,
            recovery_write,
            recovery_retire,
            recovery_current_valid,
            recovery_discard,
            recovery_discard_earlier,
            ask_unsaved,
            open_run,
            read_run,
            choose_run_destination,
            write_run,
            ask_unsaved_recording,
            guard_ready,
            guard_state,
            exit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lawsmith");
    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if app.state::<Guard>().intercepts() {
                api.prevent_exit();
                request_guard(app, "quit");
            }
        }
    });
}
