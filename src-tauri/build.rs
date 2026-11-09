fn main() {
    // menu.rs embeds the Japanese UI strings.
    println!("cargo:rerun-if-changed=../src/i18n/ja.json");
    tauri_build::build()
}
