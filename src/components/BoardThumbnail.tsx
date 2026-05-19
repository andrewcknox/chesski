import { memo } from 'react';
import { Board } from './Board';
import type { NormFen } from '../types';

export interface BoardThumbnailProps {
  fen: NormFen;
  orientation: 'white' | 'black';
  size: number;
}

export const BoardThumbnail = memo(function BoardThumbnail({ fen, orientation, size }: BoardThumbnailProps) {
  return (
    <div className="board-thumbnail" style={{ width: size, height: size, pointerEvents: 'none' }}>
      <Board
        fen={fen}
        orientation={orientation}
        onMove={() => false}
        allowMoves={false}
        size={size}
        showNotation={false}
        animatePositionChange={false}
      />
    </div>
  );
});
