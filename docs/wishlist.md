# Chesski Wishlist

This file is a lightweight parking lot for ideas Andy wants to preserve for later planning.

## Repertoire And Database Ideas

- Add a right-side Masters database view inside Chesski, similar to the Lichess opening explorer.
- Support downloaded top-player PGN bundles stored with the app instead of depending entirely on live API search.
- Start with a small player pack: Magnus Carlsen, Hikaru Nakamura, Fabiano Caruana, Garry Kasparov, Paul Morphy, and Bobby Fischer.
- Add a stacked "play like these players" recommendation mode. For a position, check the user's priority players in order and prefer a move that player used successfully from the exact position. If the first player has no matching win or game, check the next player, then fall back to Masters data and engine evaluation.
- Let users have more than one approved response in the same position, with study modes such as main line, sideline, or any prepared move.
- Add fully separate siloed repertoire projects that can intentionally contradict other repertoires without being treated as conflicts. Example: one serious tournament repertoire and one experimental "play like Morphy" repertoire can both exist with different answers to the same position.
- Import a user's game history, infer the lines they actually play, and flag repertoire moves as bad, improvable, acceptable, or optimal.
- Add a "Punisher" mode: find common opening blunders that occur after positions already in the user's repertoire, prioritize moves with very high win rates for the user's side, and confirm the traps with Stockfish before teaching them.
- Improve drag-reordering for "learn from these players/sources": while the user is holding an item, the other items should move live so the final order is visible before release.

## Accounts And Sync

- Add a username and password flow so one account can own the stored Lichess token and eventually sync study data.
- Treat this as a real account/sync project rather than just hiding the token locally behind a password prompt.
- First app-side pass is implemented as a local account vault: username/password, saved token, repertoire snapshot, and chess-history card progress. True cross-device sync still needs a hosted backend.

## Chess History

- Expand the chess history cloze cards into a broader spaced-repetition deck.
- Keep history cards available while waiting for Lichess line generation, and also as their own study surface.

## Motivation And Delight

- Add more ADD-friendly animations that make the app feel rewarding and alive without slowing down fast training.
- Add an Anki/GitHub-style heat map for daily activity, including reviews and new cards.
- Add opening mastery titles based on how much the user has learned inside an opening. Example: after enough Evans Gambit moves, show titles like Evans Gambit appreciator, specialist, expert, etc. Thresholds need design.
