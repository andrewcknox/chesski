import type { HistoryClozeCard } from '../lib/chessHistory';

export function ClozePrompt({ card, answerShown, onToggleAnswer }: {
  card: HistoryClozeCard;
  answerShown: boolean;
  onToggleAnswer: () => void;
}) {
  const clozes = card.clozes ?? [{ marker: '{{C1}}', label: 'answer', answer: card.answer ?? '' }];
  const clozeByMarker = new Map(clozes.map(cloze => [cloze.marker, cloze]));
  const parts = card.prompt.split(/({{C\d+}})/g).filter(Boolean);

  return (
    <div className="cloze-prompt">
      {parts.map((part, index) => {
        const cloze = clozeByMarker.get(part);
        if (!cloze) return <span key={`${part}-${index}`}>{part}</span>;
        return (
          <button
            key={`${part}-${index}`}
            className={'cloze-blank history-answer' + (answerShown ? ' revealed' : '')}
            onClick={onToggleAnswer}
            title={`Click to pin ${cloze.label}`}
          >
            {cloze.answer}
          </button>
        );
      })}
    </div>
  );
}

export function historyCardSummary(card: HistoryClozeCard): string {
  if (card.kind === 'quote') {
    return card.clozes?.find(cloze => cloze.label === 'speaker')?.answer ?? card.answer ?? 'Quote';
  }
  return card.answer ?? card.clozes?.[0]?.answer ?? 'Trivia';
}
