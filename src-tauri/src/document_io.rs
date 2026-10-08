//! The narrow native document-I/O helper (SPEC §15.3). It owns dialog-issued destinations,
//! bounded strict UTF-8 reads and reliable file replacement. Scene semantics, validation,
//! revisions and dirty state stay in the frontend; nothing here parses a scene.

use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::Serialize;

/// SPEC §15.2 scene file limit.
pub const SCENE_LIMIT: u64 = 5 * 1024 * 1024;
/// SPEC §15.2 run file limit: the complete recording, 16 MiB.
pub const RUN_LIMIT: u64 = 16 * 1024 * 1024;

/// What a dialog-issued destination holds. A token serves only its own kind, so a scene's destination
/// can never receive a recording, or the reverse (SPEC §15.3: the app never confuses the two).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Scene,
    Run,
}

/// A failed file operation, reported distinctly by kind and by the stage that failed.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IoFailure {
    pub kind: &'static str,
    pub stage: &'static str,
    pub message: String,
}

impl IoFailure {
    pub fn new(kind: &'static str, stage: &'static str, message: impl Into<String>) -> Self {
        Self { kind, stage, message: message.into() }
    }

    pub fn io(stage: &'static str, error: io::Error) -> Self {
        Self::new(classify(&error), stage, error.to_string())
    }
}

/// Permission, disk-full and read-only failures are named, so the user is told what happened.
fn classify(error: &io::Error) -> &'static str {
    use io::ErrorKind::*;
    match error.kind() {
        PermissionDenied => "permission",
        StorageFull | QuotaExceeded => "disk-full",
        ReadOnlyFilesystem => "read-only",
        NotFound => "not-found",
        FileTooLarge => "too-large",
        _ => match error.raw_os_error() {
            Some(1) | Some(13) => "permission",
            Some(28) | Some(69) => "disk-full",
            Some(30) => "read-only",
            _ => "io",
        },
    }
}

/// Session-local destinations, each issued by a native dialog result. The frontend holds only the
/// opaque token, never a path, and tokens do not survive a restart (SPEC §15.3).
#[derive(Default)]
pub struct Destinations {
    next: AtomicU64,
    paths: Mutex<HashMap<u64, (Kind, PathBuf)>>,
}

impl Destinations {
    pub fn issue(&self, path: PathBuf, kind: Kind) -> u64 {
        let token = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.paths.lock().unwrap().insert(token, (kind, path));
        token
    }

    /// The path behind a token of `kind`; none for an unknown token or one issued for the other kind.
    pub fn path(&self, token: u64, kind: Kind) -> Option<PathBuf> {
        self.paths.lock().unwrap().get(&token).filter(|(k, _)| *k == kind).map(|(_, p)| p.clone())
    }
}

/// Display name of a destination: its file name only, so paths never reach the frontend.
pub fn display_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Scene files keep the explicit `.lawsmith.json` suffix (SPEC §15.3).
pub fn is_scene_name(name: &str) -> bool {
    name.len() > ".lawsmith.json".len() && name.ends_with(".lawsmith.json")
}

/// Recordings keep the explicit `.lawsmith-run.json` suffix (SPEC §15.1).
pub fn is_run_name(name: &str) -> bool {
    name.len() > ".lawsmith-run.json".len() && name.ends_with(".lawsmith-run.json")
}

