mod app;
mod landlock;
mod sandbox;

use clap::{Parser, Subcommand};
use nix::sys::signal::{kill, Signal};
use nix::unistd::{fork, ForkResult};

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
            let gui_pid = match unsafe { fork() }? {
                ForkResult::Child => {
                    app::run_gui()?;
                    std::process::exit(0);
                }
                ForkResult::Parent { child } => child,
            };

            let config = sandbox::SandboxConfig {
                project_dir: std::env::current_dir()?.to_string_lossy().to_string(),
            };

            let result = sandbox::launch_sandbox(config);
            let _ = kill(gui_pid, Signal::SIGTERM);
            result.map_err(|e| e.into())
        }
        None => {
            app::run_gui()?;
            Ok(())
        }
    }
}
