import { getDefaultOCREndpoint } from './ocrSettings';
import { readStorageValue, storageKeys, writeStorageValue } from './appMeta';

export interface CnfCredentials {
  username: string;
  password: string;
}

export interface CnfSquadSummary {
  id: number;
  name: string;
  type: string;
  section: string;
  group: string;
  tutor: string;
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

const cnfPost = async (action: string, payload: Record<string, string>): Promise<Record<string, unknown>> => {
  const endpoint = getEndpoint();
  const resp = await fetch(`${endpoint}/api/cnf-roster`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || !data.ok) {
    throw new Error(String(data.error || `请求失败 (${resp.status})`));
  }
  return data;
};

export const cnfLoginAndListSquads = async (creds: CnfCredentials): Promise<CnfSquadSummary[]> => {
  const data = await cnfPost('listSquads', {
    username: creds.username.trim(),
    password: creds.password
  });
  return (data.squads as CnfSquadSummary[]) || [];
};

export const cnfFetchRoster = async (
  creds: CnfCredentials,
  squadId: string,
  squadType?: string
): Promise<CnfRosterResult> => {
  const data = await cnfPost('fetchRoster', {
    username: creds.username.trim(),
    password: creds.password,
    squadId: String(squadId).trim(),
    squadType: squadType || 'offline'
  });
  return {
    squad: data.squad as CnfRosterResult['squad'],
    students: data.students as CnfStudent[],
    total: data.total as number
  };
};
