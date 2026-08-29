// One-shot check: prints which env vars the app received and exits.
console.log("demo-app env check");
console.log("  SECRET  =", process.env.SECRET ?? "(missing)");
console.log("  API_KEY =", process.env.API_KEY ?? "(missing)");
console.log("  PORT    =", process.env.PORT ?? "(missing)");

const ok = process.env.SECRET && process.env.API_KEY;
console.log(ok ? "env loaded: OK" : "env loaded: FAILED");
process.exit(ok ? 0 : 1);
