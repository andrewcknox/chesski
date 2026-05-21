# Repertoire Model

## Visual Direction

Chesski is a modern opening laboratory for a lone chess player building weapons from the games of the greats.

The product should feel calm, serious, fast, personal, warm, and quietly premium. The dominant visual language is a dark chess-study cockpit: deep slate and charcoal surfaces, warm ivory text, muted bronze accents, subtle borders, compact spacing, and strong hierarchy around the board and repertoire structure.

Avoid corporate cheeriness, clutter, over-coaching, childish gamification, marketplace/course-card patterns, neon color, bright corporate blue, cartoon green, noisy gradients, heavy shadows, parchment textures, and fake historical decoration.

## Core Definition

A `Repertoire` is a named, side-specific preparation tree.

It is not a single-opening container.

A standard repertoire should normally be rooted at the standard initial chess position and may contain many different opening folders from the Add Opening flow.

Default standard repertoires should be:

- `White Main Repertoire`
- `Black Main Repertoire`

New accounts should initialize exactly those two standard repertoires, both rooted at the normal starting position. Opening folders are created only after an opening is added or trained.

New users see a first-run onboarding wizard before landing in the normal Repertoires hub. The wizard teaches the product hierarchy in user-facing language:

```text
Repertoire
-> Opening
-> Lines
```

It then guides the user through choosing `White Main Repertoire` or `Black Main Repertoire`, choosing the first opening for that side, choosing source preferences, mapping existing prep on the board, and starting a first training session scoped to that selected opening folder.

Onboarding is stored as a per-account first-run flag. Returning users should not be forced through it every time. Settings and Account both expose `Restart onboarding` for testing or for users who skipped the guide.

Do not use default repertoire categories like `Black vs e4` or `Black vs d4`.

Reason: Black prep should not be partitioned by White's first move because many openings transpose across `e4`, `d4`, `c4`, and `Nf3` move orders. Splitting black prep this way creates duplicate prep, contradictory choices, and future transposition problems.

## Type Meaning

Current type:

```ts
export interface Repertoire {
  id: string;
  name: string;
  color: 'w' | 'b';
  rootFen: NormFen;
  openingKey: string | null;
  folderId?: string | null;
  projectKind?: 'standard' | 'siloed';
  createdAt: string;
  updatedAt?: string;
}
```

- `id`: stable identity for this preparation tree.
- `name`: user-facing repertoire name, such as `White Main Repertoire`.
- `color`: defines which side the repertoire trains. Only this side's moves become trainable cards.
- `rootFen`: defines the root of the move tree. Standard repertoires should normally use the standard initial chess position.
- `openingKey`: optional provenance/display metadata for a curated opening used to create the repertoire. It must not make the repertoire behave like a single-opening container.
- `folderId`: optional future organization metadata.
- `projectKind`: `standard` for normal side-based repertoires; `siloed` for intentionally separate repertoires that may contradict another repertoire.
- `createdAt` / `updatedAt`: timestamps.

Conceptual points:

- The actual move tree is stored in `Edge` records scoped by `repertoireId`.
- `openingKey` is optional display/provenance metadata only.
- `openingKey` must not be used as a compatibility boundary.
- A repertoire may contain many different openings even if their opening keys differ.
- `projectKind: 'standard'` means normal side-based prep.
- `projectKind: 'siloed'` means an intentionally separate repertoire that may conflict with another repertoire.

## Product Hierarchy

The product hierarchy is:

```text
Repertoire
-> Opening folder / base opening
-> Line
```

Examples:

```text
White Main Repertoire
-> Italian Game
   -> e4 e5 Nf3 Nc6 Bc4 ...
-> Ruy Lopez
   -> e4 e5 Nf3 Nc6 Bb5 ...
-> Queen's Gambit
   -> d4 d5 c4 ...
```

A repertoire is the broad side-specific prep tree.

An opening folder is a named base opening inside that repertoire.

A line is a concrete trainable continuation inside that opening.

## UI Navigation

Top-level navigation is:

