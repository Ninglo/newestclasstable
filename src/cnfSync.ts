import { getDefaultOCREndpoint } from './ocrSettings';
import { readStorageValue, storageKeys, writeStorageValue } from './appMeta';

export interface CnfCredentials {
  username: string;
  password: string;
}

export interface CnfStudent {
  id: number;
  no: string;
  enName: string;
  chName: string;
  displayName: string;
}

export interface CnfRosterResult {
  squad: {
    id: number;
    name: string;
    fullName: string;
    type: string;
  };
  students: CnfStudent[];
  total: number;
}

const isLocalDev = (): boolean =>
  location.hostname === '127.0.0.1' || location.hostname === 'localhost';

const getEndpoint = (): string => {
  if (isLocalDev()) {
    return getDefaultOCREndpoint().replace(/\/$/, '') || '';
  }
  // On deployed site, use same-origin Pages Functions
  return '';
};

export const loadCnfCredentials = (): CnfCredentials => {
  const raw = readStorageValue(storageKeys.cnfSyncProfile);
  if (!raw) return { username: '', password: '' };
  try {
    const parsed = JSON.parse(raw) as Partial<CnfCredentials>;
    return {
      username: String(parsed.username || '').trim(),
      password: String(parsed.password || '')
    };
  } catch {
    return { username: '', password: '' };
  }
};

export const saveCnfCredentials = (creds: CnfCredentials): void => {
  writeStorageValue(
    storageKeys.cnfSyncProfile,
    JSON.stringify({ username: creds.username.trim(), password: creds.password })
  );
};

export const cnfLogin = async (creds: CnfCredentials): Promise<void> => {
  const endpoint = getEndpoint();
  if (!endpoint) throw new Error('OCR 代理未配置，教务同步不可用');

  const resp = await fetch(`${endpoint}/api/cnf-roster`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'login',
      username: creds.username.trim(),
      password: creds.password
    })
  });

  const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!resp.ok || !data.ok) {
    throw new Error(data.error || `登录失败 (${resp.status})`);
  }
};

export const cnfFetchRoster = async (
  creds: CnfCredentials,
  squadId: string,
  squadType?: string
): Promise<CnfRosterResult> => {
  const endpoint = getEndpoint();
  if (!endpoint) throw new Error('OCR 代理未配置，教务同步不可用');

  const resp = await fetch(`${endpoint}/api/cnf-roster`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'fetchRoster',
      username: creds.username.trim(),
      password: creds.password,
      squadId: String(squadId).trim(),
      squadType: squadType || 'offline'
    })
  });

  const data = (await resp.json().catch(() => ({}))) as CnfRosterResult & { ok?: boolean; error?: string };
  if (!resp.ok || !data.ok) {
    throw new Error(data.error || `名单获取失败 (${resp.status})`);
  }

  return { squad: data.squad, students: data.students, total: data.total };
};

export const extractSquadIdFromUrl = (input: string): string => {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.searchParams.get('id')?.trim() || '';
  } catch {
    return '';
  }
};
