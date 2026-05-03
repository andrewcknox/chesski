import { useEffect, useState } from 'react';
import {
  createAccount,
  getCurrentAccount,
  listAccountSummaries,
  listRecoverySummaries,
  restoreCurrentAccount,
  restoreRecoverySnapshot,
  signIn,
  signOut,
  syncCurrentAccount,
  type AccountSummary,
  type RecoverySummary,
} from '../lib/accounts';
import { isPersistentVaultAvailable } from '../lib/localVault';

export interface AccountModeProps {
  onRestored: () => void;
}

export function AccountMode({ onRestored }: AccountModeProps) {
  const [current, setCurrent] = useState<AccountSummary | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [recoveries, setRecoveries] = useState<RecoverySummary[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vaultReady, setVaultReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    const [cur, list, recoveryList, durable] = await Promise.all([
      getCurrentAccount(),
      listAccountSummaries(),
      listRecoverySummaries(),
      isPersistentVaultAvailable(),
    ]);
    setCurrent(cur);
    setAccounts(list);
    setRecoveries(recoveryList);
    setVaultReady(durable);
  }

  useEffect(() => { void reload(); }, []);

  async function run(action: () => Promise<AccountSummary | void>, success: string) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await action();
      await reload();
      setStatus(success);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    await run(async () => {
      await createAccount(username, password);
      setPassword('');
      onRestored();
    }, 'Account created. Current progress saved to the account.');
  }

  async function handleSignIn() {
    await run(async () => {
      await signIn(username, password);
      setPassword('');
      onRestored();
    }, 'Signed in.');
  }

  async function handleSync() {
    await run(syncCurrentAccount, 'Saved the latest token, repertoire, and trivia-card progress to this account.');
  }

  async function handleRestore() {
    if (!window.confirm('Restore this account snapshot? This replaces the current local repertoire and trivia-card progress.')) return;
    await run(async () => {
      await restoreCurrentAccount();
      onRestored();
    }, 'Restored account snapshot.');
  }

  async function handleSignOut() {
    await run(signOut, 'Signed out.');
  }

  async function handleRecoveryRestore(id: string) {
    if (!window.confirm('Restore this rescue snapshot? This replaces the current local repertoire and trivia-card progress.')) return;
    await run(async () => {
      await restoreRecoverySnapshot(id);
      onRestored();
    }, 'Restored rescue snapshot.');
  }

  return (
    <div className="layout account-layout">
      <div className="panel">
        <h3>Account</h3>
        <div className="muted small settings-copy">
          Choose a username and password, then create a local account. If you already have repertoires or trivia progress in this browser, Chesski saves that into the new account. After that, Save to account stores your latest Lichess token, repertoires, and progress in Chesski's local vault on this computer.
        </div>
        {vaultReady === false && (
          <div className="small account-status bad">
            File-backed vault is not connected. Accounts created here may only live in this browser session.
          </div>
        )}
        {vaultReady === true && (
          <div className="small account-status good">
            File-backed vault connected.
          </div>
        )}
        {current ? (
          <>
            <div className="account-card">
              <div className="muted small">Signed in as</div>
              <div className="account-name">{current.username}</div>
              <div className="account-lines">
                <div><span className="muted">Last saved:</span> {current.lastSyncedAt ? new Date(current.lastSyncedAt).toLocaleString() : 'not yet'}</div>
                <div><span className="muted">Snapshot:</span> {current.hasSnapshot ? 'ready' : 'empty'}</div>
              </div>
            </div>
            <div className="row account-actions">
              <button className="primary" onClick={handleSync} disabled={busy}>Save to account</button>
              <button onClick={handleRestore} disabled={busy || !current.hasSnapshot}>Restore from account</button>
              <button onClick={handleSignOut} disabled={busy}>Sign out</button>
            </div>
          </>
        ) : (
          <>
            <div className="row account-form">
              <input
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="Username"
                autoComplete="username"
              />
              <input
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Password"
                type="password"
                autoComplete="current-password"
                onKeyDown={e => { if (e.key === 'Enter') void handleSignIn(); }}
              />
            </div>
            <div className="row account-actions">
              <button className="primary" onClick={handleCreate} disabled={busy}>Create account</button>
              <button onClick={handleSignIn} disabled={busy}>Sign in</button>
            </div>
          </>
        )}
        {status && <div className="small account-status good">{status}</div>}
        {error && <div className="small account-status bad">{error}</div>}
      </div>

      <div className="panel">
        <h3>Saved on this computer</h3>
        <div className="account-list">
          {accounts.length === 0 ? (
            <div className="muted">No local accounts yet.</div>
          ) : accounts.map(account => (
            <div key={account.id} className="account-list-row">
              <span>{account.username}</span>
              <span className="spacer" />
              <span className="muted small">{account.lastSyncedAt ? new Date(account.lastSyncedAt).toLocaleDateString() : 'no save'}</span>
            </div>
          ))}
        </div>
        <div className="muted small account-note">
          This is a file-backed local account vault. It survives app restarts, browser storage resets, and most local updates. Cloud sync will need a small hosted backend before it can follow you across devices.
        </div>
      </div>

      <div className="panel">
        <h3>Rescue snapshots</h3>
        <div className="account-list">
          {recoveries.length === 0 ? (
            <div className="muted">No rescue snapshots yet.</div>
          ) : recoveries.map(snapshot => (
            <div key={snapshot.id} className="account-list-row">
              <span>{snapshot.repertoireCount} reps · {snapshot.moveCount} moves</span>
              <span className="spacer" />
              <span className="muted small">{new Date(snapshot.exportedAt).toLocaleString()}</span>
              <button onClick={() => handleRecoveryRestore(snapshot.id)} disabled={busy}>Restore</button>
            </div>
          ))}
        </div>
        <div className="muted small account-note">
          Chesski saves one of these before account changes that might affect current study data.
        </div>
      </div>
    </div>
  );
}
