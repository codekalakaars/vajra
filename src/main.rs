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
    /// Launch sandbox headless (no GUI)
    Launch {
        /// Environment variables (KEY=VALUE)
        #[arg(short = 'e', long = "env", value_name = "KEY=VALUE")]
        env: Vec<String>,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Launch { env }) => {
            let mut env_vars = std::collections::HashMap::new();
            for e in &env {
                if let Some((key, value)) = e.split_once('=') {
                    env_vars.insert(key.trim().to_string(), value.trim().to_string());
                }
            }
            let config = sandbox::SandboxConfig {
                project_dir: std::env::current_dir()?.to_string_lossy().to_string(),
                env_vars,
            };
            sandbox::launch_sandbox(config).map_err(|e| e.into())
        }
        None => {
            app::run_gui()?;
            Ok(())
        }
    }
}
