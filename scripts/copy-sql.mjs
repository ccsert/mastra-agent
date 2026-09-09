import { copyFile, readdir } from "node:fs/promises";

for (const file of await readdir("src")) {
  if (file.endsWith(".sql")) await copyFile(`src/${file}`, `dist/${file}`);
}