- `Repertoires`
- `Games`
- `Settings`
- `Account`

`Games` contains PGN/game analysis, game import from Chess.com/Lichess/PGN, and build-from-games repertoire draft workflows.

`Settings` contains app, board, training, algorithm, player-book, and Trivia controls.

`Account` contains signed-in/local account info, account switching/listing, save/restore, data backup/restore, vault diagnostics, rescue snapshots, Lichess token management, and account/data deletion controls.

Do not reintroduce top-level tabs for `Home`, `Train`, `My Lines`, `New Opening`, `Review`, `Import`, `Trivia`, or `Data`.

## Algorithm And Source Preferences

Algorithm/source preferences exist at three levels:

- Global defaults
- Repertoire
- Opening folder

Inheritance order:

- Opening-folder algorithm settings override repertoire settings.
- Repertoire algorithm settings override global defaults.
- Global defaults are the fallback.

The Repertoires hub exposes Algorithm buttons at both repertoire and opening-folder level. Settings exposes the global Algorithm defaults. Detailed source editing happens in a focused Algorithm subview with a top-left Back button and a clear scope title, such as `Algorithm: Global defaults`, `Algorithm: White Main Repertoire`, or `Algorithm: White Main Repertoire / Italian Game`.

Source preferences support ordered individual sources and ordered source groups/packs. A group has its own internal order and can be expanded/collapsed in the UI. Users may pull an individual source out of a group and place that source separately in the top-level priority list. When an individual appears separately, that source is excluded from group instances so the effective source order does not check the same source twice. Entire groups and individual sources can be disabled.

Current implementation note: Algorithm preferences are stored for global, repertoire, and opening-folder scopes, and the UI resolves inheritance. Global defaults still mirror the legacy generation settings so existing generation behavior remains stable. Repertoire/opening scoped generation consumption should be wired in a separate focused pass if deeper generation changes are needed.

Creation flows should eventually ask, in user-facing language, "Whose games should Chesski learn from for this repertoire/opening?" The user should be able to inherit from the parent, customize now, choose a preset group order, and later change the choice through the Algorithm button. TODO: fully integrate that prompt into repertoire and opening-folder creation flows; for now, the Algorithm button is available immediately after creation.

## Repertoires Hub

The Repertoires hub displays one unified repertoire list called `Repertoires`.

It must not show separate visible top-level categories for `Main Repertoires` and `Side Repertoires`. `projectKind: 'siloed'` may remain internal metadata, but it does not create a separate Repertoires hub section.

A standard account should default to:

- `White Main Repertoire`
- `Black Main Repertoire`

Additional/siloed repertoires are simply additional repertoire entries in the same unified list.

Inside each repertoire, the UI should expose opening folders/sections.

Example:

```text
White Main Repertoire
-> Italian Game
-> Ruy Lopez
-> Queen's Gambit
-> London System
-> Catalan
-> Sicilian as White

Black Main Repertoire
-> Sicilian Defense
-> French Defense
-> Caro-Kann Defense
-> Queen's Gambit Declined
-> King's Indian Defense
-> Nimzo-Indian Defense
```

Repertoires remains the hub for training, viewing lines, adding openings, and algorithm actions. Repertoire-level Train and opening-folder-level Train both originate here. View lines opens focused subviews with top-left Back buttons, and Add Opening launches from a specific repertoire.

## Standard Repertoire Behavior

A standard repertoire is a broad side-based tree.

`White Main Repertoire` may contain:

- Italian Game
- Sicilian Defense as White
- Petrov Defense as White
- Queen's Gambit
- London System
- Catalan
- Reti
- English Opening

`Black Main Repertoire` may contain:

- Sicilian Defense
- French Defense
- Caro-Kann Defense
- Queen's Gambit Declined
- King's Indian Defense
- Nimzo-Indian Defense
- English/Reti responses

These openings do not need to be compatible with one another's named opening positions. They only need to be legally reachable from the repertoire's `rootFen`.

## Move Storage

