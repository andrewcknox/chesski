export interface HistoryClozeCard {
  prompt: string;
  answer: string;
}

export const CHESS_HISTORY_CLOZE: HistoryClozeCard[] = [
  {
    prompt: 'In 1851, the London tournament was won by {{C1}} and helped establish international tournament chess.',
    answer: 'Adolf Anderssen',
  },
  {
    prompt: 'In 1858, Paul Morphy defeated {{C1}} in Paris and was widely regarded as the strongest player in the world.',
    answer: 'Adolf Anderssen',
  },
  {
    prompt: 'The first official World Chess Championship match in 1886 was won by {{C1}}.',
    answer: 'Wilhelm Steinitz',
  },
  {
    prompt: 'In 1921, Jose Raul Capablanca defeated {{C1}} to become World Champion.',
    answer: 'Emanuel Lasker',
  },
  {
    prompt: 'After Alekhine died as champion, the 1948 championship tournament was won by {{C1}}.',
    answer: 'Mikhail Botvinnik',
  },
  {
    prompt: 'The 1972 "Match of the Century" in Reykjavik was won by {{C1}}.',
    answer: 'Bobby Fischer',
  },
  {
    prompt: 'In 1985, Garry Kasparov defeated {{C1}} to become the youngest undisputed World Champion.',
    answer: 'Anatoly Karpov',
  },
  {
    prompt: 'In 1997, IBM\'s {{C1}} defeated Garry Kasparov in a six-game match.',
    answer: 'Deep Blue',
  },
  {
    prompt: 'In 2013, Magnus Carlsen became World Champion by defeating {{C1}}.',
    answer: 'Viswanathan Anand',
  },
  {
    prompt: 'The classical title was reunified in 2006 when Vladimir Kramnik defeated {{C1}}.',
    answer: 'Veselin Topalov',
  },
];