/// Reads a regular file as strict UTF-8, enforcing `limit` before and during the read, so a file
/// that grows while being read cannot bypass the bound.
pub fn read_bounded_utf8(path: &Path, limit: u64) -> Result<String, IoFailure> {
    let file = File::open(path).map_err(|e| IoFailure::io("open", e))?;
    let metadata = file.metadata().map_err(|e| IoFailure::io("open", e))?;
    if !metadata.is_file() {
        return Err(IoFailure::new("not-a-file", "open", "the selection is not a regular file"));
    }
    if metadata.len() > limit {
        return Err(IoFailure::new("too-large", "open", format!("the file is larger than {limit} bytes")));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|e| IoFailure::io("read", e))?;
    if bytes.len() as u64 > limit {
        return Err(IoFailure::new("too-large", "read", format!("the file grew beyond {limit} bytes while being read")));
    }
    String::from_utf8(bytes).map_err(|e| IoFailure::new("not-utf8", "decode", format!("the file is not UTF-8 ({e})")))
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Creates a unique temporary sibling of `target` exclusively, so no existing file is touched.
fn create_temp_sibling(dir: &Path, name: &str) -> Result<(PathBuf, File), IoFailure> {
    for _ in 0..32 {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(".{name}.{}-{n}.lawsmith-tmp", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(IoFailure::io("create-temp", e)),
        }
    }
    Err(IoFailure::new("io", "create-temp", "no unique temporary name was available"))
}

/// Durability of a completed rename: synchronize the directory entry.
fn sync_directory(dir: &Path) -> Result<(), IoFailure> {
    File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(|e| IoFailure::new("uncertain", "sync-directory", format!("the file was replaced, but its directory could not be synchronized ({e})")))
}

/// Replaces `target` reliably (SPEC §15.3): write a unique temporary sibling completely, flush it
/// to storage and close it, then rename it over the target on the same filesystem. The prior file
/// is never truncated; any failure before the rename leaves it intact and removes the temporary.
///
/// `write` produces the bytes; tests inject failures through it. On macOS, `File::sync_all` issues
/// `F_FULLFSYNC`. A read-only target is refused rather than silently replaced, and a symlinked
/// target is resolved so the link survives. Permissions of an existing target carry over.
pub fn replace_file(target: &Path, write: impl FnOnce(&mut File) -> io::Result<()>) -> Result<(), IoFailure> {
    let target = match fs::symlink_metadata(target) {
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(target).map_err(|e| IoFailure::io("resolve", e))?,
        _ => target.to_path_buf(),
    };
    let existing = match fs::metadata(&target) {
        Ok(m) => Some(m),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(IoFailure::io("inspect", e)),
    };
    if let Some(m) = &existing {
        if !m.is_file() {
            return Err(IoFailure::new("not-a-file", "inspect", "the destination is not a regular file"));
        }
        if m.permissions().readonly() {
            return Err(IoFailure::new("permission", "inspect", "the destination file is read-only"));
        }
    }
    let dir = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (temp, mut file) = create_temp_sibling(dir, &name)?;
    let staged = (|| {
        write(&mut file).map_err(|e| IoFailure::io("write", e))?;
        if let Some(m) = &existing {
            file.set_permissions(m.permissions()).map_err(|e| IoFailure::io("permissions", e))?;
        }
        file.sync_all().map_err(|e| IoFailure::io("sync", e))?;
        drop(file);
        fs::rename(&temp, &target).map_err(|e| IoFailure::io("rename", e))
    })();
    if let Err(failure) = staged {
        let _ = fs::remove_file(&temp);
        return Err(failure);
    }
    sync_directory(dir)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{io::Write, os::unix::fs::PermissionsExt};

    /// A fresh disposable directory under the system temporary directory; never the owner's files.
    pub fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lawsmith-m2-{name}-{}-{}", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".lawsmith-tmp")).collect()
    }

    #[test]
    fn replaces_and_creates() {
        let dir = scratch("replace");
        let target = dir.join("scene.lawsmith.json");
        replace_file(&target, |f| f.write_all(b"first")).unwrap();
        replace_file(&target, |f| f.write_all(b"second")).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "second");
        assert!(leftovers(&dir).is_empty());
    }

    #[test]
    fn write_failure_preserves_the_existing_file() {
        let dir = scratch("write-failure");
        let target = dir.join("scene.lawsmith.json");
        fs::write(&target, "original").unwrap();
        // A partial write that then fails, as a full disk would.
        let result = replace_file(&target, |f| {
            f.write_all(b"partial")?;
            Err(io::Error::from_raw_os_error(28))
        });
        let failure = result.unwrap_err();
        assert_eq!((failure.kind, failure.stage), ("disk-full", "write"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");
        assert!(leftovers(&dir).is_empty());
    }

    #[test]
    fn denied_directory_is_reported_and_preserves_the_existing_file() {
        let dir = scratch("denied");
        let target = dir.join("scene.lawsmith.json");
        fs::write(&target, "original").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let failure = replace_file(&target, |f| f.write_all(b"new")).unwrap_err();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!((failure.kind, failure.stage), ("permission", "create-temp"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");
    }

    #[test]
    fn read_only_target_is_refused_not_replaced() {
        let dir = scratch("read-only");
        let target = dir.join("scene.lawsmith.json");
        fs::write(&target, "original").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o444)).unwrap();
        let failure = replace_file(&target, |f| f.write_all(b"new")).unwrap_err();
        assert_eq!((failure.kind, failure.stage), ("permission", "inspect"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");
        assert!(leftovers(&dir).is_empty());
    }

    #[test]
    fn failed_rename_preserves_the_existing_file_and_removes_the_temporary() {
        let dir = scratch("rename");
        // A Finder-locked file (user immutable flag) passes the permission check and takes the
        // complete temporary write; only the final rename is refused.
        let target = dir.join("scene.lawsmith.json");
        fs::write(&target, "original").unwrap();
        assert!(std::process::Command::new("chflags").arg("uchg").arg(&target).status().unwrap().success());
        let result = replace_file(&target, |f| f.write_all(b"new"));
        assert!(std::process::Command::new("chflags").arg("nouchg").arg(&target).status().unwrap().success());
        let failure = result.unwrap_err();
        assert_eq!((failure.kind, failure.stage), ("permission", "rename"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");
        assert!(leftovers(&dir).is_empty());
    }

    #[test]
    fn a_directory_at_the_destination_is_refused() {
        let dir = scratch("directory");
        let target = dir.join("scene.lawsmith.json");
        fs::create_dir(&target).unwrap();
        let failure = replace_file(&target, |f| f.write_all(b"new")).unwrap_err();
        assert_eq!((failure.kind, failure.stage), ("not-a-file", "inspect"));
        assert!(leftovers(&dir).is_empty());
    }

    #[test]
    fn existing_permissions_carry_over_and_symlinks_survive() {
        let dir = scratch("perms");
        let real = dir.join("real.lawsmith.json");
        fs::write(&real, "original").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.join("link.lawsmith.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        replace_file(&link, |f| f.write_all(b"new")).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
        assert_eq!(fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn bounded_read_rejects_oversized_and_non_utf8_files() {
        let dir = scratch("read");
        let ok = dir.join("ok.json");
        fs::write(&ok, "{\"a\": \"é\"}").unwrap();
        assert_eq!(read_bounded_utf8(&ok, 64).unwrap(), "{\"a\": \"é\"}");
        let big = dir.join("big.json");
        fs::write(&big, vec![b' '; 65]).unwrap();
        assert_eq!(read_bounded_utf8(&big, 64).unwrap_err().kind, "too-large");
        let latin1 = dir.join("latin1.json");
        fs::write(&latin1, [b'"', 0xe9, b'"']).unwrap();
        assert_eq!(read_bounded_utf8(&latin1, 64).unwrap_err().kind, "not-utf8");
        assert_eq!(read_bounded_utf8(&dir, 64).unwrap_err().kind, "not-a-file");
        assert_eq!(read_bounded_utf8(&dir.join("absent"), 64).unwrap_err().kind, "not-found");
    }

    #[test]
    fn scene_names_keep_the_double_suffix() {
        assert!(is_scene_name("Falling stream.lawsmith.json"));
        assert!(!is_scene_name("foo.json"));
        assert!(!is_scene_name("foo"));
        assert!(!is_scene_name(".lawsmith.json"));
    }

    #[test]
    fn tokens_are_opaque_and_session_local() {
        let destinations = Destinations::default();
        let a = destinations.issue(PathBuf::from("/tmp/a.lawsmith.json"), Kind::Scene);
        let b = destinations.issue(PathBuf::from("/tmp/b.lawsmith.json"), Kind::Scene);
        assert_ne!(a, b);
        assert_eq!(destinations.path(a, Kind::Scene).unwrap(), PathBuf::from("/tmp/a.lawsmith.json"));
        assert!(destinations.path(999, Kind::Scene).is_none());
        assert_eq!(display_name(Path::new("/x/y/scene.lawsmith.json")), "scene.lawsmith.json");
    }

    #[test]
    fn a_token_serves_only_its_own_kind() {
        let destinations = Destinations::default();
        let scene = destinations.issue(PathBuf::from("/tmp/a.lawsmith.json"), Kind::Scene);
        let run = destinations.issue(PathBuf::from("/tmp/a.lawsmith-run.json"), Kind::Run);
        assert!(destinations.path(scene, Kind::Run).is_none());
        assert!(destinations.path(run, Kind::Scene).is_none());
        assert_eq!(destinations.path(run, Kind::Run).unwrap(), PathBuf::from("/tmp/a.lawsmith-run.json"));
    }

    #[test]
    fn run_names_keep_their_suffix_and_never_pass_as_scenes() {
        assert!(is_run_name("Storm bottle recording.lawsmith-run.json"));
        assert!(!is_run_name(".lawsmith-run.json"));
        assert!(!is_run_name("storm.lawsmith.json"));
        assert!(!is_run_name("storm.json"));
        assert!(!is_scene_name("storm.lawsmith-run.json"));
    }

    #[test]
    fn a_run_reads_to_its_own_limit() {
        let dir = scratch("run-limit");
        let at_limit = dir.join("full.lawsmith-run.json");
        fs::write(&at_limit, vec![b' '; RUN_LIMIT as usize]).unwrap();
        assert_eq!(read_bounded_utf8(&at_limit, RUN_LIMIT).unwrap().len() as u64, RUN_LIMIT);
        let over = dir.join("over.lawsmith-run.json");
        fs::write(&over, vec![b' '; RUN_LIMIT as usize + 1]).unwrap();
        assert_eq!(read_bounded_utf8(&over, RUN_LIMIT).unwrap_err().kind, "too-large");
        // The scene limit stays the scene's.
        assert_eq!(read_bounded_utf8(&at_limit, SCENE_LIMIT).unwrap_err().kind, "too-large");
    }
}
