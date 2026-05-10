import { Chessboard } from 'react-chessboard';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Square } from 'chess.js';
import { applyMove, denormalizeFen, chessFromFen } from '../lib/chess';
import { BOARD_THEME_OPTIONS, type PieceSetKey, useBoardPreferences } from '../lib/boardPreferences';
import type { NormFen } from '../types';

export interface BoardProps {
  fen: NormFen;
  orientation: 'white' | 'black';
  // Return true if the move was accepted (board will re-render from new fen prop on next paint).
  onMove: (m: { from: string; to: string; promotion?: string }) => boolean;
  // Optional highlight squares with explicit colors.
  highlights?: Record<string, string>;
  // Optional arrows: tuples of [from, to, color?]
  arrows?: { startSquare: string; endSquare: string; color?: string }[];
  allowMoves?: boolean;
  allowedDragColor?: 'w' | 'b';
  size?: number;
  animatePositionChange?: boolean;
  resizable?: boolean;
  minSize?: number;
  maxSize?: number;
  onSizeChange?: (size: number) => void;
  showNotation?: boolean;
  // Optional flash class on outer wrapper (e.g. 'board-flash-good' / 'board-flash-bad')
  flashClass?: string;
}

export function Board({
  fen,
  orientation,
  onMove,
  highlights,
  arrows,
  allowMoves = true,
  allowedDragColor,
  size = 560,
  animatePositionChange = true,
  resizable = false,
  minSize = 360,
  maxSize = 900,
  onSizeChange,
  showNotation = true,
  flashClass,
}: BoardProps) {
  const { preferences } = useBoardPreferences();
  const positionFen = denormalizeFen(fen);
  const [selected, setSelected] = useState<string | null>(null);
  const [markedSquares, setMarkedSquares] = useState<Set<string>>(() => new Set());
  const [userArrows, setUserArrows] = useState<BoardProps['arrows']>([]);
  const dragRef = useRef<{ startX: number; startY: number; startSize: number; frame: number | null } | null>(null);
  const clickHandledRef = useRef<number>(0);
  const rightDragStartRef = useRef<string | null>(null);
  const previousFenRef = useRef<NormFen>(fen);
  const boardTheme = BOARD_THEME_OPTIONS.find(theme => theme.key === preferences.boardTheme) ?? BOARD_THEME_OPTIONS[0];
  const customPieces = useMemo(() => buildCustomPieces(preferences.pieceSet), [preferences.pieceSet]);

  useEffect(() => {
    return () => {
      if (dragRef.current?.frame) cancelAnimationFrame(dragRef.current.frame);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setSelected(null), 0);
    return () => window.clearTimeout(timer);
  }, [fen, allowMoves]);

  useEffect(() => {
    const previousFen = previousFenRef.current;
    previousFenRef.current = fen;
    if (previousFen === fen || areOneMoveApart(previousFen, fen)) return;
    setMarkedSquares(new Set());
    setUserArrows([]);
  }, [fen]);

  // Build squareStyles: highlights + selection + legal-target dots.
  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (highlights) {
      for (const [sq, color] of Object.entries(highlights)) {
        styles[sq] = { background: color };
      }
    }
    for (const sq of markedSquares) {
      styles[sq] = {
        ...(styles[sq] || {}),
        background: 'rgba(188, 68, 62, 0.38)',
      };
    }
    if (selected) {
      styles[selected] = { ...(styles[selected] || {}), boxShadow: 'inset 0 0 0 3px rgba(74,144,226,0.8)' };
      try {
        const chess = chessFromFen(fen);
        // chess.js v1 expects { square, verbose: true }
        const legal = chess.moves({ square: selected as Square, verbose: true });
        for (const m of legal) {
          styles[m.to] = {
            ...(styles[m.to] || {}),
            background: `radial-gradient(circle, rgba(74,144,226,0.5) 22%, transparent 24%)`,
          };
        }
      } catch {
        // ignore
      }
    }
    return styles;
  }, [highlights, markedSquares, selected, fen]);

  function attemptMove(from: string, to: string, promotion: string = 'q'): boolean {
    const ok = onMove({ from, to, promotion });
    if (ok) {
      setSelected(null);
      if (preferences.soundEnabled) playMoveSound();
    }
    return ok;
  }

  function isAllowedPiece(piece: { pieceType: string } | null): boolean {
    if (!piece) return false;
    if (!allowedDragColor) return true;
    return piece.pieceType.startsWith(allowedDragColor);
  }

  function handleClickMove(square: string, piece: { pieceType: string } | null) {
    if (!allowMoves) return;
    const now = performance.now();
    if (now - clickHandledRef.current < 20) return;
    clickHandledRef.current = now;

    if (selected && square !== selected) {
      const ok = attemptMove(selected, square);
      if (ok) return;
      // If illegal: if clicked square has own piece, switch selection; else clear.
      if (isAllowedPiece(piece)) setSelected(square);
      else setSelected(null);
      return;
    }
    if (selected === square) {
      setSelected(null);
      return;
    }
    if (isAllowedPiece(piece)) setSelected(square);
  }

  function startResize(e: React.PointerEvent<HTMLButtonElement>) {
    if (!onSizeChange) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, startSize: size, frame: null };
  }

  function moveResize(e: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || !onSizeChange) return;
    const delta = Math.max(e.clientX - drag.startX, e.clientY - drag.startY);
    const next = Math.max(minSize, Math.min(maxSize, Math.round(drag.startSize + delta)));
    if (drag.frame) cancelAnimationFrame(drag.frame);
    drag.frame = requestAnimationFrame(() => onSizeChange(next));
  }

  function stopResize(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }

  function toggleMarkedSquare(square: string) {
    setMarkedSquares(prev => {
      const next = new Set(prev);
      if (next.has(square)) next.delete(square);
      else next.add(square);
      return next;
    });
  }

  function toggleUserArrow(startSquare: string, endSquare: string) {
    if (!isValidUserArrow(startSquare, endSquare)) return;
    setUserArrows(prev => {
      const existing = prev?.some(arrow => arrow.startSquare === startSquare && arrow.endSquare === endSquare);
      if (existing) return prev?.filter(arrow => !(arrow.startSquare === startSquare && arrow.endSquare === endSquare)) ?? [];
      return [...(prev ?? []), { startSquare, endSquare, color: 'rgba(245, 178, 45, 0.88)' }];
    });
  }

  function handleRightPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 2) return;
    const square = squareFromPoint(e.clientX, e.clientY, e.currentTarget, orientation);
    if (!square) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    rightDragStartRef.current = square;
  }

  function handleRightPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 2) return;
    const startSquare = rightDragStartRef.current;
    rightDragStartRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!startSquare) return;
    const endSquare = squareFromPoint(e.clientX, e.clientY, e.currentTarget, orientation);
    if (!endSquare) return;
    e.preventDefault();
    if (startSquare === endSquare) toggleMarkedSquare(startSquare);
    else toggleUserArrow(startSquare, endSquare);
  }

  function handleBoardContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    if (squareFromPoint(e.clientX, e.clientY, e.currentTarget, orientation)) e.preventDefault();
  }

  return (
    <div
      className={'board-wrap' + (flashClass ? ' ' + flashClass : '')}
      style={{ width: `min(${size}px, 100%)` }}
      onPointerDownCapture={handleRightPointerDown}
      onPointerUpCapture={handleRightPointerUp}
      onPointerCancel={() => { rightDragStartRef.current = null; }}
      onContextMenuCapture={handleBoardContextMenu}
    >
      <Chessboard
        options={{
          position: positionFen,
          boardOrientation: orientation,
          allowDragging: allowMoves,
          allowAutoScroll: false,
          allowDragOffBoard: false,
          allowDrawingArrows: false,
          dragActivationDistance: 0,
          showAnimations: animatePositionChange && preferences.animationsEnabled,
          showNotation,
          animationDurationInMs: animatePositionChange && preferences.animationsEnabled ? preferences.animationSpeedMs : 0,
          squareStyles,
          lightSquareStyle: { backgroundColor: boardTheme.light },
          darkSquareStyle: { backgroundColor: boardTheme.dark },
          arrows: [...(arrows || []), ...(userArrows || [])].map(a => ({ startSquare: a.startSquare, endSquare: a.endSquare, color: a.color ?? 'rgba(255,255,255,0.6)' })),
          boardStyle: { width: '100%' },
          draggingPieceStyle: { cursor: 'grabbing' },
          ...(customPieces ? { pieces: customPieces } : {}),
          canDragPiece: ({ piece }) => {
            if (!allowMoves) return false;
            if (!allowedDragColor) return true;
            return piece.pieceType.startsWith(allowedDragColor);
          },
          onPieceDrop: ({ sourceSquare, targetSquare }) => {
            if (!allowMoves || !targetSquare) return false;
            return attemptMove(sourceSquare, targetSquare);
          },
          onPieceClick: ({ square, piece }) => {
            if (!square) return;
            handleClickMove(square, piece);
          },
          onSquareClick: ({ square, piece }) => {
            handleClickMove(square, piece);
          },
        }}
      />
      {resizable && (
        <button
          className="board-resize-handle"
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={stopResize}
          onPointerCancel={stopResize}
          aria-label="Resize board"
          title="Resize board"
        />
      )}
    </div>
  );
}

