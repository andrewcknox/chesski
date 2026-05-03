import { useState } from 'react';
import { getLichessToken, setLichessToken, validateLichessToken } from '../lib/lichess';
import { createAccount, signIn, syncCurrentAccount } from '../lib/accounts';

export interface TokenModalProps {
  onSaved: () => void;
  // If true, this is a re-entry for managing the existing token rather than initial setup.
  manage?: boolean;
  initialValue?: string;
  onCancel?: () => void;
}

export function TokenModal({ onSaved, manage, initialValue = '', onCancel }: TokenModalProps) {
  const [token, setToken] = useState(initialValue);
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [accountMode, setAccountMode] = useState<'sign-in' | 'create'>('create');

  async function save() {
    const t = token.trim();
    if (!t) return;
    setSaving(true);
    setError(null);
    try {
      await validateLichessToken(t);
      await setLichessToken(t);
      await syncCurrentAccount().catch(() => {});
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    await setLichessToken(null);
    await syncCurrentAccount().catch(() => {});
    setToken('');
    onSaved();
  }

  async function signInWithAccount() {
    setSaving(true);
    setError(null);
    try {
      await signIn(username, password);
      const restoredToken = await getLichessToken();
      if (!restoredToken) throw new Error('That account does not have a saved Lichess token yet.');
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function createLocalAccount() {
    const t = token.trim();
    if (!t) {
      setError('Paste your Lichess token first, then create the account.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await validateLichessToken(t);
      await setLichessToken(t);
      await createAccount(username, password);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2 style={{ marginTop: 0 }}>{manage ? 'Manage your Lichess token' : 'Welcome to Chesski'}</h2>
        <p>
          Chesski needs a free Lichess API token to look up opening theory and engine evaluations. Without it, none of the auto-suggestion features work.
        </p>
        <p>
          <strong>How to get one:</strong>
          <br />
          1. Make sure you're signed in at <a href="https://lichess.org/" target="_blank" rel="noreferrer">lichess.org</a>.
          <br />
          2. Visit <a href="https://lichess.org/account/oauth/token/create" target="_blank" rel="noreferrer">lichess.org/account/oauth/token/create</a>.
          <br />
          3. Add a description (e.g. "chesski"). Leave all scopes unchecked. Click Create.
          <br />
          4. Copy the long string starting with <code>lip_…</code> and paste it below.
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <input
            type={show ? 'text' : 'password'}
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="lip_…"
            style={{ flex: 1, minWidth: 240 }}
            autoFocus
            autoComplete="off"
            onKeyDown={e => { if (e.key === 'Enter') void save(); }}
          />
          <button onClick={() => setShow(s => !s)}>{show ? 'Hide' : 'Show'}</button>
          <button className="primary" onClick={save} disabled={saving || !token.trim()}>
            {saving ? 'Testing...' : 'Save'}
          </button>
        </div>
        {error && <div className="small" style={{ color: 'var(--bad)', marginTop: 10 }}>{error}</div>}
        {manage && (
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={clear}>Clear stored token</button>
            {onCancel && <button onClick={onCancel}>Cancel</button>}
          </div>
        )}
        {!manage && (
          <>
            <div className="token-divider"><span>local account</span></div>
            <div className="row token-account-tabs">
              <button
                className={accountMode === 'create' ? 'primary' : ''}
                onClick={() => setAccountMode('create')}
              >
                Create account
              </button>
              <button
                className={accountMode === 'sign-in' ? 'primary' : ''}
                onClick={() => setAccountMode('sign-in')}
              >
                Sign in
              </button>
            </div>
            <div className="row">
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
                onKeyDown={e => {
                  if (e.key === 'Enter') void (accountMode === 'create' ? createLocalAccount() : signInWithAccount());
                }}
              />
              <button
                onClick={accountMode === 'create' ? createLocalAccount : signInWithAccount}
                disabled={saving || !username.trim() || !password || (accountMode === 'create' && !token.trim())}
              >
                {accountMode === 'create' ? 'Create and save token' : 'Sign in'}
              </button>
            </div>
            {accountMode === 'create' && (
              <div className="muted small" style={{ marginTop: 8 }}>
                Creating an account saves the token above into that local account.
              </div>
            )}
          </>
        )}
        <div className="muted small" style={{ marginTop: 12 }}>
          The token is stored only on this computer. In the desktop launcher it is also saved to Chesski's local vault, so signing in can restore it without needing to paste it again.
        </div>
      </div>
    </div>
  );
}
