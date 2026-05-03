export interface MoveListItem {
  san: string;
  // mover: which color played this move ('w' or 'b')
  mover: 'w' | 'b';
}

export interface MoveListProps {
  moves: MoveListItem[];
  // Index into `moves` of the currently displayed position. -1 means starting position.
  currentIndex: number;
  onJump: (index: number) => void;
}

export function MoveList({ moves, currentIndex, onJump }: MoveListProps) {
  if (moves.length === 0) return <div className="muted small">No moves yet — make a move on the board.</div>;
  // Group into pairs by fullmove number based on the mover.
  // Walk through and emit "1. e4 e5  2. Nf3 ..." with click targets.
  const items: React.ReactNode[] = [];
  let moveNum = 1;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (m.mover === 'w') {
      items.push(<span className="move-num" key={`n${i}`}>{moveNum}.</span>);
    } else if (i === 0) {
      // Black-to-move at the start (uncommon; from a custom position) — show "1..." style.
      items.push(<span className="move-num" key={`n${i}`}>{moveNum}…</span>);
    }
    items.push(
      <span
        key={i}
        className={'move' + (i === currentIndex ? ' current' : '')}
        onClick={() => onJump(i)}
      >
        {m.san}
      </span>
    );
    if (m.mover === 'b') moveNum++;
  }
  return (
    <div className="move-list">
      <span
        className={'move' + (currentIndex === -1 ? ' current' : '')}
        onClick={() => onJump(-1)}
        title="Starting position"
      >
        start
      </span>
      {items}
    </div>
  );
}