type PieceRenderObject = Record<string, (props?: { square?: string; svgStyle?: React.CSSProperties }) => React.JSX.Element>;

const PIECE_KEYS = ['wP', 'wN', 'wB', 'wR', 'wQ', 'wK', 'bP', 'bN', 'bB', 'bR', 'bQ', 'bK'] as const;

const PIECE_GLYPHS: Record<Exclude<PieceSetKey, 'staunton'>, Record<string, string>> = {
  fantasy: { wP: '♙', wN: '♘', wB: '♗', wR: '♖', wQ: '♕', wK: '♔', bP: '♟', bN: '♞', bB: '♝', bR: '♜', bQ: '♛', bK: '♚' },
  spatial: { wP: '♙', wN: '♘', wB: '♗', wR: '♖', wQ: '♕', wK: '♔', bP: '♟', bN: '♞', bB: '♝', bR: '♜', bQ: '♛', bK: '♚' },
  chessnut: { wP: '♙', wN: '♘', wB: '♗', wR: '♖', wQ: '♕', wK: '♔', bP: '♟', bN: '♞', bB: '♝', bR: '♜', bQ: '♛', bK: '♚' },
};

function buildCustomPieces(pieceSet: PieceSetKey): PieceRenderObject | undefined {
  if (pieceSet === 'staunton') return undefined;
  const source = PIECE_GLYPHS[pieceSet];
  return Object.fromEntries(PIECE_KEYS.map(piece => [
    piece,
    () => (
      <div className={`board-piece board-piece-${pieceSet} board-piece-${piece[0]}`}>
        {source[piece]}
      </div>
    ),
  ])) as PieceRenderObject;
}

