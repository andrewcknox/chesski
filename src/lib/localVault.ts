export interface PersistentVault {
  version: 1;
  accounts: unknown[];
  currentAccountId: string | null;
  recoverySnapshots: unknown[];
  lichessToken: string | null;
}

function emptyVault(): PersistentVault {
  return {
    version: 1,
    accounts: [],
    currentAccountId: null,
    recoverySnapshots: [],
    lichessToken: null,
  };
}

function normalizeVault(value: unknown): PersistentVault {
  const raw = value && typeof value === 'object' ? value as Partial<PersistentVault> : {};
  return {
    ...emptyVault(),
    ...raw,
    version: 1,
    accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    currentAccountId: typeof raw.currentAccountId === 'string' ? raw.currentAccountId : null,
    recoverySnapshots: Array.isArray(raw.recoverySnapshots) ? raw.recoverySnapshots : [],
    lichessToken: typeof raw.lichessToken === 'string' ? raw.lichessToken : null,
  };
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes('application/json')) {
    throw new Error('Local vault API is not available.');
  }
  return res.json() as Promise<T>;
}

export async function loadPersistentVault(): Promise<PersistentVault | null> {
  try {
    return normalizeVault(await requestJson<unknown>('/api/vault'));
  } catch {
    return null;
  }
}

export async function isPersistentVaultAvailable(): Promise<boolean> {
  try {
    await requestJson<unknown>('/api/vault-status');
    return true;
  } catch {
    return false;
  }
}

export async function savePersistentVault(vault: PersistentVault): Promise<boolean> {
  try {
    await requestJson('/api/vault', {
      method: 'PUT',
      body: JSON.stringify(normalizeVault(vault)),
    });
    return true;
  } catch {
    return false;
  }
}

export async function getPersistentLichessToken(): Promise<string | null | undefined> {
  try {
    const result = await requestJson<{ token: string | null }>('/api/token');
    return typeof result.token === 'string' ? result.token : null;
  } catch {
    return undefined;
  }
}

export async function setPersistentLichessToken(token: string | null): Promise<boolean> {
  try {
    await requestJson('/api/token', {
      method: 'PUT',
      body: JSON.stringify({ token }),
    });
    return true;
  } catch {
    return false;
  }
}
