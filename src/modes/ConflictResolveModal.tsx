import { BoardThumbnail } from '../components/BoardThumbnail';
import type { ConflictMoveStats } from '../lib/gameImport';
import type { Color, NormFen } from '../types';

export interface ConflictResolveModalProps {
  fen: NormFen;
  color: Color;
  existing: ConflictMoveStats;
  candidate: ConflictMoveStats;
  algorithmPickSan: string | null;
  reason: string;
  onChoose: (decision: 'existing' | 'new' | 'cancel') => void;
}

function formatCp(cp: number | null): string {
  if (cp === null) return '?';
  return `${Math.round(cp)} cp`;
}

function MoveStats({ stats, label, recommended }: { stats: ConflictMoveStats; label: string; recommended: boolean }) {
  return (
    <div className={'conflict-move-card' + (recommended ? ' recommended' : '')}>
      <div className="conflict-move-head">
        <strong className="mono">{stats.san}</strong>
        <span className="muted small">{label}</span>
      </div>
      <div className="small">
        <div>Loss: {formatCp(stats.cpLoss)}</div>
        <div>Master games: {stats.masterGames}</div>
        <div>W/D/L: {stats.wins}/{stats.draws}/{stats.losses}</div>
        <div className={stats.acceptable ? 'good' : 'bad'}>
          {stats.acceptable ? 'Passes filters' : 'Fails filters'}
        </div>
      </div>
    </div>
  );
}

export function ConflictResolveModal({ fen, color, existing, candidate, algorithmPickSan, reason, onChoose }: ConflictResolveModalProps) {
  const orientation: 'white' | 'black' = color === 'w' ? 'white' : 'black';
  return (
    <div className="modal-backdrop" onClick={() => onChoose('cancel')}>
      <div className="modal conflict-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <h3>Pick one for this position</h3>
        <p className="muted small">
          Two of your prep lines disagree at this position. {reason}
          {algorithmPickSan && algorithmPickSan !== existing.san && algorithmPickSan !== candidate.san && (
            <> Algorithm's top choice would be <strong>{algorithmPickSan}</strong>, but neither of your played moves matches it.</>
          )}
        </p>
        <div className="conflict-board-row">
          <BoardThumbnail fen={fen} orientation={orientation} size={220} />
        </div>
        <div className="conflict-moves-row">
          <MoveStats stats={existing} label="Already in your repertoire" recommended={false} />
          <MoveStats stats={candidate} label="From this draft" recommended={false} />
        </div>
        <div className="conflict-actions row">
          <button onClick={() => onChoose('existing')}>Keep {existing.san}</button>
          <button className="primary" onClick={() => onChoose('new')}>Use {candidate.san}</button>
          <button onClick={() => onChoose('cancel')}>Cancel apply</button>
        </div>
      </div>
    </div>
  );
}
