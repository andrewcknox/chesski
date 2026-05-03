import { getLichessToken, setLichessToken } from './lichess';
import { exportAll, getMeta, importAll, setMeta, type ExportData } from './storage';
import { getHistoryProgress, saveHistoryProgress, type ProgressByCard } from './historySrs';

const META_ACCOUNTS = 'local_accounts_v1';
const META_CURRENT_ACCOUNT = 'current_account_v1';

export interface AccountSnapshot {
  exportedAt: string;
  data: ExportData;
  lichessToken: string | null;
  historyProgress: ProgressByCard;
}

export interface LocalAccount {
  id: string;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  lastSignedInAt: string | null;
  lastSyncedAt: string | null;
  snapshot: AccountSnapshot | null;
}

export type AccountSummary = Pick<LocalAccount, 'id' | 'username' | 'createdAt' | 'lastSignedInAt' | 'lastSyncedAt'> & {
  hasSnapshot: boolean;
};

function accountSummary(account: LocalAccount): AccountSummary {
  return {
    id: account.id,
    username: account.username,
    createdAt: account.createdAt,
    lastSignedInAt: account.lastSignedInAt,
    lastSyncedAt: account.lastSyncedAt,
    hasSnapshot: !!account.snapshot,
  };
}

async function getAccounts(): Promise<LocalAccount[]> {
  return (await getMeta<LocalAccount[]>(META_ACCOUNTS)) ?? [];
}

async function setAccounts(accounts: LocalAccount[]): Promise<void> {
  await setMeta(META_ACCOUNTS, accounts);
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function randomHex(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password: string, salt: string): Promise<string> {
  return sha256Hex(`${salt}:${password}`);
}

export async function listAccountSummaries(): Promise<AccountSummary[]> {
  const accounts = await getAccounts();
  return accounts.map(accountSummary).sort((a, b) => a.username.localeCompare(b.username));
}

export async function getCurrentAccount(): Promise<AccountSummary | null> {
  const currentId = await getMeta<string>(META_CURRENT_ACCOUNT);
  if (!currentId) return null;
  const account = (await getAccounts()).find(a => a.id === currentId);
  return account ? accountSummary(account) : null;
}

export async function createAccount(username: string, password: string): Promise<AccountSummary> {
  const clean = normalizeUsername(username);
  if (!clean) throw new Error('Choose a username.');
  if (password.length < 6) throw new Error('Use at least 6 characters for the password.');
  const accounts = await getAccounts();
  if (accounts.some(a => normalizeUsername(a.username) === clean)) throw new Error('That username already exists on this computer.');
  const now = new Date().toISOString();
  const salt = randomHex(16);
  const account: LocalAccount = {
    id: `acct_${Date.now().toString(36)}_${randomHex(4)}`,
    username: username.trim(),
    passwordSalt: salt,
    passwordHash: await hashPassword(password, salt),
    createdAt: now,
    updatedAt: now,
    lastSignedInAt: now,
    lastSyncedAt: null,
    snapshot: null,
  };
  await setAccounts([...accounts, account]);
  await setMeta(META_CURRENT_ACCOUNT, account.id);
  return accountSummary(account);
}

export async function signIn(username: string, password: string): Promise<AccountSummary> {
  const clean = normalizeUsername(username);
  const accounts = await getAccounts();
  const idx = accounts.findIndex(a => normalizeUsername(a.username) === clean);
  if (idx === -1) throw new Error('No account with that username is saved on this computer.');
  const account = accounts[idx];
  if ((await hashPassword(password, account.passwordSalt)) !== account.passwordHash) throw new Error('That password did not match.');
  const updated = { ...account, lastSignedInAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  accounts[idx] = updated;
  await setAccounts(accounts);
  await setMeta(META_CURRENT_ACCOUNT, updated.id);
  if (updated.snapshot?.lichessToken) {
    await setLichessToken(updated.snapshot.lichessToken);
  }
  return accountSummary(updated);
}

export async function signOut(): Promise<void> {
  await setMeta(META_CURRENT_ACCOUNT, null);
}

export async function syncCurrentAccount(): Promise<AccountSummary> {
  const currentId = await getMeta<string>(META_CURRENT_ACCOUNT);
  if (!currentId) throw new Error('Sign in before syncing.');
  const accounts = await getAccounts();
  const idx = accounts.findIndex(a => a.id === currentId);
  if (idx === -1) throw new Error('The signed-in account was not found.');
  const now = new Date().toISOString();
  const snapshot: AccountSnapshot = {
    exportedAt: now,
    data: await exportAll(),
    lichessToken: await getLichessToken(),
    historyProgress: await getHistoryProgress(),
  };
  const updated = { ...accounts[idx], snapshot, lastSyncedAt: now, updatedAt: now };
  accounts[idx] = updated;
  await setAccounts(accounts);
  return accountSummary(updated);
}

export async function restoreCurrentAccount(): Promise<AccountSummary> {
  const currentId = await getMeta<string>(META_CURRENT_ACCOUNT);
  if (!currentId) throw new Error('Sign in before restoring.');
  const account = (await getAccounts()).find(a => a.id === currentId);
  if (!account?.snapshot) throw new Error('This account does not have a saved sync snapshot yet.');
  await importAll(account.snapshot.data, 'replace');
  await setLichessToken(account.snapshot.lichessToken);
  await saveHistoryProgress(account.snapshot.historyProgress);
  return accountSummary(account);
}
