import { readFileSync } from "node:fs";
process.stdout.write(readFileSync(new URL("./greeting.txt", import.meta.url), "utf8"));
