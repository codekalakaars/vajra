use std::sync::Arc;

use vajra::{allow, config, envfile, envpick, sandbox, supervisor};

use clap::{Parser, Subcommand};
use nix::sys::wait::waitpid;
use nix::unistd::{ForkResult, fork};

#[derive(Parser)]
#[command(
    name = "vajra",
    version,
    about = "A lightweight Linux sandbox for AI agents",
    long_about = r#"A lightweight Linux sandbox for AI agents.

Run `vajra launch` in a project directory to start a sandboxed shell where:
  • Env files are masked (showing only a security warning)
  • Filesystem access is restricted to the project directory
  • Host environment variables are stripped
  • The app can be run via `vajra-run` with secrets injected safely

Examples:
  vajra launch                          # Interactive env file selection
  vajra launch --env .env.production    # Skip picker, use specific file
  vajra launch --allow /opt/tools       # Allow extra read+execute directory
  vajra launch --allow-rw /tmp/cache    # Allow extra read+write directory
  vajra launch --reconfigure            # Re-run env file picker
  vajra launch --dry-run                # Show what would happen without launching

Inside the sandbox:
  vajra-run                             # Run default script (dev or start)
  vajra-run build                       # Run specific package.json script
  vajra-run --stop                      # Stop running app
  exit                                  # Leave sandbox"#
)]
struct Cli {
    /// Enable verbose logging
    #[arg(short, long, global = true)]
    verbose: bool,

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
        /// Show what would happen without actually launching the sandbox
        #[arg(long)]
        dry_run: bool,
    },
    /// Run the project app via the supervisor (use inside the sandbox)
    Run {
        /// package.json script to run (default: dev, falling back to start)
        script: Option<String>,
        /// Stop the currently running app
        #[arg(long)]
        stop: bool,
    },
    /// Check if currently running inside a vajra sandbox
    Status,
    /// Validate .vajra.toml configuration without launching
    Validate,
}

struct LaunchConfig {
    env_choice: Option<String>,
    sample_choice: Option<String>,
    allow_dirs: Vec<String>,
    allow_rw_dirs: Vec<String>,
    picker_ran: bool,
}

fn load_and_merge_config(
    project_dir: &std::path::Path,
    env: Option<String>,
    sample: Option<String>,
    allow_flags: &[String],
    allow_rw_flags: &[String],
    reconfigure: bool,
    verbose: bool,
) -> Result<LaunchConfig, Box<dyn std::error::Error>> {
    if verbose {
        eprintln!("vajra: project directory: {}", project_dir.display());
    }

    let saved = if reconfigure {
        None
    } else {
        config::load(project_dir)?
    };
    let picker_ran = saved.is_none() && (env.is_none() || sample.is_none());

    let (env_choice, sample_choice, mut allow_dirs, mut allow_rw_dirs) = match saved {
        Some(cfg) => {
            println!(
                "vajra: using {} (run with --reconfigure to change)",
                config::FILE_NAME
            );
            (
                env.or(cfg.env),
                sample.or(cfg.sample),
                cfg.allow,
                cfg.allow_rw,
            )
        }
        None => (env, sample, Vec::new(), Vec::new()),
    };
    allow_dirs.extend(allow_flags.iter().cloned());
    allow_rw_dirs.extend(allow_rw_flags.iter().cloned());

    Ok(LaunchConfig {
        env_choice,
        sample_choice,
        allow_dirs,
        allow_rw_dirs,
        picker_ran,
    })
}

fn run_env_picker(
    project_dir: &std::path::Path,
    env_choice: Option<String>,
    sample_choice: Option<String>,
    verbose: bool,
) -> Result<envpick::EnvSelection, Box<dyn std::error::Error>> {
    if verbose {
        eprintln!("vajra: scanning for env files...");
    }

    let selection = envpick::select(project_dir, env_choice, sample_choice)?;

    if verbose {
        if let Some(ref orig) = selection.original {
            eprintln!("vajra: original env file: {}", orig.display());
        }
        if let Some(ref samp) = selection.sample {
            eprintln!("vajra: sample env file: {}", samp.display());
        }
        eprintln!("vajra: masking {} env file(s)", selection.masked.len());
    }

    Ok(selection)
}

