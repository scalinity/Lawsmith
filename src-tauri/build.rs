// The locked Tauri family (SPEC §13.1): the versions Cargo.lock resolved for this build, recorded in
// the binary so the runtime identity reports what was built rather than a version range.
fn locked(lock: &str, name: &str) -> String {
    let marker = format!("name = \"{name}\"\nversion = \"");
    let versions: Vec<&str> = lock.match_indices(&marker).filter_map(|(i, _)| lock[i + marker.len()..].split('"').next()).collect();
    if versions.is_empty() { "unavailable: not in Cargo.lock".to_string() } else { versions.join(" + ") }
}

fn main() {
    println!("cargo:rerun-if-changed=Cargo.lock");
    let lock = std::fs::read_to_string("Cargo.lock").unwrap_or_default();
    for (name, var) in [("tauri-runtime", "TAURI_RUNTIME"), ("tauri-runtime-wry", "TAURI_RUNTIME_WRY"), ("wry", "WRY"), ("tao", "TAO")] {
        println!("cargo:rustc-env=LAWSMITH_LOCKED_{var}={}", locked(&lock, name));
    }
    tauri_build::build()
}
