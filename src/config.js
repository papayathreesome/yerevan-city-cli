import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

function getBaseConfigDir() {
  if (process.env.YEREVAN_CITY_CONFIG_DIR) {
    return process.env.YEREVAN_CITY_CONFIG_DIR;
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }

  if (process.platform === 'win32') {
    return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  }

  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
}

export function getConfigDir() {
  return path.join(getBaseConfigDir(), 'yerevan-city-cli');
}

export function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

export function getDatabasePath() {
  return path.join(getConfigDir(), 'state.db');
}

export async function saveConfig(config) {
  const configDir = getConfigDir();
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function loadConfig() {
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error('No saved Yerevan City session found. Run `yerevan-city login` first.');
    }

    throw error;
  }
}

export function redactToken(token) {
  if (!token || token.length < 16) {
    return token ?? null;
  }

  return `${token.slice(0, 8)}...${token.slice(-8)}`;
}
