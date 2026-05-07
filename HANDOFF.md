# Chess Trainer Handoff Document

## Recent Changes: Hierarchical Folder Structure for My Lines Tab

### What Was Changed
The "My Lines" tab now displays opening variations in a hierarchical folder structure instead of a flat list. This makes it easier to navigate large openings with many variations.

### How It Works

**Threshold Rule**: Any position with 6 or more direct child positions becomes a subfolder.

**Structure**:
```
Opening Group (e.g., "Caro-Kann Defense: Exchange Variation")
├── Subfolder 1 (position with 6+ children)
│   ├── Subfolder 1a (if position has 6+ children)
│   │   └── Line cards (leaf lines)
│   └── Line cards (leaf lines)
├── Subfolder 2 (position with 6+ children)
│   └── Line cards (leaf lines)
└── Line cards (lines without 6+ children directly below)
```

### Code Changes

**Modified Files**:
- `src/modes/BrowseMode.tsx`: 
  - Added `VariationFolder` interface for nested folders
  - Updated `OpeningGroup` interface to include `subfolders` array
  - Modified `groupLines()` to identify branching points (positions with 6+ children) and create subfolders
  - Added `buildSubfolders()` helper to detect branching points per line
  - Updated `OpeningGroupView` to render subfolders recursively
  - Added new `VariationFolderView` component for recursive subfolder rendering
  - Added `countAllLines()` helper to show total line count including subfolders

- `src/index.css`:
  - Added `.variation-folder` styling (slightly smaller than opening-folder)
  - Added `.variation-folder-head` styling with 64px preview board
  - Fixed `.folder-preview-board` width/height (was stretching to full width)

### Key Algorithms

1. **Child Count Mapping** (`childCountByFen`): Maps each position FEN to the count of direct child positions
2. **Branching Point Detection** (`buildSubfolders`): For each line, finds the first position with 6+ children and assigns the line to that subfolder
3. **Recursive Rendering**: Subfolders can contain other subfolders, allowing deep hierarchies

### Known Limitations / Next Steps

1. **Subfolder Creation**: Currently creates folders only 1 level deep per line. Could be enhanced to recursively create nested subfolders if deeper positions also have 6+ children.
2. **UI Polish**: The indentation and spacing of nested folders could be refined
3. **Preview Board**: Subfolders show the position board, which helps navigation
4. **Line Count**: Correctly shows total lines including those in all subfolders

### Testing Checklist

- [x] Opening groups with 6+ variations properly create subfolders
- [x] Subfolders are expandable/collapsible
- [x] Line cards display correctly in leaf folders
- [x] Line count reflects total lines (including in subfolders)
- [ ] Deep nesting works properly (nested subfolders)
- [ ] Performance with large opening sets (100+ lines)

---

## Algorithm Issues to Review in Next Context

The following issues have been identified for the next context window review:

### Line Selection Algorithm
**Current Issue**: When selecting the first move of a line, the algorithm should check frontier positions and select based on game frequency in the database.

**Expected Behavior**:
- Identify "frontier" positions (positions where you have no stored repertoire continuation)
- Among frontier positions, select the move that appears most frequently in the game database
- This ensures you're learning the most common opponent responses first

### Line Creation Algorithm
**Current Issue**: Getting "No frontier to learn — repertoire fully covered (or Lichess data unavailable)" even when there should be data or when Stockfish API should be used as fallback.

**Expected Behavior**:
- Check for frontier positions in repertoire
- If frontier exists, find suitable games using win/loss thresholds
- If no suitable games found OR no frontier exists, **still create a line using Stockfish API as fallback**
- Current error message suggests repertoire is "fully covered" which shouldn't prevent stockfish-based line creation

**Algorithm Flow**:
1. Get frontier positions
2. Look for games at frontier positions with win/loss criteria
3. If found: create line from game suggestion
4. If not found: create line using Stockfish evaluation
5. Do NOT fail - always return a line to learn

### Questions to Investigate
- Where is the "repertoire fully covered" check happening?
- Why isn't the Stockfish fallback being triggered?
- What are the exact win/loss thresholds for line creation?
- How are frontier positions defined in the current codebase?

---

## For Next Context: Recommended Prompt

```
Confirm that the line selection algorithm and line creation algorithm are working correctly.

Line Selection:
- When selecting the first move of a line, the algorithm should check frontier positions 
  and select the move most likely to be encountered based on game database frequency.

Line Creation:
- Wins minus losses thresholds determine if a position/move is suitable for learning
- If there are no suitable games in the databases, we should still make a new line using 
  the Stockfish API as a fallback
- "Repertoire fully covered" should never prevent learning a new line because Stockfish 
  can always provide positions

Current Bug:
- After learning several lines, attempting to learn a new line sometimes shows: 
  "No frontier to learn — repertoire fully covered (or Lichess data unavailable)"
- This is incorrect because:
  1. Even if repertoire is "covered", we should use Stockfish
  2. Lichess data unavailability should not prevent Stockfish fallback
  3. The message itself is misleading - it should say we're creating a Stockfish line

Please investigate and fix these issues.
```
