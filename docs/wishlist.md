# Chesski Wishlist

This file is a lightweight parking lot for ideas Andy wants to preserve for later planning.

## Repertoire And Database Ideas

- Replace the remaining top-right "+ New repertoire" advanced control with a clearer custom-import/tools path. The normal opening flow now lives in New Opening, but FEN/PGN/clone creation still needs a less awkward home.
- Fix the My Lines tab regression. It used to work cleanly, but it is now badly broken and needs a focused repair pass.
- In My Lines, when the user selects a line and it appears on the large board, show actions for "Review this prep" and "Learn a new line from here."
- Add a right-side Masters database view inside Chesski, similar to the Lichess opening explorer.
- Replace checkbox-style default-opening continuation picking with an immersive board-first flow: show the position, let the user play the move they know and want in their prep, validate it against pre-approved engine-checked/master-supported continuations, then return to earlier unresolved branches until the repertoire is filled in.
- After a user selects a new opening to learn, bring them to the board and simulate the opening with them so Chesski can infer what prep they already know. This likely needs a stored database of opponent responses because live engine/API calls are too slow for a smooth setup flow.
- Support downloaded top-player PGN bundles stored with the app instead of depending entirely on live API search.
- Later, shrink the player-book bundle by moving exact source-game continuations out of `player-books.json` into compact per-player game files or source-game pointers. For now, keep the larger bundle because exact game stealing matters more than saving roughly 30 MB.
- Start with a small player pack: Magnus Carlsen, Hikaru Nakamura, Fabiano Caruana, Garry Kasparov, Paul Morphy, and Bobby Fischer.
- Add a stacked "play like these players" recommendation mode. For a position, check the user's priority players in order and prefer a move that player used successfully from the exact position. If the first player has no matching win or game, check the next player, then fall back to Masters data and engine evaluation.
- Let users have more than one approved response in the same position, with study modes such as main line, sideline, or any prepared move.
- Add fully separate siloed repertoire projects that can intentionally contradict other repertoires without being treated as conflicts. Example: one serious tournament repertoire and one experimental "play like Morphy" repertoire can both exist with different answers to the same position.
- Import a user's game history, infer the lines they actually play, and flag repertoire moves as bad, improvable, acceptable, or optimal.
- After the initial Chess.com/PGN repertoire import flow works, let users add their Lichess username as another source for importing their own games.
- Add a "Punisher" mode: find common opening blunders that occur after positions already in the user's repertoire, prioritize moves with very high win rates for the user's side, and confirm the traps with Stockfish before teaching them.
- Improve drag-reordering for "learn from these players/sources": while the user is holding an item, the other items should move live so the final order is visible before release.

## Accounts And Sync

- Fix account isolation. Separate accounts currently do not feel truly separate; importing personal games can report conflicts with stored database/repertoire data even when the account has not added lines yet.
- True cross-device sync still needs a hosted backend. The current local vault is file-backed and durable on this computer, but it does not follow the user across devices.

## Training And Review

- Randomize the order in which new SRS cards are introduced.
- Treat moves between the starting position and a core opening as scaffold only, not SRS cards.
- Add a Chessable-style timer bar for learning/training. Default to 30 seconds. When the timer reaches zero, count the move wrong for SRS, show the correct-move arrow, and prompt the user to play it. Include a pause-timer option.
- When the user gets the last move wrong in a learning line, show clear wrong-answer feedback and show the correct move.
- Make "Learn + Review" always include review work. If no cards are due, pull some not-due cards as fallback review.
- During learning or reviewing sessions, hide the other top-level navigation headings because clicking away mid-session usually does not make sense.
- Add a flow-state mode where the top tabs are blocked or hidden and Chesski cycles through Learn and Review sessions until the user explicitly ends the flow.
- Add a transition that sweeps across the board when Chesski switches from learning to reviewing.
- Investigate why a generated learning line sometimes has only 3 new moves instead of the expected 5.
- Improve the repeated-wrong-move switch prompt: let the user click "Use X instead" or "Stick with Y" immediately while the engine comparison loads, rather than blocking the session on "Checking with the engine."
- After the user chooses to switch to their alternative move, regenerate the remaining line from that move so the learned sequence still totals the intended number of new moves.
- Investigate why obvious early-theory positions sometimes return "Engine has no eval" or stay stuck checking the engine for a long time.
- Make preparing a new line faster and more reliable. Sometimes it says it is preparing a new line and never completes until the app is restarted.
- If engine eval shows "Current: ..." and "Line end: ..." for too long, show a clearer loading/error state and avoid leaving the user unsure whether anything is happening.

