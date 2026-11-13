# Vajra target use case

## Purpose

Vajra is for a person who wants to let a coding agent work on a project on their Linux machine while limiting what the agent can access and change. It puts an enforceable boundary around the agent's shell: the agent can work with the project and explicitly allowed paths, while unrelated files on the machine stay outside its view and permissions.

The initial product is for **one person, one machine, and one project per Vajra shell**. The person using the machine chooses the project, reviews its access rules, starts the agent, and remains responsible for deciding whether to grant more access. Company-wide administration, shared sessions, and remote access are outside this target use case.

## Target user and situation

The target user is a developer running Claude Code, OpenCode, Codex, pi, or another supported coding agent locally. They want the agent to be useful on a real project without giving it unrestricted access to their home directory, credentials, or other projects.

Typical situations include:

- Let an agent read a project, but only edit selected source or documentation paths.
- Keep credentials, personal files, and neighboring repositories outside the agent's filesystem view.
- Give an agent temporary access to a specific external path when the task needs it.
- Run an agent for an extended task and retain the same boundary while it works.
- When the agent hits a denied path, understand why and deliberately adjust the project policy.

## User promise

Before work starts, the user can understand what the shell can read, create, change, and delete. While it runs, the operating system enforces those limits for the agent and its child processes. When a needed permission changes, the user can review the proposed rights and restart the agent under the updated policy.

Vajra must refuse to start if it cannot enforce a requested boundary. It must not silently provide a weaker sandbox.

## What Vajra has today

The current CLI implements the core local confinement workflow:

- `vajra` opens a shell confined to the current project; `vajra doctor` checks whether the machine can enforce confinement.
- A project's `.vajra.json` defines project read, write, create, and delete rights. Without a policy file, the project is read-only by default.
- A bubblewrap filesystem view, Landlock file restrictions, and seccomp syscall restrictions provide separate layers of enforcement. Startup fails when required enforcement cannot be set up.
- Home-directory paths are denied by default. Users can explicitly allow selected external paths. Agent-specific state directories are granted so supported agents can launch and retain their own sessions.
- A local control page shows effective path rights and their source. It can save policy changes and restart the shell and supported agent so the new policy takes effect.
- A notice explains the active boundary to the agent and asks it to report denied access instead of trying to work around it. This notice is guidance; the kernel enforcement is the security boundary.
- Supported agent launchers currently cover Claude Code, OpenCode, Codex, and pi.

The security layers overlap deliberately: the view hides denied paths, Landlock enforces file access, and seccomp blocks selected escape-related system calls.

## What the target use case still needs

The following are product needs for the single-system use case. They are not all implemented today.

### Must have

- **Network control:** let a user limit or disable network access for a session. Today, a confined agent can send out anything it can read.
- **Clear policy preview:** present the effective rights before launch, including defaults, inherited rules, and explicit external-path grants.
- **Safe policy changes:** validate each requested change against what the operating system can actually enforce, explain refusals, and apply accepted changes only through a restart.
- **Session lifecycle controls:** make it clear which agent and shell are running, provide a reliable stop action, and ensure the policy remains in effect for the full process tree.
- **Long-running session recovery:** preserve the agent's supported continuation behavior across a policy restart, report when that continuation is unavailable, and avoid implying that unsaved work was preserved.
- **Usable denial feedback:** explain which path or action was denied and how the user can review a narrowly scoped policy change.
- **Verifiable enforcement:** retain tests against the real kernel for each security boundary, and refuse to run when a required layer is unavailable.

### Should have

- **Per-agent access selection:** grant only the state and configuration directories needed by the agent the user starts, instead of exposing every supported agent's login state to every agent in the same shell.
- **Environment-variable controls:** inspect and filter inherited environment variables so shell-exported credentials are not passed through without the user's awareness.
- **Useful project workflows:** make common build and test workflows possible under policy, with a clear way to handle generated files and dependency caches that are currently read-only.
- **Local activity history:** show policy decisions and session lifecycle events, and connect the existing change-history building block to an explicit recovery workflow where practical. Do not present this as a complete command audit unless commands are actually captured.
- **Operational visibility:** show the active policy version, session status, agent identity, and reason for a restart or stop.
- **Documented support boundaries:** clearly state supported Linux setups, agent versions, and which checks were run against actual confinement rather than a planned view.

## Out of scope for this phase

- Company accounts, central policy administration, identity-provider provisioning, team or role management, and organization-wide reporting.
- Remote access, pairing, mobile clients, shared agent sessions, and hosted execution.
- A multi-user service or a shared daemon spanning projects. The boundary is per local shell/process tree and project.
- Guaranteeing that an agent's changes are correct, reversible, or safe to merge. The developer remains responsible for reviewing code and using source control.
- Preventing data disclosure over the network until network restrictions are implemented and verified.

## How success should be judged

For this target user, Vajra is successful when they can start a supported agent in a project, see and understand its effective access, and rely on the kernel to deny access beyond that boundary. They can grant a specific needed right through the policy workflow, restart the session, and confirm the agent resumed under the new boundary. If the machine cannot enforce the policy, Vajra stops with a useful explanation.

The user should not need to understand Landlock, seccomp, or bubblewrap to configure ordinary project rights. Security claims should remain limited to tested behavior; network isolation, environment-secret filtering, and full activity auditing must not be implied until implemented.

## Product principle

Vajra should make the agent's effective access narrow, visible, and enforced on the user's own machine. Convenience features may help the user change that access, but must never turn an unenforceable policy into a permissive fallback.