Moves are stored separately as `Edge` records scoped by `repertoireId`.

The repertoire plus its edges forms a move tree rooted at `rootFen`. The same position can appear in multiple repertoires, but each repertoire owns its own edges and SRS state.

Only edges where `edge.mover === repertoire.color` are taught as cards. Opponent moves are stored so the tree can reach the user's decision points.

Opening lead-in moves can be marked as scaffold edges. Scaffold edges connect the starting position to an opening branch without turning every lead-in move into a trainable card.

## Add Opening Behavior

The Add Opening flow should add the selected opening folder/branch to a selected repertoire tree.

The source of truth flows forward from the user's selected opening:

```text
Selected opening
-> explicit opening folder / base path
-> constrained generation
-> inserted line
```

Do not infer the intended opening folder only after generation from whatever edge path happened to be created. Path inference can help display existing data, but it is not the authority for the New Opening flow.

When the user selects an opening card, that selected opening remains the scope for generation and insertion.

Example: if the selected opening is Italian Game, generated/trained lines must be constrained to the Italian Game base path:

```text
1. e4 e5 2. Nf3 Nc6 3. Bc4
```

They must not drift into Ruy Lopez:

```text
1. e4 e5 2. Nf3 Nc6 3. Bb5
```

Italian Game and Ruy Lopez can both live inside `White Main Repertoire`, but they are different opening folders/branches.

Adding to an existing repertoire means adding the selected opening folder/branch into the selected side-based repertoire tree.

It does not mean adding this opening into a selected existing opening container.

For standard repertoires rooted at the normal starting position:

- Add the selected opening's move path from the normal starting position.
- Merge any shared prefix moves already present in the repertoire.
- Mark the opening lead-in as scaffold where appropriate.
- Do not require the target repertoire to have the same `openingKey` or the same opening signature position.

Adding Queen's Gambit to `White Main Repertoire` should work even if that repertoire was originally created from Italian Game, London System, or no curated opening at all.

The workflow should reject only when the selected opening cannot legally connect to the target repertoire root, or when the opening is for the wrong side.

Correct behavior:

- User selects an opening from the Add Opening flow.
- User chooses Add to repertoire.
- The app targets the appropriate color's standard repertoire, usually `White Main Repertoire` or `Black Main Repertoire`.
- The app creates or reuses the matching opening folder inside that repertoire.
- Both generation methods receive the selected opening as a hard prefix constraint.
- The app inserts or merges the selected opening's legal base path from `rootFen`.
- Shared prefix moves merge naturally.
- The app rejects only if the opening path cannot legally connect to the repertoire's `rootFen`.

Incorrect behavior:

- Comparing the selected opening's `openingKey` against the target repertoire's `openingKey`.
- Rejecting Queen's Gambit because the target repertoire was originally created from Italian Game.
- Treating a repertoire as "the Italian Game repertoire" rather than a side-based tree.
- Requiring every new opening added to a repertoire to match the first opening ever added to that repertoire.
- Ignoring the selected opening and generating any legal line from `rootFen`.
- Letting selected Italian Game generate Ruy Lopez because both are legal under `White Main Repertoire`.
- Generating first and then guessing the opening folder from the resulting edge path.

## Opening Generation Scope

There are two different constraints.

Repertoire compatibility is broad:

- `White Main Repertoire` can contain Italian Game, Ruy Lopez, Queen's Gambit, London, Catalan, Sicilian as White, and other White openings.
- This means the app should not reject Queen's Gambit just because `White Main Repertoire` already contains Italian Game.

Opening generation scope is strict:

- When the user selects Italian Game, generation must stay inside Italian Game.
- When the user selects Queen's Gambit, generation must stay inside Queen's Gambit.
- The selected opening's base path constrains the line.

Do not confuse these two.

`openingKey` should not define repertoire compatibility, but opening identity still matters at the folder/branch level.

Correct:

- `White Main Repertoire` can contain multiple opening folders with different opening keys.
- Each opening folder/branch has its own opening identity/base path.
- Lines generated for that folder must match that opening's base path.

