//! Uncapped run client for use inside the sandbox. The main `vajra` binary
//! carries CAP_SYS_ADMIN file capabilities, which the kernel refuses to exec
//! under NO_NEW_PRIVS — so the sandboxed agent uses this binary instead.

use clap::Parser;

#[derive(Parser)]
#[command(name = "vajra-run", about = "Run the project app via the vajra supervisor")]
struct Cli {
    /// package.json script to run (default: dev, falling back to start)
    script: Option<String>,
    /// Stop the currently running app
    #[arg(long)]
    stop: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let code = vajra::supervisor::run_client(cli.script, cli.stop)?;
    std::process::exit(code);
}
