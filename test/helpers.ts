import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function fixture<T = any>(name: string): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8")) as T;
}
