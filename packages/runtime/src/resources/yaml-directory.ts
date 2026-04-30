import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export type SafeYamlParser<T> =
  | ((value: unknown) => { success: true; data: T } | { success: false })
  | ((value: unknown) => { success: true; data: T } | { success: false; error: unknown });

export async function loadYamlDirectory<T>(
  directory: string,
  parse: SafeYamlParser<T>,
  getName: (value: T) => string,
  label: string,
): Promise<Map<string, T>> {
  const map = new Map<string, T>();

  try {
    await mkdir(directory, { recursive: true });
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
        continue;
      }

      const raw = await readFile(path.join(directory, entry.name), "utf8");
      const parsed = parse(YAML.parse(raw));
      if (parsed.success) {
        map.set(getName(parsed.data), parsed.data);
      }
    }
  } catch {
    console.warn(`Failed to load ${label} definitions`);
  }

  return map;
}
