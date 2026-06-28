slint::include_modules!();

pub fn run_gui() -> Result<(), slint::PlatformError> {
    let ui = AppWindow::new()?;

    let dir = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    ui.set_project_dir(dir.into());

    let ui_handle = ui.as_weak();
    ui.on_launch_sandbox(move || {
        let ui = ui_handle.unwrap();
        let config = crate::sandbox::SandboxConfig {
            project_dir: ui.get_project_dir().to_string(),
        };
        ui.set_status_text("Launching sandbox...".into());
        match crate::sandbox::launch_sandbox(config) {
            Ok(()) => ui.set_status_text("Sandbox exited".into()),
            Err(e) => ui.set_status_text(format!("Error: {}", e).into()),
        }
    });

    let ui_handle = ui.as_weak();
    ui.on_quit(move || {
        let ui = ui_handle.unwrap();
        let _ = ui.window().hide();
    });

    ui.run()
}
