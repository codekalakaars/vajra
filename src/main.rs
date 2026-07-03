use std::sync::Arc;

use vajra::{allow, config, envfile, envpick, sandbox, supervisor};

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
        /// Extra directory the sandbox may read+execute (repeatable).
        /// Toolchain dirs (node, npm, opencode, ...) are detected automatically.
        #[arg(long)]
        allow: Vec<String>,
        /// Extra directory the sandbox may read+write (repeatable).
        /// Agent state dirs (opencode/claude/codex logs, auth, ...) are
        /// detected automatically under $HOME.
        #[arg(long = "allow-rw")]
        allow_rw: Vec<String>,
        /// Re-run the env file picker even if .vajra.toml exists
        #[arg(long)]
        reconfigure: bool,
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

fn launch(
    env: Option<String>,
    sample: Option<String>,
    allow_flags: Vec<String>,
    allow_rw_flags: Vec<String>,
    reconfigure: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let project_dir = std::env::current_dir()?;

    let saved = if reconfigure { None } else { config::load(&project_dir)? };
    let picker_ran = saved.is_none() && (env.is_none() || sample.is_none());

    let (env_choice, sample_choice, mut allow_dirs, mut allow_rw_dirs) = match saved {
        Some(cfg) => {
            println!("vajra: using {} (run with --reconfigure to change)", config::FILE_NAME);
            (env.or(cfg.env), sample.or(cfg.sample), cfg.allow, cfg.allow_rw)
        }
        None => (env, sample, Vec::new(), Vec::new()),
    };
    allow_dirs.extend(allow_flags);
    allow_rw_dirs.extend(allow_rw_flags);

    let selection = envpick::select(&project_dir, env_choice, sample_choice)?;

    if picker_ran {
        let file_name = |p: &std::path::PathBuf| {
            p.file_name().map(|n| n.to_string_lossy().to_string())
        };
        let cfg = config::Config {
            env: selection.original.as_ref().and_then(&file_name),
            sample: selection.sample.as_ref().and_then(&file_name),
            allow: allow_dirs.clone(),
            allow_rw: allow_rw_dirs.clone(),
        };
        config::save(&project_dir, &cfg)?;
        println!("vajra: saved choices to {}", config::FILE_NAME);
    }

    let allowed = allow::collect(&allow_dirs, &allow_rw_dirs);
    if !allowed.rx.is_empty() {
        println!("vajra: allowing read+execute: {}", allowed.rx.join(", "));
    }
    if !allowed.rw.is_empty() {
        println!("vajra: allowing read+write: {}", allowed.rw.join(", "));
    }

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
                allowed_paths: allowed.rx,
                allowed_rw_paths: allowed.rw,
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
        Commands::Launch { env, sample, allow, allow_rw, reconfigure } => {
            launch(env, sample, allow, allow_rw, reconfigure)
        }
        Commands::Run { script, stop } => {
            let code = supervisor::run_client(script, stop)?;
            std::process::exit(code);
        }
    }
}