Incorrect:

- `White Main Repertoire` has one `openingKey` and everything must match it.
- `White Main Repertoire` has no opening folders and any legal line can be inserted anywhere.
- Selecting Italian Game can produce Ruy Lopez because both are legal under `White Main Repertoire`.

## Add Opening Visibility Rules

The Add Opening flow has two separate workflows.

### Add To Existing Repertoire

This workflow is for expanding a side-based repertoire.

Once an opening has been added to an existing repertoire, it should no longer appear as available under the Add to repertoire workflow for that same repertoire.

Example: if the user adds Italian Game to `White Main Repertoire`, Italian Game should no longer appear as a new opening available to add to `White Main Repertoire`. It is already part of that repertoire's move tree.

This prevents the user from repeatedly adding the same opening branch into the same standard repertoire.

### New Repertoire

This workflow creates a separate repertoire, normally a siloed repertoire for alternative or conflicting prep.

Openings should remain available here even if they already exist in a standard repertoire.

Reason: a separate repertoire is used for intentionally conflicting or alternative prep.

Example: Italian Game can exist inside `White Main Repertoire`, while the user may still create a separate Italian Game repertoire if they want to study an alternative line that conflicts with their standard repertoire.

In a siloed repertoire, the user is allowed to choose different moves from another repertoire after the same opponent move. This is intentional.

## View Lines Subview

The View lines subview should show lines within one selected opening folder, not a vague flat list for the whole repertoire.

Expected hierarchy:

```text
Repertoires
-> White Main Repertoire
   -> Italian Game
   -> Queen's Gambit
   -> London System

View lines - Italian Game
-> e4 e5 Nf3 Nc6 Bc4 ...
-> e4 e5 Nf3 Nc6 Bc4 ...

View lines - Queen's Gambit
-> d4 d5 c4 ...
-> d4 Nf6 c4 ...
```

The opening folder/base opening must remain visible and preserved as a grouping layer.

Deleting prep should respect the hierarchy:

- Deleting a repertoire removes that whole side-specific tree and all of its opening folders.
- Deleting an opening folder removes that opening's base branch and continuations inside one repertoire.
- Shared earlier prefix moves may remain when another opening folder still uses them.

## Validation Rules

Correct validation is repertoire-root based:

- The target repertoire color must match the selected opening color.
- The selected line must be legal from the standard starting position.
- The selected line must reach the target repertoire root at some ply, or the target repertoire root must be the standard starting position.
- A standard starting-position repertoire can accept multiple unrelated base opening branches.
- The selected line must remain under the selected opening folder's base path.

Incorrect validation is opening-signature based:

- Do not reject because the selected opening's signature FEN differs from the target repertoire's `openingKey`.
- Do not compare Queen's Gambit against Italian Game or Alekhine Defense as if the target repertoire were an opening container.

## Main Invariant

A standard repertoire boundary is:

- side
- root position

It is not:

- opening family
- ECO code
- first move by opponent
- `openingKey`
- named opening position

## Practical Coding Rule

Any code that uses `openingKey` to decide whether an opening can be added to a repertoire is probably wrong.

Use `openingKey` for display/provenance only.

Compatibility should be based on legal reachability from `rootFen`, not on matching named openings.

## Standard vs Siloed

Standard repertoires represent the user's main preparation tree for a side.

Siloed repertoires are separate projects. They are useful when the user intentionally wants contradictory prep from the same position, such as one serious tournament repertoire and one experimental repertoire.

Siloed repertoires may still be rooted at the standard initial position; their difference is project isolation, not opening identity.

## Transposition TODO

Do not solve transpositions yet.

Eventually the model should become transposition-aware. Catalan and some other openings can be reached through multiple common move orders, such as `d4 c4 g3` with or without Black having played `...d5`. These should eventually be treated as related structures instead of totally separate openings.

For now, do not solve this as part of the basic repertoire model fix. Avoid making the repertoire model harder to adapt to transpositions later.
