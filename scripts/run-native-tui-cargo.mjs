import process from "node:process";
import { runCargo } from "./native-tui-cargo.mjs";

await runCargo(process.argv.slice(2));
