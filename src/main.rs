use std::sync::Arc;

use vajra::{envfile, envpick, sandbox, supervisor};

use clap::{Parser, Subcommand};
use nix::sys::wait::waitpid;
use nix::unistd::{fork, ForkResult};

#[derive(Parser)]
#[command(name = "vajra", about = "A lightweight Linux sandbox for AI agents")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Launch sandbox in current directory
    Launch {
        /// Env file the supervisor loads for runs (skips the picker)
        #[arg(long)]
        env: Option<String>,
        /// Sample env file left visible to the agent (skips the picker)
        #[arg(long)]
        sample: Option<String>,
    },
    /// Run the project app via the supervisor (use inside the sandbox)
    Run {
        /// package.json script to run (default: dev, falling back to start)
        script: Option<String>,
        /// Stop the currently running app
        #[arg(long)]
        stop: bool,
    },
}

fn launch(env: Option<String>, sample: Option<String>) -> Result<(), Box<dyn std::error::Error>> {
    let project_dir = std::env::current_dir()?;

    let selection = envpick::select(&project_dir, env, sample)?;

    if let (Some(original), Some(sample)) = (&selection.original, &selection.sample)
        && envfile::ensure_sample(original, sample)? {
            println!("vajra: generated {} from {} keys", sample.display(), original.display());
        }

    let sup = Arc::new(supervisor::Supervisor::new(
        project_dir.clone(),
        selection.original.clone(),
    ));
    let listener = sup.bind()?;
    let sock_path = supervisor::socket_path();

    match unsafe { fork() }? {
        ForkResult::Child => {
            drop(listener);
            let config = sandbox::SandboxConfig {
                project_dir: project_dir.to_string_lossy().to_string(),
                masked_files: selection.masked,
                sock_path: Some(sock_path.to_string_lossy().to_string()),
            };
            let code = match sandbox::launch_sandbox(config) {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("vajra: {}", e);
                    1
                }
            };
            std::process::exit(code);
        }
        ForkResult::Parent { child } => {
            {
                let sup = Arc::clone(&sup);
                std::thread::spawn(move || sup.serve(listener));
            }
            let status = waitpid(child, None);

            sup.stop_app();
            let _ = std::fs::remove_file(&sock_path);

            match status? {
                nix::sys::wait::WaitStatus::Exited(_, 0) => Ok(()),
                nix::sys::wait::WaitStatus::Exited(_, code) => {
                    Err(format!("Sandbox exited with code {}", code).into())
                }
                other => Err(format!("Sandbox ended unexpectedly: {:?}", other).into()),
            }
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Launch { env, sample } => launch(env, sample),
        Commands::Run { script, stop } => {
            let code = supervisor::run_client(script, stop)?;
            std::process::exit(code);
        }
    }
}
