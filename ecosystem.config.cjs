// pm2 file for blueprint-back (SPEC-121 D4). One process, settings from the repo's `.env` (hence `cwd`).
// `interpreter: "none"`, not "bun": pm2's Bun mode require()s the entry, and `src/index.ts` uses top-level await (SPEC-121 E8).
module.exports = { apps: [{ name: "blueprint-back", cwd: __dirname, script: "bun", args: "run src/index.ts", interpreter: "none" }] };
