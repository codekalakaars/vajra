slint::include_modules!();

pub fn run_gui() -> Result<(), slint::PlatformError> {
    let ui = AppWindow::new()?;

    let dir = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    ui.set_project_dir(dir.into());
    ui.set_status_text("Running".into());

    let ui_handle = ui.as_weak();
    ui.on_quit(move || {
        let ui = ui_handle.unwrap();
        let _ = ui.window().hide();
    });

    ui.run()
}
