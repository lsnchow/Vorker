use std::fs;
use std::io;
use std::time::{SystemTime, UNIX_EPOCH};

use vorker_tui::{RowKind, ThreadStore, TranscriptRow};

fn unique_temp_dir(name: &str) -> std::path::PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    std::env::temp_dir().join(format!("vorker-tui-{name}-{}-{suffix}", std::process::id()))
}

#[test]
fn thread_store_persists_threads_and_lists_them_by_recent_update() {
    let root = unique_temp_dir("thread-store");
    fs::create_dir_all(&root).expect("create temp root");

    let mut store = ThreadStore::open_at(root.join("threads.json")).expect("open store");
    let mut older = store.create_thread("/workspace/a");
    older.name = "Older".to_string();
    older.total_active_seconds = 8;
    older.rows.push(TranscriptRow {
        kind: RowKind::User,
        text: "older prompt".to_string(),
        detail: None,
    });
    store.upsert(older.clone()).expect("save older");

    let mut newer = store.create_thread("/workspace/b");
    newer.name = "Newer".to_string();
    newer.total_active_seconds = 42;
    store.upsert(newer.clone()).expect("save newer");

    let store = ThreadStore::open_at(root.join("threads.json")).expect("reload store");
    let listed = store.list_threads();

    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].name, "Newer");
    assert_eq!(listed[0].cwd, "/workspace/b");
    assert_eq!(listed[0].total_active_seconds, 42);
    assert_eq!(listed[1].name, "Older");

    let loaded = store.thread(&older.id).expect("load older");
    assert_eq!(loaded.rows.len(), 1);

    fs::remove_dir_all(root).ok();
}

#[test]
fn thread_store_rejects_corrupt_json_instead_of_erasing_it() {
    let root = unique_temp_dir("corrupt-thread-store");
    fs::create_dir_all(&root).expect("create temp root");
    let path = root.join("threads.json");
    fs::write(&path, "{not-json").expect("write corrupt store");

    let error = match ThreadStore::open_at(path) {
        Ok(_) => panic!("corrupt store should fail"),
        Err(error) => error,
    };

    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    fs::remove_dir_all(root).ok();
}
