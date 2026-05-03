# Chesski Wishlist

This file is a lightweight parking lot for ideas Andy wants to preserve for later planning.

## Repertoire And Database Ideas

- Add a Home tab that clearly answers "what opening am I studying?" and lets the user pick the current opening/repertoire before training.
- Later, split "New opening" into its own tab with board previews so adding openings feels visual and deliberate instead of buried in settings.
- Add a chessreps.com-style opening catalog for adding openings to a repertoire: compact cards with the opening name and a small board showing the starting/signature position. Clicking an opening should take the user to a learn-more/add flow. Include openings from the start position as well as additions to existing repertoires.
- Make it obvious how to add to the current repertoire; right now there is not a clear enough entry point.
- Replace the top-right "+ New repertoire" control with a real "New Opening" tab. The old side-repertoire checkbox should become an explicit button/action for creating a side repertoire, then take the user into the same opening-creation flow used after account setup.
- Redesign the current "Add opening" section in Repertoires. The two dropdowns are confusing; use the new visual opening catalog instead.
- In My Lines, when the user selects a line and it appears on the large board, show actions for "Review this prep" and "Learn a new line from here."
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
- If someone starts using the app without creating an account, then creates an account later in that same session, save the current progress into that new account instead of resetting it.

## Chess History

- Expand the chess history cloze cards into a broader spaced-repetition deck.
- Keep history cards available while waiting for Lichess line generation, and also as their own study surface.
- Show fun facts in random order instead of always walking the same sequence.

## Training And Review

- When the user gets the last move wrong in a learning line, show clear wrong-answer feedback and show the correct move.
- Make "Learn + Review" always include review work. If no cards are due, pull some not-due cards as fallback review.
- During learning or reviewing sessions, hide the other top-level navigation headings because clicking away mid-session usually does not make sense.
- Add a transition that sweeps across the board when Chesski switches from learning to reviewing.
- Investigate why a generated learning line sometimes has only 3 new moves instead of the expected 5.
- Improve the repeated-wrong-move switch prompt: let the user click "Use X instead" or "Stick with Y" immediately while the engine comparison loads, rather than blocking the session on "Checking with the engine."
- After the user chooses to switch to their alternative move, regenerate the remaining line from that move so the learned sequence still totals the intended number of new moves.
- Investigate why obvious early-theory positions sometimes return "Engine has no eval" or stay stuck checking the engine for a long time.
- Make preparing a new line faster and more reliable. Sometimes it says it is preparing a new line and never completes until the app is restarted.
- If engine eval shows "Current: ..." and "Line end: ..." for too long, show a clearer loading/error state and avoid leaving the user unsure whether anything is happening.

## Motivation And Delight

- Redesign the desktop/app icon from a stronger source asset. The current skier/knight mark does not read clearly enough as either a knight or a ski pole at desktop size.
- Add more ADD-friendly animations that make the app feel rewarding and alive without slowing down fast training.
- Add an Anki/GitHub-style heat map for daily activity, including reviews and new cards.
- Add opening mastery titles based on how much the user has learned inside an opening. Example: after enough Evans Gambit moves, show titles like Evans Gambit appreciator, specialist, expert, etc. Thresholds need design.

## UI Clarity

- Rename the main tabs and labels to match how Andy thinks about the app: History -> Trivia, Browse -> My Lines, Review -> Analyze My Game, Main repertoires -> main repertoire, and Separate repertoires -> side repertoires.
- Move the always-visible Token button into the Account tab. It does not need to sit in the top bar all the time.
- Fix tiny board previews. In My Lines, pieces appear vertically misaligned/submerged and coordinate labels are too large for the preview squares.
- Do a systematic holistic UI pass after the current feature fixes: identify useful low-effort changes, run them by Andy, then execute the approved ones.

## Board Interaction

- Support right-click square highlighting.
- Support right-click-and-drag arrows, but constrain user-drawn arrows to legal chess geometry: ranks/files, perfect diagonals, and knight L-shapes only. For example, do not allow an arrow from d4 to f7.
- Fix the semi-transparent blue knight suggestion arrow so overlapping parts do not get darker; the whole shape should be one uniform color.

## Distribution And Setup

- Make Chesski easy for people to download from GitHub and set up. Explore an installer EXE that installs dependencies/app files and creates a desktop icon. Estimate difficulty and choose the simplest durable packaging path.
