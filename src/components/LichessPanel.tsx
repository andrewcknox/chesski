import { useEffect, useState } from 'react';
import { fetchExplorerDefault, getLichessToken, setLichessToken, clearLichessCache, validateLichessToken, LichessAuthError, type LichessExplorerResponse, type LichessMove } from '../lib/lichess';
import type { NormFen } from '../types';

export interface LichessPanelProps {
  fen: NormFen;
  onPick: (move: LichessMove) => void;
}

type State =
  | { kind: 'loading' }
  | { kind: 'no-token' }
  | { kind: 'auth-error'; msg: string }
  | { kind: 'error'; msg: string }
  | { kind: 'ok'; data: LichessExplorerResponse };

export function LichessPanel({ fen, onPick }: LichessPanelProps) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [tokenSet, setTokenSet] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setState({ kind: 'loading' });
    (async () => {
      const tok = await getLichessToken();
      setTokenSet(!!tok);
      if (!tok) {
        if (!cancelled) setState({ kind: 'no-token' });
        return;
      }
      try {
        const data = await fetchExplorerDefault(fen, ctrl.signal);
        if (!cancelled) setState({ kind: 'ok', data });
      } catch (e) {
        if (cancelled || (e instanceof Error && e.name === 'AbortError')) return;
        if (e instanceof LichessAuthError) {
          setState({ kind: 'auth-error', msg: e.message });
        } else {
          setState({ kind: 'error', msg: "Couldn't reach Lichess, try again." });
        }
      }
    })();
    return () => { cancelled = true; ctrl.abort(); };
  }, [fen, reloadKey]);

  async function saveToken() {
    const t = tokenInput.trim();
    if (!t) return;
    try {
      await validateLichessToken(t);
      await setLichessToken(t);
      clearLichessCache();
      setTokenInput('');
      setReloadKey(k => k + 1);
    } catch (e) {
      setState({ kind: 'auth-error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  async function clearToken() {
    await setLichessToken(null);
    clearLichessCache();
    setTokenSet(false);
    setReloadKey(k => k + 1);
  }

  if (state.kind === 'no-token' || state.kind === 'auth-error') {
    return (
      <div>
        <div className="small" style={{ color: state.kind === 'auth-error' ? 'var(--bad)' : 'var(--text-dim)', marginBottom: 6 }}>
          {state.kind === 'auth-error'
            ? state.msg
            : 'Lichess Opening Explorer requires a personal API token.'}
        </div>
        <div className="small muted" style={{ marginBottom: 8 }}>
          Create one at <a href="https://lichess.org/account/oauth/token/create" target="_blank" rel="noreferrer">lichess.org/account/oauth/token/create</a> (no scopes required), then paste it here. It's stored locally in your browser.
        </div>
        <div className="row">
          <input
            type={showToken ? 'text' : 'password'}
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            placeholder="lip_…"
            style={{ flex: 1, minWidth: 200 }}
            autoComplete="off"
          />
          <button onClick={() => setShowToken(s => !s)} title="Toggle visibility">{showToken ? 'Hide' : 'Show'}</button>
          <button className="primary" onClick={saveToken} disabled={!tokenInput.trim()}>Save token</button>
          {tokenSet && <button onClick={clearToken}>Clear stored token</button>}
        </div>
      </div>
    );
  }

  if (state.kind === 'loading') return <div className="muted small">Loading from Lichess…</div>;
  if (state.kind === 'error') {
    return (
      <div>
        <div className="small" style={{ color: 'var(--bad)' }}>{state.msg}</div>
        <div className="row" style={{ marginTop: 6 }}>
          <button onClick={() => setReloadKey(k => k + 1)}>Retry</button>
          <button onClick={clearToken}>Clear stored token</button>
        </div>
      </div>
    );
  }
  const top = state.data.moves.slice(0, 8);
  if (top.length === 0) return <div className="muted small">No games found at this position.</div>;
  return (
    <div>
      <table className="lichess-table">
        <thead>
          <tr>
            <th>Move</th>
            <th>Games</th>
            <th>White / Draw / Black</th>
          </tr>
        </thead>
        <tbody>
          {top.map(m => {
            const total = m.white + m.draws + m.black;
            const wPct = total ? Math.round((m.white / total) * 100) : 0;
            const dPct = total ? Math.round((m.draws / total) * 100) : 0;
            const bPct = Math.max(0, 100 - wPct - dPct);
            return (
              <tr key={m.uci} onClick={() => onPick(m)} title="Click to add as a child branch">
                <td className="mono">{m.san}</td>
                <td>{total.toLocaleString()}</td>
                <td>
                  <span className="bar">
                    <span className="w" style={{ width: `${wPct}%` }}>{wPct >= 10 ? `${wPct}%` : ''}</span>
                    <span className="d" style={{ width: `${dPct}%` }}>{dPct >= 10 ? `${dPct}%` : ''}</span>
                    <span className="b" style={{ width: `${bPct}%` }}>{bPct >= 10 ? `${bPct}%` : ''}</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="small muted">Lichess token saved.</span>
        <span className="spacer" />
        <button className="small" onClick={clearToken}>Clear token</button>
      </div>
    </div>
  );
}
