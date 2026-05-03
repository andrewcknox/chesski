import { Chessboard } from 'react-chessboard';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Square } from 'chess.js';
import { denormalizeFen, chessFromFen } from '../lib/chess';
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
  animatePositionChange = false,
  resizable = false,
  minSize = 360,
  maxSize = 900,
  onSizeChange,
  showNotation = true,
  flashClass,
}: BoardProps) {
  const positionFen = denormalizeFen(fen);
  const [selected, setSelected] = useState<string | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; startSize: number; frame: number | null } | null>(null);
  const clickHandledRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (dragRef.current?.frame) cancelAnimationFrame(dragRef.current.frame);
    };
  }, []);

  useEffect(() => {
    setSelected(null);
  }, [fen, allowMoves]);

  // Build squareStyles: highlights + selection + legal-target dots.
  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (highlights) {
      for (const [sq, color] of Object.entries(highlights)) {
        styles[sq] = { background: color };
      }
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
  }, [highlights, selected, fen]);

  function attemptMove(from: string, to: string, promotion: string = 'q'): boolean {
    const ok = onMove({ from, to, promotion });
    if (ok) setSelected(null);
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

  return (
    <div className={'board-wrap' + (flashClass ? ' ' + flashClass : '')} style={{ width: size, maxWidth: '100%' }}>
      <Chessboard
        options={{
          position: positionFen,
          boardOrientation: orientation,
          allowDragging: allowMoves,
          allowAutoScroll: false,
          allowDragOffBoard: false,
          dragActivationDistance: 0,
          showAnimations: animatePositionChange,
          showNotation,
          animationDurationInMs: animatePositionChange ? 90 : 0,
          squareStyles,
          arrows: (arrows || []).map(a => ({ startSquare: a.startSquare, endSquare: a.endSquare, color: a.color ?? 'rgba(255,255,255,0.6)' })),
          boardStyle: { width: '100%' },
          draggingPieceStyle: { cursor: 'grabbing' },
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
