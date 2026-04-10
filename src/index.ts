import { main } from "./cli.js";
import { runSetup } from "./setup.js";

const cmd = process.argv[2];

if (cmd === "setup") {
  const home = process.env.TORCH_HOME ?? `${process.env.HOME ?? process.env.USERPROFILE ?? ""}/.torch`;
  const appRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  runSetup(home, appRoot).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
} else {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
