import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".docr-config.json");

const DEFAULTS = {
  vaultPath: null,
  port: 3000,
  ignorePatterns: [".obsidian", ".trash", ".docr-cache"],
};

async function readConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

async function writeConfig(config) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export async function getConfig() {
  return readConfig();
}

export async function setConfig(key, value) {
  const config = await readConfig();
  config[key] = value;
  await writeConfig(config);
}

export async function getVaultPath() {
  const config = await readConfig();
  if (!config.vaultPath) {
    throw new Error(
      "No vault path configured. Run: docr config set vaultPath <path>"
    );
  }
  return config.vaultPath;
}