function squareFromPoint(clientX: number, clientY: number, boardElement: HTMLElement, orientation: 'white' | 'black'): string | null {
  const rect = boardElement.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
  const cell = rect.width / 8;
  const rawFile = Math.min(7, Math.max(0, Math.floor(x / cell)));
  const rawRank = Math.min(7, Math.max(0, Math.floor(y / cell)));
  const fileIndex = orientation === 'white' ? rawFile : 7 - rawFile;
  const rankIndex = orientation === 'white' ? 7 - rawRank : rawRank;
  return `${String.fromCharCode(97 + fileIndex)}${rankIndex + 1}`;
}

function isValidUserArrow(startSquare: string, endSquare: string): boolean {
  const start = squareCoords(startSquare);
  const end = squareCoords(endSquare);
  if (!start || !end) return false;
  const fileDelta = Math.abs(start.file - end.file);
  const rankDelta = Math.abs(start.rank - end.rank);
  return fileDelta === 0
    || rankDelta === 0
    || fileDelta === rankDelta
    || (fileDelta === 1 && rankDelta === 2)
    || (fileDelta === 2 && rankDelta === 1);
}

function squareCoords(square: string): { file: number; rank: number } | null {
  if (!/^[a-h][1-8]$/.test(square)) return null;
  return { file: square.charCodeAt(0) - 97, rank: Number(square[1]) - 1 };
}

function areOneMoveApart(a: NormFen, b: NormFen): boolean {
  return canReachInOneMove(a, b) || canReachInOneMove(b, a);
}

function canReachInOneMove(fromFen: NormFen, toFen: NormFen): boolean {
  try {
    const chess = chessFromFen(fromFen);
    for (const move of chess.moves({ verbose: true })) {
      const applied = applyMove(fromFen, { from: move.from, to: move.to, promotion: move.promotion });
      if (applied?.fen === toFen) return true;
    }
  } catch {
    return false;
  }
  return false;
}

let moveAudioContext: AudioContext | null = null;

function playMoveSound() {
  const AudioContextCtor = window.AudioContext;
  if (!AudioContextCtor) return;
  const ctx = moveAudioContext ?? new AudioContextCtor();
  moveAudioContext = ctx;
  const now = ctx.currentTime;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(180, now);
  oscillator.frequency.exponentialRampToValueAtTime(105, now + 0.055);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.08, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);

  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.08);
}
