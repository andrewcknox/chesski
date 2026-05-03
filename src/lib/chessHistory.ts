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
  {
    prompt: 'The first great American chess celebrity, {{C1}}, toured Europe in 1858 and dominated many leading masters.',
    answer: 'Paul Morphy',
  },
  {
    prompt: 'The brilliant 1851 "Immortal Game" was won by {{C1}} against Lionel Kieseritzky.',
    answer: 'Adolf Anderssen',
  },
  {
    prompt: '{{C1}} was the first World Champion to regain the title in a return match, defeating Max Euwe in 1937.',
    answer: 'Alexander Alekhine',
  },
  {
    prompt: 'In 1935, Dutch master {{C1}} defeated Alexander Alekhine to become World Champion.',
    answer: 'Max Euwe',
  },
  {
    prompt: 'The 1957 World Championship match was won by {{C1}}, who defeated Mikhail Botvinnik.',
    answer: 'Vasily Smyslov',
  },
  {
    prompt: 'In 1960, attacking genius {{C1}} defeated Mikhail Botvinnik to become World Champion.',
    answer: 'Mikhail Tal',
  },
  {
    prompt: '{{C1}} became World Champion in 1963 by defeating Mikhail Botvinnik.',
    answer: 'Tigran Petrosian',
  },
  {
    prompt: 'Boris Spassky became World Champion in 1969 by defeating {{C1}}.',
    answer: 'Tigran Petrosian',
  },
  {
    prompt: 'The 1975 World Championship title passed to {{C1}} after Bobby Fischer declined to defend under FIDE rules.',
    answer: 'Anatoly Karpov',
  },
  {
    prompt: 'The first Karpov-Kasparov World Championship match, begun in 1984, was stopped without a winner by {{C1}}.',
    answer: 'FIDE',
  },
  {
    prompt: 'The 1993 split in the world title began when Garry Kasparov and {{C1}} played outside FIDE.',
    answer: 'Nigel Short',
  },
  {
    prompt: 'The 2000 classical World Championship in London was won by {{C1}}, who defeated Garry Kasparov.',
    answer: 'Vladimir Kramnik',
  },
  {
    prompt: 'In 2007, {{C1}} won the Mexico City tournament to become undisputed World Champion.',
    answer: 'Viswanathan Anand',
  },
  {
    prompt: '{{C1}} became World Champion in 2023 after defeating Ian Nepomniachtchi in a tiebreak.',
    answer: 'Ding Liren',
  },
  {
    prompt: 'The youngest player to become World Chess Champion was {{C1}} in 1985.',
    answer: 'Garry Kasparov',
  },
  {
    prompt: 'The first official Women\'s World Chess Champion was {{C1}}, who won the title in 1927.',
    answer: 'Vera Menchik',
  },
  {
    prompt: 'The Polgar sister who became the strongest female player in history and a top-ten player overall was {{C1}}.',
    answer: 'Judit Polgar',
  },
  {
    prompt: '{{C1}} was known as "The Magician from Riga" for his sacrificial attacking style.',
    answer: 'Mikhail Tal',
  },
  {
    prompt: 'The hypermodern book "My System" was written by {{C1}}.',
    answer: 'Aron Nimzowitsch',
  },
  {
    prompt: 'The 1911 San Sebastian tournament, an elite event won by a young {{C1}}, helped announce him as a future world champion.',
    answer: 'Jose Raul Capablanca',
  },
  {
    prompt: 'The great 1924 New York tournament was won by former World Champion {{C1}} ahead of Capablanca and Alekhine.',
    answer: 'Emanuel Lasker',
  },
  {
    prompt: 'The famous "Game of the Century" in 1956 was won by 13-year-old {{C1}} against Donald Byrne.',
    answer: 'Bobby Fischer',
  },
  {
    prompt: 'After the 1962 Candidates Tournament won by Tigran Petrosian, {{C1}} accused Soviet players of prearranged draws.',
    answer: 'Bobby Fischer',
  },
  {
    prompt: 'The Soviet chess school\'s first World Champion was {{C1}}.',
    answer: 'Mikhail Botvinnik',
  },
  {
    prompt: 'The World Championship challenger in the 2016 New York match against Magnus Carlsen was {{C1}}.',
    answer: 'Sergey Karjakin',
  },
  {
    prompt: 'The World Championship challenger in the 2018 London match against Magnus Carlsen was {{C1}}.',
    answer: 'Fabiano Caruana',
  },
  {
    prompt: 'Magnus Carlsen defended his world title in Dubai in 2021 against {{C1}}.',
    answer: 'Ian Nepomniachtchi',
  },
  {
    prompt: 'The legendary Cuban World Champion famous for endgame clarity and few losses was {{C1}}.',
    answer: 'Jose Raul Capablanca',
  },
  {
    prompt: 'The first player to cross 2800 on the FIDE rating list was {{C1}}.',
    answer: 'Garry Kasparov',
  },
  {
    prompt: 'The 2014 World Championship rematch between Magnus Carlsen and {{C1}} was held in Sochi.',
    answer: 'Viswanathan Anand',
  },
  {
    prompt: 'The first official World Champion, {{C1}}, was famous for making positional play central to modern chess.',
    answer: 'Wilhelm Steinitz',
  },
  {
    prompt: '{{C1}} held the World Championship title longer than any other player, from 1894 to 1921.',
    answer: 'Emanuel Lasker',
  },
  {
    prompt: 'The Cuban champion {{C1}} was nicknamed the "Chess Machine" for his smooth technique.',
    answer: 'Jose Raul Capablanca',
  },
  {
    prompt: '{{C1}} was the first Russian-born World Champion.',
    answer: 'Alexander Alekhine',
  },
  {
    prompt: 'The 1948 World Championship tournament was played after the death of {{C1}}.',
    answer: 'Alexander Alekhine',
  },
  {
    prompt: '{{C1}} became the first Soviet World Champion in 1948.',
    answer: 'Mikhail Botvinnik',
  },
  {
    prompt: 'The 1961 return match saw Mikhail Botvinnik regain the title from {{C1}}.',
    answer: 'Mikhail Tal',
  },
  {
    prompt: 'The 1958 return match saw Mikhail Botvinnik regain the title from {{C1}}.',
    answer: 'Vasily Smyslov',
  },
  {
    prompt: 'The 2006 reunification match was decided in rapid tiebreaks when Kramnik defeated {{C1}}.',
    answer: 'Veselin Topalov',
  },
  {
    prompt: 'The 2016 Carlsen-Karjakin match was held in {{C1}}.',
    answer: 'New York',
  },
  {
    prompt: 'The 2018 Carlsen-Caruana match was held in {{C1}}.',
    answer: 'London',
  },
  {
    prompt: 'All classical games in the 2018 World Championship match between Carlsen and {{C1}} were drawn.',
    answer: 'Fabiano Caruana',
  },
  {
    prompt: '{{C1}} won the 2016 World Championship tiebreak with the famous final move 50.Qh6+.',
    answer: 'Magnus Carlsen',
  },
  {
    prompt: 'The 1972 Fischer-Spassky match was played in {{C1}}.',
    answer: 'Reykjavik',
  },
  {
    prompt: 'Bobby Fischer won the 1970 Interzonal tournament in {{C1}}.',
    answer: 'Palma de Mallorca',
  },
  {
    prompt: 'In the 1971 Candidates, Fischer defeated Mark Taimanov by the score {{C1}}.',
    answer: '6-0',
  },
  {
    prompt: 'In the 1971 Candidates, Fischer defeated Bent Larsen by the score {{C1}}.',
    answer: '6-0',
  },
  {
    prompt: 'The Soviet grandmaster {{C1}} was Fischer\'s final Candidates opponent before Spassky.',
    answer: 'Tigran Petrosian',
  },
  {
    prompt: '{{C1}} was Bobby Fischer\'s opponent in the 1972 World Championship.',
    answer: 'Boris Spassky',
  },
  {
    prompt: 'The 1995 PCA World Championship match between Kasparov and Anand was played on the 107th floor of the {{C1}}.',
    answer: 'World Trade Center',
  },
  {
    prompt: 'The 2000 match in which Kramnik defeated Kasparov was played in {{C1}}.',
    answer: 'London',
  },
  {
    prompt: '{{C1}} famously used the Berlin Defense as Black in his 2000 World Championship match against Kasparov.',
    answer: 'Vladimir Kramnik',
  },
  {
    prompt: 'The 1984 Karpov-Kasparov match was abandoned after {{C1}} games.',
    answer: '48',
  },
  {
    prompt: 'Kasparov became World Champion in 1985 by defeating {{C1}} in Moscow.',
    answer: 'Anatoly Karpov',
  },
  {
    prompt: '{{C1}} and Anatoly Karpov played five World Championship matches between 1984 and 1990.',
    answer: 'Garry Kasparov',
  },
  {
    prompt: 'The only official World Champion from the Netherlands was {{C1}}.',
    answer: 'Max Euwe',
  },
  {
    prompt: 'The only official World Champion from Cuba was {{C1}}.',
    answer: 'Jose Raul Capablanca',
  },
  {
    prompt: 'The first official World Champion from India was {{C1}}.',
    answer: 'Viswanathan Anand',
  },
  {
    prompt: 'The first official World Champion from Norway was {{C1}}.',
    answer: 'Magnus Carlsen',
  },
  {
    prompt: 'The first official World Champion from China was {{C1}}.',
    answer: 'Ding Liren',
  },
  {
    prompt: 'The first official World Champion from the United States was {{C1}}.',
    answer: 'Bobby Fischer',
  },
  {
    prompt: 'The first official World Champion from Germany was {{C1}}.',
    answer: 'Emanuel Lasker',
  },
  {
    prompt: 'The first official World Champion from Russia was {{C1}}.',
    answer: 'Alexander Alekhine',
  },
  {
    prompt: 'The official World Champion who died while holding the title in 1946 was {{C1}}.',
    answer: 'Alexander Alekhine',
  },
  {
    prompt: 'The first World Champion recognized by FIDE after World War II was {{C1}}.',
    answer: 'Mikhail Botvinnik',
  },
  {
    prompt: 'The Candidates system was created to choose a challenger for the {{C1}}.',
    answer: 'World Championship',
  },
  {
    prompt: 'The international chess federation is commonly known by the acronym {{C1}}.',
    answer: 'FIDE',
  },
  {
    prompt: 'FIDE was founded in Paris in {{C1}}.',
    answer: '1924',
  },
  {
    prompt: 'The title "grandmaster" is officially awarded by {{C1}}.',
    answer: 'FIDE',
  },
  {
    prompt: 'The Chess Olympiad is a team event organized under {{C1}}.',
    answer: 'FIDE',
  },
  {
    prompt: 'The first Chess Olympiad was held in {{C1}} in 1927.',
    answer: 'London',
  },
  {
    prompt: 'The first Women\'s Chess Olympiad was held in {{C1}} in 1957.',
    answer: 'Emmen',
  },
  {
    prompt: '{{C1}} introduced the rating system that became the basis of modern FIDE ratings.',
    answer: 'Arpad Elo',
  },
  {
    prompt: 'The rating system named after Arpad {{C1}} is used to estimate chess playing strength.',
    answer: 'Elo',
  },
  {
    prompt: 'The first chess-playing computer program to defeat a reigning world champion in a match was IBM\'s {{C1}}.',
    answer: 'Deep Blue',
  },
  {
    prompt: 'Deep Blue defeated Kasparov in a match in {{C1}}.',
    answer: '1997',
  },
  {
    prompt: 'The strong open-source engine that became dominant in computer chess is {{C1}}.',
    answer: 'Stockfish',
  },
  {
    prompt: 'The neural-network engine released by DeepMind that learned chess through self-play was {{C1}}.',
    answer: 'AlphaZero',
  },
  {
    prompt: 'The chess engine {{C1}} is named after a dried cod, not a chess piece.',
    answer: 'Stockfish',
  },
  {
    prompt: 'The traditional notation symbol for checkmate is {{C1}}.',
    answer: '#',
  },
  {
    prompt: 'The notation symbol "0-0" means {{C1}}.',
    answer: 'kingside castling',
  },
  {
    prompt: 'The notation symbol "0-0-0" means {{C1}}.',
    answer: 'queenside castling',
  },
  {
    prompt: 'In algebraic notation, the letter N represents the {{C1}}.',
    answer: 'knight',
  },
  {
    prompt: 'In algebraic notation, the letter B represents the {{C1}}.',
    answer: 'bishop',
  },
  {
    prompt: 'In algebraic notation, the letter R represents the {{C1}}.',
    answer: 'rook',
  },
  {
    prompt: 'In algebraic notation, the letter Q represents the {{C1}}.',
    answer: 'queen',
  },
  {
    prompt: 'In algebraic notation, the letter K represents the {{C1}}.',
    answer: 'king',
  },
  {
    prompt: 'The special pawn capture made immediately after a two-square pawn advance is called {{C1}}.',
    answer: 'en passant',
  },
  {
    prompt: 'A move that attacks two pieces or targets at once is often called a {{C1}}.',
    answer: 'fork',
  },
  {
    prompt: 'A piece that cannot move because it would expose the king is {{C1}}.',
    answer: 'pinned',
  },
  {
    prompt: 'A tactic in which a valuable piece is attacked and forced to reveal another target is a {{C1}}.',
    answer: 'skewer',
  },
  {
    prompt: 'A discovered attack on the king is called a discovered {{C1}}.',
    answer: 'check',
  },
  {
    prompt: 'A double attack where two pieces give check at the same time is called {{C1}}.',
    answer: 'double check',
  },
  {
    prompt: 'The tactical idea of forcing a defender away from its job is called {{C1}}.',
    answer: 'deflection',
  },
  {
    prompt: 'The tactical idea of luring a piece onto a bad square is called {{C1}}.',
    answer: 'decoy',
  },
  {
    prompt: 'A move that blocks an enemy line piece is called {{C1}}.',
    answer: 'interference',
  },
  {
    prompt: 'A move that sacrifices material to open a line or diagonal is often called a {{C1}} sacrifice.',
    answer: 'clearance',
  },
  {
    prompt: 'A chess position where the side to move has no legal move and is not in check is {{C1}}.',
    answer: 'stalemate',
  },
  {
    prompt: 'A position that repeats three times can be claimed as a draw by {{C1}}.',
    answer: 'threefold repetition',
  },
  {
    prompt: 'The fifty-move rule concerns fifty moves by each side without a pawn move or {{C1}}.',
    answer: 'capture',
  },
  {
    prompt: 'A draw agreed by players without checkmate or stalemate is commonly called an {{C1}} draw.',
    answer: 'agreed',
  },
  {
    prompt: 'A sequence of forcing moves leading to mate is often called a {{C1}} net.',
    answer: 'mating',
  },
  {
    prompt: 'A rook placed behind a passed pawn follows a famous rule associated with {{C1}}.',
    answer: 'Tarrasch',
  },
  {
    prompt: 'The idea that rooks belong behind passed pawns is commonly called the {{C1}} rule.',
    answer: 'Tarrasch',
  },
  {
    prompt: 'The opposition is a key concept in {{C1}} endgames.',
    answer: 'king and pawn',
  },
  {
    prompt: 'The square rule helps judge whether a king can catch a passed {{C1}}.',
    answer: 'pawn',
  },
  {
    prompt: 'A rook and pawn versus rook defensive method is named after {{C1}}.',
    answer: 'Philidor',
  },
  {
    prompt: 'A rook and pawn versus rook winning setup is often called the {{C1}} position.',
    answer: 'Lucena',
  },
  {
    prompt: 'The bishop and rook pawn wrong-corner draw depends on the promotion square being the wrong color for the {{C1}}.',
    answer: 'bishop',
  },
  {
    prompt: 'Two bishops can force checkmate against a lone {{C1}}.',
    answer: 'king',
  },
  {
    prompt: 'A bishop and knight can force checkmate against a lone {{C1}}.',
    answer: 'king',
  },
  {
    prompt: 'Two knights cannot force mate against a lone king without help from a {{C1}}.',
    answer: 'mistake',
  },
  {
    prompt: 'A pawn that has no opposing pawns to stop it on its file or adjacent files is a {{C1}} pawn.',
    answer: 'passed',
  },
  {
    prompt: 'A pawn that is blocked and has no friendly pawns on adjacent files is an {{C1}} pawn.',
    answer: 'isolated',
  },
  {
    prompt: 'Two pawns of the same color on the same file are called {{C1}} pawns.',
    answer: 'doubled',
  },
  {
    prompt: 'A protected passed pawn is defended by another {{C1}}.',
    answer: 'pawn',
  },
  {
    prompt: 'A square that cannot be attacked by enemy pawns is often called an {{C1}}.',
    answer: 'outpost',
  },
  {
    prompt: 'The opening 1.e4 c5 is the {{C1}} Defense.',
    answer: 'Sicilian',
  },
  {
    prompt: 'The opening 1.e4 e5 2.Nf3 Nc6 3.Bb5 is the {{C1}}.',
    answer: 'Ruy Lopez',
  },
  {
    prompt: 'The opening 1.e4 e5 2.Nf3 Nc6 3.Bc4 is the {{C1}} Game.',
    answer: 'Italian',
  },
  {
    prompt: 'The opening 1.e4 e6 is the {{C1}} Defense.',
    answer: 'French',
  },
  {
    prompt: 'The opening 1.e4 c6 is the {{C1}} Defense.',
    answer: 'Caro-Kann',
  },
  {
    prompt: 'The opening 1.e4 d6 is the {{C1}} Defense.',
    answer: 'Pirc',
  },
  {
    prompt: 'The opening 1.e4 g6 is the {{C1}} Defense.',
    answer: 'Modern',
  },
  {
    prompt: 'The opening 1.e4 Nf6 is the {{C1}} Defense.',
    answer: 'Alekhine',
  },
  {
    prompt: 'The opening 1.d4 d5 2.c4 is the {{C1}} Gambit.',
    answer: 'Queen\'s',
  },
  {
    prompt: 'The opening 1.d4 Nf6 2.c4 e6 3.Nc3 Bb4 is the {{C1}} Defense.',
    answer: 'Nimzo-Indian',
  },
  {
    prompt: 'The opening 1.d4 Nf6 2.c4 e6 3.Nf3 b6 is the {{C1}} Defense.',
    answer: 'Queen\'s Indian',
  },
  {
    prompt: 'The opening 1.d4 Nf6 2.c4 g6 3.Nc3 Bg7 is the {{C1}} Defense.',
    answer: 'King\'s Indian',
  },
  {
    prompt: 'The opening 1.d4 f5 is the {{C1}} Defense.',
    answer: 'Dutch',
  },
  {
    prompt: 'The opening 1.d4 Nf6 2.c4 c5 3.d5 b5 is the {{C1}} Gambit.',
    answer: 'Benko',
  },
  {
    prompt: 'The opening 1.d4 Nf6 2.c4 c5 3.d5 e6 is the {{C1}} Defense.',
    answer: 'Benoni',
  },
  {
    prompt: 'The opening 1.d4 d5 2.c4 c6 is the {{C1}} Defense.',
    answer: 'Slav',
  },
  {
    prompt: 'The opening 1.d4 d5 2.c4 e6 is the Queen\'s Gambit {{C1}}.',
    answer: 'Declined',
  },
  {
    prompt: 'The opening 1.d4 d5 2.c4 dxc4 is the Queen\'s Gambit {{C1}}.',
    answer: 'Accepted',
  },
  {
    prompt: 'The opening 1.c4 is the {{C1}} Opening.',
    answer: 'English',
  },
  {
    prompt: 'The opening 1.Nf3 is often called the {{C1}} Opening.',
    answer: 'Reti',
  },
  {
    prompt: 'The opening 1.f4 is the {{C1}} Opening.',
    answer: 'Bird',
  },
  {
    prompt: 'The opening 1.b3 is the {{C1}} Opening.',
    answer: 'Larsen',
  },
  {
    prompt: 'The opening 1.g3 is often called the {{C1}} Opening.',
    answer: 'Benko',
  },
  {
    prompt: 'The opening 1.e4 e5 2.f4 is the {{C1}} Gambit.',
    answer: 'King\'s',
  },
  {
    prompt: 'The opening 1.e4 e5 2.Nf3 Nc6 3.d4 is the {{C1}} Game.',
    answer: 'Scotch',
  },
  {
    prompt: 'The opening 1.e4 e5 2.Nf3 Nf6 is the {{C1}} Defense.',
    answer: 'Petrov',
  },
  {
    prompt: 'The opening 1.e4 e5 2.Nf3 Nc6 3.Nc3 Nf6 is the {{C1}} Game.',
    answer: 'Four Knights',
  },
  {
    prompt: 'The opening 1.e4 e5 2.Nc3 is the {{C1}} Game.',
    answer: 'Vienna',
  },
  {
    prompt: 'The opening 1.e4 e5 2.f4 exf4 3.Nf3 g5 is the King\'s Gambit {{C1}}.',
    answer: 'Accepted',
  },
  {
    prompt: 'The Sicilian line with ...a6 after 1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 is the {{C1}} Variation.',
    answer: 'Najdorf',
  },
  {
    prompt: 'The Sicilian line with ...Nc6 and ...g6 is often the {{C1}} Variation.',
    answer: 'Dragon',
  },
  {
    prompt: 'The Sicilian Dragon is named for Black\'s pawn structure resembling the {{C1}} constellation.',
    answer: 'Draco',
  },
  {
    prompt: 'The Sicilian line with ...e6 and ...a6 is the {{C1}} Variation.',
    answer: 'Kan',
  },
  {
    prompt: 'The Sicilian line with ...e6 and ...Nc6 is the {{C1}} Variation.',
    answer: 'Taimanov',
  },
  {
    prompt: 'The Sicilian line with 2.Nf3 Nc6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 e5 is the {{C1}} Variation.',
    answer: 'Sveshnikov',
  },
  {
    prompt: 'The Ruy Lopez line with 3...a6 is the {{C1}} Defense.',
    answer: 'Morphy',
  },
  {
    prompt: 'The Ruy Lopez line 3...Nf6 is the {{C1}} Defense.',
    answer: 'Berlin',
  },
  {
    prompt: 'The Ruy Lopez line 3...f5 is the {{C1}} Countergambit.',
    answer: 'Schliemann',
  },
  {
    prompt: 'The French Defense line 1.e4 e6 2.d4 d5 3.e5 is the {{C1}} Variation.',
    answer: 'Advance',
  },
  {
    prompt: 'The French Defense line 1.e4 e6 2.d4 d5 3.Nc3 Bb4 is the {{C1}} Variation.',
    answer: 'Winawer',
  },
  {
    prompt: 'The Caro-Kann line 1.e4 c6 2.d4 d5 3.e5 is the {{C1}} Variation.',
    answer: 'Advance',
  },
  {
    prompt: 'The Caro-Kann line 1.e4 c6 2.d4 d5 3.Nc3 dxe4 4.Nxe4 Bf5 is the {{C1}} Variation.',
    answer: 'Classical',
  },
  {
    prompt: 'The King\'s Indian Defense was a favorite weapon of {{C1}}.',
    answer: 'Garry Kasparov',
  },
  {
    prompt: 'The Queen\'s Gambit is not a true gambit if Black cannot safely keep the {{C1}}.',
    answer: 'pawn',
  },
  {
    prompt: 'The opening named for Aron {{C1}} is the Nimzo-Indian Defense.',
    answer: 'Nimzowitsch',
  },
  {
    prompt: 'The opening named for Richard {{C1}} is the Reti Opening.',
    answer: 'Reti',
  },
  {
    prompt: 'The opening named for Alexander {{C1}} is the Alekhine Defense.',
    answer: 'Alekhine',
  },
  {
    prompt: 'The Italian Game often develops White\'s bishop to {{C1}}.',
    answer: 'c4',
  },
  {
    prompt: 'The Ruy Lopez often develops White\'s bishop to {{C1}}.',
    answer: 'b5',
  },
  {
    prompt: 'In the Sicilian Defense, Black replies to 1.e4 with {{C1}}.',
    answer: 'c5',
  },
  {
    prompt: 'In the French Defense, Black replies to 1.e4 with {{C1}}.',
    answer: 'e6',
  },
  {
    prompt: 'In the Caro-Kann Defense, Black replies to 1.e4 with {{C1}}.',
    answer: 'c6',
  },
  {
    prompt: 'In the Scandinavian Defense, Black replies to 1.e4 with {{C1}}.',
    answer: 'd5',
  },
  {
    prompt: 'In Alekhine\'s Defense, Black replies to 1.e4 with {{C1}}.',
    answer: 'Nf6',
  },
  {
    prompt: 'The famous 1851 Immortal Game was played in {{C1}}.',
    answer: 'London',
  },
  {
    prompt: 'The famous 1852 Evergreen Game was won by {{C1}}.',
    answer: 'Adolf Anderssen',
  },
  {
    prompt: 'The "Opera Game" was won by {{C1}} in Paris in 1858.',
    answer: 'Paul Morphy',
  },
  {
    prompt: 'Paul Morphy\'s Opera Game was played against the Duke of Brunswick and Count {{C1}}.',
    answer: 'Isouard',
  },
  {
    prompt: 'The "Game of the Century" was played between Bobby Fischer and {{C1}}.',
    answer: 'Donald Byrne',
  },
  {
    prompt: 'The "Game of the Century" was played in {{C1}}.',
    answer: '1956',
  },
  {
    prompt: 'Kasparov\'s famous 1999 brilliancy in Wijk aan Zee was against {{C1}}.',
    answer: 'Veselin Topalov',
  },
  {
    prompt: 'Kasparov-Topalov 1999 is especially famous for Kasparov\'s long king {{C1}}.',
    answer: 'hunt',
  },
  {
    prompt: 'The 1912 game famous for a queen sacrifice on h7 was Levitsky versus {{C1}}.',
    answer: 'Frank Marshall',
  },
  {
    prompt: 'The "gold coins" game was won by {{C1}} against Stepan Levitsky.',
    answer: 'Frank Marshall',
  },
  {
    prompt: 'The classic attacking game Rotlewi-Rubinstein 1907 was won by {{C1}}.',
    answer: 'Akiba Rubinstein',
  },
  {
    prompt: 'The "Polish Immortal" was won by {{C1}}.',
    answer: 'Miguel Najdorf',
  },
  {
    prompt: 'The game known as "The Pearl of Zandvoort" was won by {{C1}} against Savielly Tartakower.',
    answer: 'Max Euwe',
  },
  {
    prompt: 'The "Immortal Zugzwang Game" was won by {{C1}} against Friedrich Samisch.',
    answer: 'Aron Nimzowitsch',
  },
  {
    prompt: 'The 1923 "Immortal Zugzwang Game" was played in {{C1}}.',
    answer: 'Copenhagen',
  },
  {
    prompt: 'The famous 1938 AVRO tournament was won jointly by Paul Keres and {{C1}}.',
    answer: 'Reuben Fine',
  },
  {
    prompt: 'The 1953 Candidates Tournament was held in {{C1}}.',
    answer: 'Zurich',
  },
  {
    prompt: 'The celebrated book "Zurich International Chess Tournament 1953" was written by {{C1}}.',
    answer: 'David Bronstein',
  },
  {
    prompt: 'The 1959 Candidates Tournament was won by {{C1}}.',
    answer: 'Mikhail Tal',
  },
  {
    prompt: 'The 1962 Candidates Tournament was held in {{C1}}.',
    answer: 'Curacao',
  },
  {
    prompt: 'The 1974 Candidates final was Karpov versus {{C1}}.',
    answer: 'Viktor Korchnoi',
  },
  {
    prompt: 'The 1978 World Championship match between Karpov and Korchnoi was played in {{C1}}.',
    answer: 'Baguio',
  },
  {
    prompt: 'The 1987 World Championship match between Kasparov and Karpov ended with Kasparov keeping the title after a drawn match in {{C1}}.',
    answer: 'Seville',
  },
  {
    prompt: 'The city of {{C1}} hosted the famous 1925 tournament won by Efim Bogoljubow.',
    answer: 'Moscow',
  },
  {
    prompt: 'The 1938 AVRO tournament was held in the country of {{C1}}.',
    answer: 'the Netherlands',
  },
  {
    prompt: 'The tournament in {{C1}} is one of the longest-running elite annual chess events.',
    answer: 'Wijk aan Zee',
  },
  {
    prompt: 'The elite event now known as Tata Steel Chess is played in {{C1}}.',
    answer: 'Wijk aan Zee',
  },
  {
    prompt: 'The annual Norway Chess tournament is associated with the city of {{C1}}.',
    answer: 'Stavanger',
  },
  {
    prompt: 'The Sinquefield Cup is held in {{C1}}.',
    answer: 'Saint Louis',
  },
  {
    prompt: 'The Candidates Tournament chooses the challenger for the World Champion in {{C1}} chess.',
    answer: 'classical',
  },
  {
    prompt: 'The chess title below grandmaster and above FIDE Master is {{C1}}.',
    answer: 'International Master',
  },
  {
    prompt: 'The chess title abbreviated FM is {{C1}}.',
    answer: 'FIDE Master',
  },
  {
    prompt: 'The chess title abbreviated GM is {{C1}}.',
    answer: 'Grandmaster',
  },
  {
    prompt: 'The chess title abbreviated IM is {{C1}}.',
    answer: 'International Master',
  },
  {
    prompt: 'The chess title abbreviated WGM is {{C1}}.',
    answer: 'Woman Grandmaster',
  },
  {
    prompt: 'The first woman awarded the grandmaster title was {{C1}}.',
    answer: 'Nona Gaprindashvili',
  },
  {
    prompt: '{{C1}} was the first Women\'s World Champion from Georgia.',
    answer: 'Nona Gaprindashvili',
  },
  {
    prompt: '{{C1}} succeeded Nona Gaprindashvili as Women\'s World Champion.',
    answer: 'Maia Chiburdanidze',
  },
  {
    prompt: '{{C1}} was Women\'s World Champion from 1978 to 1991.',
    answer: 'Maia Chiburdanidze',
  },
  {
    prompt: 'The Polgar sister who became Women\'s World Champion was {{C1}}.',
    answer: 'Susan Polgar',
  },
  {
    prompt: 'The strongest Polgar sister in open competition was {{C1}}.',
    answer: 'Judit Polgar',
  },
  {
    prompt: 'The Chinese grandmaster {{C1}} was Women\'s World Champion from 1991 to 1996.',
    answer: 'Xie Jun',
  },
  {
    prompt: '{{C1}} became Women\'s World Champion in 2010 and later reached the Candidates Tournament.',
    answer: 'Hou Yifan',
  },
  {
    prompt: 'The first woman to qualify for the Candidates Tournament in the modern open cycle was {{C1}}.',
    answer: 'Judit Polgar',
  },
  {
    prompt: '{{C1}} was the first woman to break into the top ten of the open rating list.',
    answer: 'Judit Polgar',
  },
  {
    prompt: 'The first female player to earn the full grandmaster title through tournament norms and rating was {{C1}}.',
    answer: 'Judit Polgar',
  },
  {
    prompt: 'The World Champion famous for the phrase "When you see a good move, look for a better one" was {{C1}}.',
    answer: 'Emanuel Lasker',
  },
  {
    prompt: 'The player often called the "Patriarch" of Soviet chess was {{C1}}.',
    answer: 'Mikhail Botvinnik',
  },
  {
    prompt: 'The player nicknamed "Iron Tigran" was {{C1}}.',
    answer: 'Tigran Petrosian',
  },
  {
    prompt: 'The player nicknamed "Viktor the Terrible" was {{C1}}.',
    answer: 'Viktor Korchnoi',
  },
  {
    prompt: 'The player nicknamed "The Boa Constrictor" was {{C1}}.',
    answer: 'Anatoly Karpov',
  },
  {
    prompt: 'The player nicknamed "The Beast from Baku" was {{C1}}.',
    answer: 'Garry Kasparov',
  },
  {
    prompt: 'The player nicknamed "The Tiger of Madras" was {{C1}}.',
    answer: 'Viswanathan Anand',
  },
  {
    prompt: 'The player nicknamed "The Mozart of Chess" is often {{C1}}.',
    answer: 'Magnus Carlsen',
  },
  {
    prompt: 'The player nicknamed "The Magician from Riga" was {{C1}}.',
    answer: 'Mikhail Tal',
  },
  {
    prompt: 'The great endgame composer and grandmaster from Georgia was {{C1}}.',
    answer: 'Genrikh Kasparyan',
  },
  {
    prompt: 'The Soviet theoretician associated with prophylaxis and blockade was {{C1}}.',
    answer: 'Aron Nimzowitsch',
  },
  {
    prompt: 'The phrase "hypermodern chess" is closely associated with players like Nimzowitsch, Reti, and {{C1}}.',
    answer: 'Tartakower',
  },
];