fn save_config_if_needed(
    project_dir: &std::path::Path,
    selection: &envpick::EnvSelection,
    allow_dirs: &[String],
    allow_rw_dirs: &[String],
    picker_ran: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if !picker_ran {
        return Ok(());
    }

    let file_name = |p: &std::path::PathBuf| p.file_name().map(|n| n.to_string_lossy().to_string());
    let cfg = config::Config {
        env: selection.original.as_ref().and_then(&file_name),
        sample: selection.sample.as_ref().and_then(&file_name),
        allow: allow_dirs.to_vec(),
        allow_rw: allow_rw_dirs.to_vec(),
    };
    config::save(project_dir, &cfg)?;
    println!("vajra: saved choices to {}", config::FILE_NAME);
    Ok(())
}

fn collect_and_print_allowed_paths(
    allow_dirs: &[String],
    allow_rw_dirs: &[String],
) -> allow::AllowedPaths {
    let allowed = allow::collect(allow_dirs, allow_rw_dirs);
    if !allowed.rx.is_empty() {
        println!("vajra: allowing read+execute: {}", allowed.rx.join(", "));
    }
    if !allowed.rw.is_empty() {
        println!("vajra: allowing read+write: {}", allowed.rw.join(", "));
    }
    allowed
}

fn get_and_print_forwarded_env() -> Vec<(String, String)> {
    let forwarded_env = allow::present(allow::AGENT_ENV_PASSTHROUGH, |name| {
        std::env::var(name).ok()
    });
    if !forwarded_env.is_empty() {
        let names: Vec<&str> = forwarded_env.iter().map(|(k, _)| k.as_str()).collect();
        println!("vajra: forwarding agent credentials: {}", names.join(", "));
    }
    forwarded_env
}

fn generate_sample_env_if_needed(
    selection: &envpick::EnvSelection,
) -> Result<(), Box<dyn std::error::Error>> {
    if let (Some(original), Some(sample)) = (&selection.original, &selection.sample)
        && envfile::ensure_sample(original, sample)?
    {
        println!(
            "vajra: generated {} from {} keys",
            sample.display(),
            original.display()
        );
    }
    Ok(())
}

fn setup_supervisor(
    project_dir: &std::path::Path,
    selection: &envpick::EnvSelection,
    verbose: bool,
) -> Result<
    (
        Arc<supervisor::Supervisor>,
        std::os::unix::net::UnixListener,
        std::path::PathBuf,
    ),
    Box<dyn std::error::Error>,
> {
    let sup = Arc::new(supervisor::Supervisor::new(
        project_dir.to_path_buf(),
        selection.original.clone(),
    ));
    let listener = sup.bind()?;
    let sock_path = supervisor::socket_path();

    if verbose {
        eprintln!("vajra: supervisor socket: {}", sock_path.display());
    }

    Ok((sup, listener, sock_path))
}

