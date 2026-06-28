mod app;
mod landlock;
mod sandbox;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "vajra", about = "A lightweight Linux sandbox for AI agents")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Launch sandbox in current directory
    Launch,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Launch) => {
            let config = sandbox::SandboxConfig {
                project_dir: std::env::current_dir()?.to_string_lossy().to_string(),
            };
            sandbox::launch_sandbox(config).map_err(|e| e.into())
        }
        None => {
            app::run_gui()?;
            Ok(())
        }
    }
}
