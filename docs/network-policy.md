# Network policy design

## Goal

Let a confined coding agent reach an approved model API while preventing it from opening direct connections to other network destinations. Proxy environment variables alone do not enforce this: a process can ignore them.

The first provider target is OpenCode Go. OpenCode's current documentation lists `opencode.ai` as the hostname for Go inference and model discovery. Keep the provider hostname in configuration rather than treating the current endpoint paths or model catalog as permanent. See [OpenCode Go](https://docs.opencode.ai/docs/go/).

## Required traffic path

```text
agent process tree
        |
        | isolated network namespace; only route is to the proxy
        v
Vajra egress proxy
        |
        | resolves and connects only configured hostnames and ports
        v
approved service (initially opencode.ai:443)
```

The proxy runs outside the confined process tree. The shell receives `HTTP_PROXY` and `HTTPS_PROXY` pointing to the proxy's namespace-reachable endpoint. A kernel-enforced network rule must deny every other destination, including IPv4, IPv6, direct DNS, UDP/QUIC, and local-network destinations. If proxy startup or network rules fail, Vajra must refuse to start the network-restricted shell.

## Why a proxy and a network namespace are both needed

- A proxy without an isolated route is advisory. The agent can open a direct socket.
- A network namespace without a proxy blocks the model API along with all other network traffic.
- The isolated namespace needs a narrow route to the proxy. For an unprivileged bubblewrap setup this likely needs a rootless networking helper such as `slirp4netns`, followed by firewall rules that allow only the proxy address and port.

The proxy must validate the requested destination itself. It should allow exact hostnames (with an explicit subdomain rule only when needed), restrict CONNECT to port 443, reject IP-literal destinations, and resolve names itself. It must reject loopback, link-local, private, and other special-use addresses after DNS resolution to prevent proxying into local services or DNS-rebinding targets. It must not trust client-supplied DNS results.

HTTPS CONNECT preserves TLS end to end. The proxy can enforce the requested host and port, but cannot inspect encrypted paths or payloads. Do not add TLS interception as part of the first implementation.

## Initial OpenCode Go policy

Start with the single hostname `opencode.ai` on TCP port 443. This covers the documented Go API hostname; model discovery and inference paths can change while remaining on that host. The user may later add explicit hosts for source control or package registries, but those should be separate opt-ins because they expand what project data can leave the machine.

The API credential remains in OpenCode's own account store. Vajra should set proxy variables and enforce the network route without reading or copying the credential.

## Implementation sequence

1. Implement a local CONNECT proxy with a strict hostname and port allowlist, DNS resolution checks, timeouts, and useful denial messages.
2. Build the rootless namespace-to-proxy route and install default-deny egress rules before starting the agent. Drop any setup capability before user commands run.
3. Pass proxy variables to the shell and keep localhost bypasses limited to Vajra's own control page needs. The control page itself remains bound to host loopback and its token protections remain unchanged.
4. Add a versioned network policy format and a clear launch summary. Keep the current shared-network behavior explicit until restricted mode is available; never label proxy-variable-only operation as restricted.
5. Verify the complete path against real kernel networking: allowed model API works; direct TCP, IPv4/IPv6, UDP, direct DNS, localhost/LAN access, and unapproved CONNECT targets fail. Verify startup refuses when the namespace helper or firewall setup is unavailable.

## Current status and known gap

Vajra currently shares the host network. It has no egress proxy or proxy-only network route. `slirp4netns` is not installed in the current development environment. Until the route and its bypass checks are implemented, Vajra must continue to report network access as unrestricted.
