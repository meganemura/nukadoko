import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("notes", { recursive: true });
writeFileSync("notes/a.txt", "a\n");
writeFileSync("notes/b.txt", "b\n");
writeFileSync("readme.txt", "readme\n");