fn fork_and_run_sandbox(
    project_dir: &std::path::Path,
    selection: &envpick::EnvSelection,
    allowed: &allow::AllowedPaths,
    sock_path: &std::path::Path,
    sup: Arc<supervisor::Supervisor>,
    listener: std::os::unix::net::UnixListener,
    verbose: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if verbose {
        eprintln!("vajra: forking sandbox...");
    }

    match unsafe { fork() }? {
        ForkResult::Child => {
            drop(listener);
            let config = sandbox::SandboxConfig {
                project_dir: project_dir.to_string_lossy().to_string(),
                masked_files: selection.masked.clone(),
                sock_path: Some(sock_path.to_string_lossy().to_string()),
                allowed_paths: allowed.rx.clone(),
                allowed_rw_paths: allowed.rw.clone(),
            };
            let code = match sandbox::launch_sandbox(config) {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("vajra: {}", e);
                    if e.contains("EPERM") || e.contains("Operation not permitted") {
                        eprintln!(
                            "vajra: hint: run 'sudo setcap cap_sys_admin+ep target/debug/vajra'"
                        );
                        eprintln!("vajra: hint: or use 'make build' which does this automatically");
                    }
                    if e.contains("Landlock not supported") {
                        eprintln!("vajra: hint: check kernel version with 'uname -r' (need 5.13+)");
                        eprintln!(
                            "vajra: hint: verify Landlock support: ls /sys/kernel/security/landlock/"
                        );
                    }
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
            let _ = std::fs::remove_file(sock_path);

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

fn print_dry_run_summary(
    project_dir: &std::path::Path,
    selection: &envpick::EnvSelection,
    allowed: &allow::AllowedPaths,
    forwarded_env: &[(String, String)],
    picker_ran: bool,
) {
    println!("\n=== DRY RUN SUMMARY ===\n");
    println!("Project directory: {}", project_dir.display());

    if let Some(ref orig) = selection.original {
        println!("Original env file: {}", orig.display());
    } else {
        println!("Original env file: (none)");
    }

    if let Some(ref samp) = selection.sample {
        println!("Sample env file: {}", samp.display());
    } else {
        println!("Sample env file: (none)");
    }

    println!("\nEnv files to mask ({}):", selection.masked.len());
    for masked in &selection.masked {
        println!("  - {}", masked.display());
    }

    if !allowed.rx.is_empty() {
        println!("\nAllowed read+execute paths:");
        for path in &allowed.rx {
            println!("  - {}", path);
        }
    }

    if !allowed.rw.is_empty() {
        println!("\nAllowed read+write paths:");
        for path in &allowed.rw {
            println!("  - {}", path);
        }
    }

    if !forwarded_env.is_empty() {
        println!("\nForwarded agent credentials:");
        for (key, _) in forwarded_env {
            println!("  - {}", key);
        }
    }

    println!(
        "\nWould {} .vajra.toml: {}",
        if picker_ran { "save" } else { "skip saving" },
        if picker_ran { "yes" } else { "no" }
    );

    println!("\n=== END DRY RUN ===\n");
    println!("No sandbox was launched, no files were modified.");
}

fn launch(
    env: Option<String>,
    sample: Option<String>,
    allow_flags: Vec<String>,
    allow_rw_flags: Vec<String>,
    reconfigure: bool,
    verbose: bool,
    dry_run: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let project_dir = std::env::current_dir()?;

    // Load and merge config
    let config = load_and_merge_config(
        &project_dir,
        env,
        sample,
        &allow_flags,
        &allow_rw_flags,
        reconfigure,
        verbose,
    )?;

    // Run env picker
    let selection = run_env_picker(
        &project_dir,
        config.env_choice,
        config.sample_choice,
        verbose,
    )?;

    // Collect allowed paths and forwarded env
    let allowed = collect_and_print_allowed_paths(&config.allow_dirs, &config.allow_rw_dirs);
    let forwarded_env = get_and_print_forwarded_env();

    // Dry-run: print summary and exit
    if dry_run {
        print_dry_run_summary(
            &project_dir,
            &selection,
            &allowed,
            &forwarded_env,
            config.picker_ran,
        );
        return Ok(());
    }

    // Save config if picker ran
    save_config_if_needed(
        &project_dir,
        &selection,
        &config.allow_dirs,
        &config.allow_rw_dirs,
        config.picker_ran,
    )?;

    // Generate sample env file
    generate_sample_env_if_needed(&selection)?;

    // Setup supervisor
    let (sup, listener, sock_path) = setup_supervisor(&project_dir, &selection, verbose)?;

    // Fork and run sandbox
    fork_and_run_sandbox(
        &project_dir,
        &selection,
        &allowed,
        &sock_path,
        sup,
        listener,
        verbose,
    )
}

fn validate(verbose: bool) -> Result<(), Box<dyn std::error::Error>> {
    let project_dir = std::env::current_dir()?;
    let config_path = project_dir.join(config::FILE_NAME);

    if verbose {
        eprintln!(
            "vajra: checking for {} in {}",
            config::FILE_NAME,
            project_dir.display()
        );
    }

    if !config_path.exists() {
        eprintln!(
            "vajra: no {} found in {}",
            config::FILE_NAME,
            project_dir.display()
        );
        eprintln!("vajra: run 'vajra launch' to create one");
        std::process::exit(1);
    }

    let cfg = match config::load(&project_dir)? {
        Some(cfg) => cfg,
        None => {
            eprintln!(
                "vajra: {} exists but could not be loaded",
                config::FILE_NAME
            );
            std::process::exit(1);
        }
    };

    if verbose {
        eprintln!("vajra: loaded configuration successfully");
    }

    let mut errors = Vec::new();

    if let Some(ref env_file) = cfg.env {
        let env_path = project_dir.join(env_file);
        if !env_path.exists() {
            errors.push(format!("env file '{}' does not exist", env_file));
        } else if verbose {
            eprintln!("vajra: env file '{}' exists", env_file);
        }
    }

    if let Some(ref sample_file) = cfg.sample {
        let sample_path = project_dir.join(sample_file);
        if !sample_path.exists() {
            if verbose {
                eprintln!(
                    "vajra: sample file '{}' does not exist (will be generated)",
                    sample_file
                );
            }
        } else if verbose {
            eprintln!("vajra: sample file '{}' exists", sample_file);
        }
    }

    for path in &cfg.allow {
        if !std::path::Path::new(path).exists() {
            errors.push(format!("allow path '{}' does not exist", path));
        } else if verbose {
            eprintln!("vajra: allow path '{}' exists", path);
        }
    }

    for path in &cfg.allow_rw {
        if !std::path::Path::new(path).exists() {
            errors.push(format!("allow-rw path '{}' does not exist", path));
        } else if verbose {
            eprintln!("vajra: allow-rw path '{}' exists", path);
        }
    }

    if !errors.is_empty() {
        eprintln!("vajra: validation failed:");
        for error in errors {
            eprintln!("  - {}", error);
        }
        std::process::exit(1);
    }

    println!("vajra: {} is valid", config::FILE_NAME);
    Ok(())
}

fn status(verbose: bool) -> Result<(), Box<dyn std::error::Error>> {
    let sock_env = std::env::var("VAJRA_SOCK");

    match sock_env {
        Ok(sock_path) => {
            let path = std::path::Path::new(&sock_path);
            if path.exists() {
                println!("vajra: running inside sandbox");
                if verbose {
                    println!("  socket: {}", sock_path);
                }
                std::process::exit(0);
            } else {
                println!("vajra: VAJRA_SOCK set but socket not found");
                if verbose {
                    println!("  socket path: {}", sock_path);
                }
                std::process::exit(1);
            }
        }
        Err(_) => {
            println!("vajra: not running inside sandbox");
            if verbose {
                println!("  VAJRA_SOCK environment variable not set");
            }
            std::process::exit(1);
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let verbose = cli.verbose;

    match cli.command {
        Commands::Launch {
            env,
            sample,
            allow,
            allow_rw,
            reconfigure,
            dry_run,
        } => launch(env, sample, allow, allow_rw, reconfigure, verbose, dry_run),
        Commands::Run { script, stop } => {
            let code = supervisor::run_client(script, stop)?;
            std::process::exit(code);
        }
        Commands::Status => status(verbose),
        Commands::Validate => validate(verbose),
    }
}