## Analysis And Exploration

- Add an analysis-board concept at any position with white/black exploration, Stockfish, book data, and related tools. This is low priority because it is complicated.
- Before building the full analysis board, add a simpler button that opens Lichess analysis with the current FEN loaded.

## Personalization And Preferences

- Add chessboard customizability.
- Add chess piece customizability.
- Add chess piece animation speed customizability, separately configurable for teaching and quiz/training.
- Toggle highlighting legal moves.
- Toggle piece sound.
- Add light mode and dark mode.

## Opening Discovery And Recommendations

- Add a style quiz as an alternative to starting from scratch: tactical vs positional, conservative vs aggressive, sharp vs flat, then recommend an Algorithm pack based on the answers.
- Browse other opening training apps for nice features Chesski lacks and could copy.

## Motivation And Delight

- Add chess quote cards like agadmator video quotes. Each quote card should have two clozes: who said it and a critical word in the quote.
- Generally beautify the website so it is pleasant to look at and feels good to use.
- Add little icons for the players' heads in player/source lists.
- Redesign the desktop/app icon from a stronger source asset. The current skier/knight mark does not read clearly enough as either a knight or a ski pole at desktop size.
- Add more ADD-friendly animations that make the app feel rewarding and alive without slowing down fast training.
- Add an Anki/GitHub-style heat map for daily activity, including reviews and new cards.
- Add opening mastery titles based on how much the user has learned inside an opening. Example: after enough Evans Gambit moves, show titles like Evans Gambit appreciator, specialist, expert, etc. Thresholds need design.

## UI Clarity

- Do a systematic holistic UI pass after the current feature fixes: identify useful low-effort changes, run them by Andy, then execute the approved ones.

## Board Interaction

- Support right-click square highlighting.
- Support right-click-and-drag arrows, but constrain user-drawn arrows to legal chess geometry: ranks/files, perfect diagonals, and knight L-shapes only. For example, do not allow an arrow from d4 to f7.
- Fix the semi-transparent blue knight suggestion arrow so overlapping parts do not get darker; the whole shape should be one uniform color.

## Distribution And Setup

- Make Chesski easy for people to download from GitHub and set up. Explore an installer EXE that installs dependencies/app files and creates a desktop icon. Estimate difficulty and choose the simplest durable packaging path.

## Completed Recently

- Added a Home tab that answers "what opening am I studying?" and lets the user pick the current opening/repertoire before training.
- Added a New Opening tab with compact board-preview catalog cards for creating repertoires or adding openings to existing repertoires.
- Replaced the confusing Repertoires "Add opening" dropdown panel with a visual-catalog entry point.
- Added the first app-side local account vault: username/password, saved Lichess token, repertoire snapshots, and chess-history card progress.
- Made Vite dev mode use the same file-backed local vault API as the durable desktop launcher.
- Preserved current guest progress when creating an account after using the app without one.
- Added Account tab diagnostics showing storage mode, vault file path, browser origin, saved accounts, and rescue snapshots.
- Renamed the main tabs and labels to match Andy's language: Trivia, My Lines, Analyze My Game, main repertoire, side repertoires.
- Moved always-visible token management into the Account tab.
- Fixed tiny My Lines board previews by hiding oversized coordinates and clipping preview frames cleanly.
- Made trivia cards appear in a random session order instead of always walking the same sequence.
- Expanded the chess-history trivia deck from 10 to 40 cloze cards.
- Kept trivia available on the line-loading screen by falling back to least-recently-reviewed cards when nothing is due.
