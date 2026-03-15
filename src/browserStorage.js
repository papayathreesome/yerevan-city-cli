import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ClassicLevel } from 'classic-level';

const YEREVAN_CITY_ORIGIN = 'https://www.yerevan-city.am';
const STORAGE_KEYS = ['token', 'language', 'cityId', 'addressId'];

function getBrowserRoots() {
  if (process.platform === 'darwin') {
    const home = os.homedir();
    return [
      { browser: 'Google Chrome Canary', root: path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary') },
      { browser: 'Google Chrome', root: path.join(home, 'Library', 'Application Support', 'Google', 'Chrome') },
      { browser: 'Chromium', root: path.join(home, 'Library', 'Application Support', 'Chromium') },
      { browser: 'Brave Browser', root: path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser') },
      { browser: 'Arc', root: path.join(home, 'Library', 'Application Support', 'Arc', 'User Data') },
    ];
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return [
      { browser: 'Google Chrome', root: path.join(localAppData, 'Google', 'Chrome', 'User Data') },
      { browser: 'Chromium', root: path.join(localAppData, 'Chromium', 'User Data') },
      { browser: 'Brave Browser', root: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data') },
    ];
  }

  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return [
    { browser: 'Google Chrome', root: path.join(configHome, 'google-chrome') },
    { browser: 'Google Chrome Beta', root: path.join(configHome, 'google-chrome-beta') },
    { browser: 'Chromium', root: path.join(configHome, 'chromium') },
    { browser: 'Brave Browser', root: path.join(configHome, 'BraveSoftware', 'Brave-Browser') },
  ];
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listProfileDirs(root) {
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === 'Default' || /^Profile \d+$/.test(name) || /^Person \d+$/.test(name));
}

async function collectStorageLocations() {
  const locations = [];

  for (const browser of getBrowserRoots()) {
    const profiles = await listProfileDirs(browser.root);

    for (const profile of profiles) {
      const storageDir = path.join(browser.root, profile, 'Local Storage', 'leveldb');

      if (await pathExists(storageDir)) {
        locations.push({
          browser: browser.browser,
          profile,
          storageDir,
        });
      }
    }
  }

  return locations;
}

function normalizeDecodedStrings(valueBuffer) {
  const buffer = Buffer.from(valueBuffer);
  const variants = new Set([
    buffer.toString('utf8'),
    buffer.toString('latin1'),
    buffer.toString('utf16le'),
  ]);

  for (const value of [...variants]) {
    variants.add(value.replace(/\u0000/g, ''));
  }

  return [...variants];
}

function extractValueForKey(key, valueBuffer) {
  const patterns = {
    token: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    language: /(?<!\d)\d{1,3}(?!\d)/,
    cityId: /(?<!\d)\d{1,10}(?!\d)/,
    addressId: /(?<!\d)\d{1,10}(?!\d)/,
  };

  const matcher = patterns[key];
  if (!matcher) {
    return null;
  }

  for (const variant of normalizeDecodedStrings(valueBuffer)) {
    const match = variant.match(matcher);
    if (match) {
      return match[0];
    }
  }

  return null;
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) {
      return null;
    }

    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function isTargetKey(keyText) {
  return keyText.includes(YEREVAN_CITY_ORIGIN) && STORAGE_KEYS.some((storageKey) => keyText.endsWith(`\u0001${storageKey}`));
}

function getStorageKeyName(keyText) {
  return STORAGE_KEYS.find((storageKey) => keyText.endsWith(`\u0001${storageKey}`)) ?? null;
}

async function withCopiedLevelDb(storageDir, callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yerevan-city-leveldb-'));
  const copiedDir = path.join(tempDir, 'leveldb');

  try {
    await fs.cp(storageDir, copiedDir, { recursive: true });
    await fs.rm(path.join(copiedDir, 'LOCK'), { force: true });
    return await callback(copiedDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function readLocalStorageEntries(storageLocation) {
  return withCopiedLevelDb(storageLocation.storageDir, async (copiedDir) => {
    const db = new ClassicLevel(copiedDir, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });

    const values = new Map();

    try {
      await db.open();

      for await (const [keyBuffer, valueBuffer] of db.iterator()) {
        const keyText = Buffer.from(keyBuffer).toString('latin1');

        if (!isTargetKey(keyText)) {
          continue;
        }

        const storageKey = getStorageKeyName(keyText);
        const parsedValue = storageKey ? extractValueForKey(storageKey, valueBuffer) : null;

        if (storageKey && parsedValue) {
          values.set(storageKey, parsedValue);
        }
      }
    } finally {
      await db.close().catch(() => {});
    }

    return Object.fromEntries(values);
  });
}

function buildSessionCandidate(storageLocation, values) {
  if (!values.token || !values.language || !values.cityId) {
    return null;
  }

  const tokenPayload = decodeJwtPayload(values.token);
  const expiresAt = tokenPayload?.exp ? new Date(tokenPayload.exp * 1000).toISOString() : null;
  const issuedAt = tokenPayload?.iat ? new Date(tokenPayload.iat * 1000).toISOString() : null;

  return {
    apiBaseUrl: 'https://apishopv2.yerevan-city.am',
    token: values.token,
    tokenMeta: {
      issuedAt,
      expiresAt,
      rawPayload: tokenPayload,
    },
    defaults: {
      language: values.language,
      cityId: values.cityId,
      addressId: values.addressId ?? null,
      osType: '3',
    },
    source: {
      browser: storageLocation.browser,
      profile: storageLocation.profile,
      capturedAt: new Date().toISOString(),
    },
  };
}

function compareCandidates(left, right) {
  const leftExp = left.tokenMeta?.rawPayload?.exp ?? 0;
  const rightExp = right.tokenMeta?.rawPayload?.exp ?? 0;

  if (leftExp !== rightExp) {
    return rightExp - leftExp;
  }

  return right.source.capturedAt.localeCompare(left.source.capturedAt);
}

export async function findFreshestSession() {
  const storageLocations = await collectStorageLocations();
  if (!storageLocations.length) {
    throw new Error('No Chromium browser storage directories were found on this machine.');
  }

  const candidates = [];

  for (const storageLocation of storageLocations) {
    try {
      const values = await readLocalStorageEntries(storageLocation);
      const candidate = buildSessionCandidate(storageLocation, values);

      if (candidate) {
        candidates.push(candidate);
      }
    } catch {
      // Ignore unreadable profiles and keep scanning the others.
    }
  }

  if (!candidates.length) {
    throw new Error('Could not find a usable Yerevan City session in local Chromium storage. Log into the site in your browser and try again.');
  }

  candidates.sort(compareCandidates);
  const freshest = candidates[0];
  delete freshest.tokenMeta.rawPayload;
  return freshest;
}
