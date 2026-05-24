/**
 * Core Game Logic for Ludo
 *
 * PATH SYSTEM:
 * ============
 *
 * 1. HOME BASE (position = -1)
 *    - Starting area where tokens begin (colored corner areas)
 *    - Requires dice roll of 6 to move to start cell
 *
 * 2. MAIN PATH (positions 0-51)
 *    - WHITE CELLS ONLY - outer circular track around the board
 *    - 52 cells total, shared by all players
 *    - Each player starts at their specific start cell
 *    - Tokens move clockwise around the board
 *    - After completing 52 steps, token enters HOME STRETCH
 *
 * 3. HOME STRETCH (positions 100-104)
 *    - COLORED PATH - player's own colored line leading to center
 *    - 5 cells total (100, 101, 102, 103, 104)
 *    - Token enters from circled box (home entry point) after 52 steps
 *    - Moves towards center on colored track
 *    - After 5 steps in home stretch, token reaches FINAL POSITION (105) and WINS!
 *
 * MOVEMENT RULES:
 * ===============
 * - Token at home (-1): needs 6 to come out
 * - Token on main path (0-51): moves step-by-step on WHITE CELLS only
 * - After completing 52 steps on main track: token enters HOME STRETCH (colored path)
 * - Token in home stretch (100-105): moves on colored line towards center
 * - After 6 steps in home stretch: token is FINISHED (position 106)
 * - Tokens enter home stretch from circled box (home entry point)
 */
/**
 * Helper to generate unique AI names and avatars
 */
exports.getUniqueAIPlayers = (count) => {
  const aiNames = [
    "Computer",
    "Bot Alpha",
    "Bot Beta",
    "Deep Blue",
    "AlphaGo",
    "ChessMaster",
    "LudoKing",
  ];
  return Array.from({ length: count }, (_, i) => {
    const name = aiNames[i % aiNames.length];
    return {
      name,
      // Using helper API for consistent avatars
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random&color=fff&size=200`,
    };
  });
};

const { 
    PLAYER_POSITIONS,
    SAFE_ZONES,
    TOKEN_STATE
 } = require('./gameConstants');

/**
 * Check if position is center (7,7) - INVALID for tokens
 * Center is decoration only, tokens should NEVER be here
 */
exports.isCenterPosition = (position, row, col) => {
  // Check by position number (should never be center)
  if (position === 77 || position === "center") {
    console.error("❌ [CRITICAL] Token attempting to move to CENTER position!");
    return true;
  }

  // Check by coordinates (row 7, col 7)
  if (row === 7 && col === 7) {
    console.error(
      "❌ [CRITICAL] Token attempting to move to CENTER coordinates (7,7)!",
    );
    return true;
  }

  return false;
};

/**
 * Validate token position
 * Returns true if position is valid, false otherwise
 * Updated for 48-cell track (removed 4 corner cells near center)
 */
exports.isValidTokenPosition = (position) => {
  // Valid positions:
  // -1  : Home base
  // 0-51: Main track (white cells) - 52 cells total
  // 100-106: Home stretch (100-105) + Finished (106)

  if (position === -1) return true; // Home base
  if (position >= 0 && position <= 51) return true; // Main track - 52 cells (0-51)
  if (position >= 100 && position <= 106) return true; // Home stretch + center (finished)

  // CRITICAL: Center position check
  if (position === 77 || position === "center") {
    console.error(
      `❌ [CRITICAL] CENTER POSITION DETECTED: ${position} - THIS IS INVALID!`,
    );
    return false;
  }

  console.error(`[GameLogic] Invalid token position detected: ${position}`);
  return false;
};

/**
 * Sanitize token position
 * If position is invalid, return home base (-1)
 */
exports.sanitizeTokenPosition = (position, color) => {
  if (!exports.isValidTokenPosition(position)) {
    console.error(
      `[GameLogic] Sanitizing invalid position ${position} for ${color} -> returning to home base`,
    );
    return -1;
  }
  return position;
};

/**
 * Roll a dice (1-6)
 * Enhanced with weighted probability for better user experience
 * - 6 has higher chance (25% instead of ~16.67%)
 * - Other numbers are distributed fairly
 */
exports.rollDice = () => {
  const random = Math.random();

  // 25% chance for 6 (better user experience)
  if (random < 0.25) return 6;

  // Remaining 75% distributed among 1-5
  // Each gets 15% chance
  if (random < 0.4) return 5;
  if (random < 0.55) return 4;
  if (random < 0.7) return 3;
  if (random < 0.85) return 2;
  return 1;
};

/**
 * Check if a cell is a safe zone
 */
exports.isSafeZone = (cellIndex) => SAFE_ZONES.includes(cellIndex);

/**
 * MAIN PATH - White cells only (52 cells, 0-51)
 * This is the circular path around the board
 * Tokens move ONLY on white cells, never on colored areas
 */
const MAIN_PATH = Array.from({ length: 52 }, (_, i) => i);

/**
 * Calculate new position after move
 * - Positions 0-51: Main track (white cells) - 52 cells total
 * - Positions 100-105: Home stretch (colored path to center) - entered after completing 52 steps
 * - Position 106: Finished (center)
 * Uses stepsFromStart to track progress independently of board position
 * 
 * Quick Arrow Mode: Player must kill an opponent before entering home stretch
 */
exports.calculateNewPosition = (
  currentPos,
  diceValue,
  playerColor,
  currentSteps = 0,
  gameMode = 'classic',
  hasKilled = false,
) => {
  const playerConfig = PLAYER_POSITIONS[playerColor.toUpperCase()];

  const IS_DEV = typeof process !== 'undefined' && process.env && process.env.NODE_ENV !== 'production';
  if (IS_DEV) {
    console.log(
      `[GameLogic] calculateNewPosition: color=${playerColor}, currentPos=${currentPos}, dice=${diceValue}, steps=${currentSteps}`,
    );
  }

  // ===== CASE 1: Token at home base (-1) =====
  if (currentPos === -1) {
    const newPos = diceValue === 6 ? playerConfig.startCell : -1;
    const newSteps = diceValue === 6 ? 0 : 0;
    return { position: newPos, stepsFromStart: newSteps };
  }

  const newSteps = currentSteps + diceValue;

  // ===== CASE 2: Token already finished =====
  if (currentPos === 105 || currentSteps >= 56) {
    return { position: 105, stepsFromStart: 56 };
  }

  // ===== CASE 3: Normal move, entering/moving in home stretch =====
  // Home entry is reached at exactly 50 steps from start cell.
  // Step 51 is the first cell of the home stretch (position 100).
  if (newSteps >= 51) {
    // Quick Arrow Mode check
    if (gameMode === 'quick_arrow' && !hasKilled) {
      if (IS_DEV) {
        console.log(
          `🔒 [QUICK ARROW] Cannot enter center - no kills yet (${playerColor}). Token loops on main track.`
        );
      }
      const loopedSteps = newSteps % 52;
      const newPosition = (playerConfig.startCell + loopedSteps) % 52;
      return { position: newPosition, stepsFromStart: loopedSteps };
    }
    
    // Valid entry into home stretch
    const homeStep = newSteps - 51; // 0 to 5
    
    // Must roll exactly the number needed to finish
    if (homeStep > 5) {
      if (IS_DEV) {
        console.log(`[GameLogic] Invalid move: Token needs ${5 - (currentSteps >= 51 ? currentSteps - 51 : -1)} max to finish`);
      }
      return { position: currentPos, stepsFromStart: currentSteps };
    }
    
    if (homeStep === 5) {
      // Finished
      return { position: 105, stepsFromStart: 56 };
    }
    
    const newPos = 100 + homeStep;
    return { position: newPos, stepsFromStart: newSteps };
  }

  // ===== CASE 4: Normal move on main track (steps 0-50) =====
  const newPosition = (playerConfig.startCell + newSteps) % 52;
  
  if (newPosition < 0 || newPosition >= 52) {
    console.error(`[GameLogic] ERROR: Invalid position calculated: ${newPosition}`);
    return { position: currentPos, stepsFromStart: currentSteps };
  }

  return { position: newPosition, stepsFromStart: newSteps };
};

/**
 * Check if token has finished (reached position 105)
 */
exports.hasTokenFinished = (position) => position === 105;

/**
 * Check if a move is valid
 */
exports.isValidMove = (token, diceValue, playerColor, gameMode = 'classic', hasKilled = false) => {
  if (token.state === TOKEN_STATE.FINISHED) return false;

  if (token.state === TOKEN_STATE.HOME) {
    return diceValue === 6;
  }

  const result = exports.calculateNewPosition(
    token.position,
    diceValue,
    playerColor,
    token.stepsFromStart || 0,
    gameMode,
    hasKilled
  );
  return result.position !== token.position;
};

/**
 * Get all valid moves for a player
 */
exports.getValidMoves = (tokens, diceValue, playerColor, gameMode = 'classic', hasKilled = false) => {
  return tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => exports.isValidMove(token, diceValue, playerColor, gameMode, 
hasKilled));
};

/**
 * Check for kill at position
 * Rules:
 * - Different color token landing on another token kills it
 * - Safe zones (stops) protect tokens from being killed
 * - Same color tokens cannot kill each other
 * - Same team tokens cannot kill each other (in team mode)
 * - Two same-color tokens form a block and cannot be captured
 * - Home stretch (100+) protects tokens
 */
exports.checkForKill = (position, allPlayers, currentPlayerColor, isTeamMode = false) => {
  // Safe zones, home stretch, and home base protect tokens
  if (exports.isSafeZone(position) || position >= 100 || position === -1) return null;

  // Get current player's team
  const currentPlayerTeam = allPlayers[currentPlayerColor]?.team;

  for (const [color, player] of Object.entries(allPlayers)) {
    // Same color tokens cannot kill each other
    if (color === currentPlayerColor) continue;

    // In team mode, same team tokens cannot kill each other
    if (isTeamMode && currentPlayerTeam && player.team === currentPlayerTeam) {
      console.log(`🤝 [TEAM MODE] ${currentPlayerColor} (Team ${currentPlayerTeam}) cannot kill ${color} (Team ${player.team}) - same team!`);
      continue;
    }

    // Count active tokens of this opponent at the position
    const opponentTokens = player.tokens.filter(
      (t) => t.position === position && t.state === TOKEN_STATE.ACTIVE,
    );

    // If 2 or more tokens, it's a Block -> Cannot be captured
    if (opponentTokens.length >= 2) {
      continue; // Skip this opponent, they are safe
    }

    // If exactly 1 token, it's a kill (different color/team token on top)
    if (opponentTokens.length === 1) {
      // Find the specific token index
      const tokenIndex = player.tokens.findIndex(
        (t) => t.position === position && t.state === TOKEN_STATE.ACTIVE,
      );
      
      if (isTeamMode) {
        console.log(`⚔️ [TEAM MODE] ${currentPlayerColor} (Team ${currentPlayerTeam}) kills ${color} (Team ${player.team})!`);
      }
      
      return { color, tokenIndex };
    }
  }
  return null;
};

/**
 * Send token back to home
 */
exports.sendTokenHome = (token) => ({
  ...token,
  position: -1,
  state: TOKEN_STATE.HOME,
  stepsFromStart: 0,
});

/**
 * Move token to new position
 * Clean reusable function with validation
 * Now handles stepsFromStart tracking
 */
exports.moveToken = (token, newPositionData, playerColor) => {
  // Handle both old format (just position) and new format (object with position and stepsFromStart)
  const newPosition =
    typeof newPositionData === "object"
      ? newPositionData.position
      : newPositionData;
  const newSteps =
    typeof newPositionData === "object"
      ? newPositionData.stepsFromStart
      : token.stepsFromStart || 0;

  // Validate new position
  if (!exports.isValidTokenPosition(newPosition)) {
    console.error(
      `[GameLogic] ERROR: Attempting to move token to invalid position ${newPosition}! Keeping at ${token.position}`,
    );
    return token; // Don't move
  }

  const finished = exports.hasTokenFinished(newPosition);

  console.log(
    `[GameLogic] Moving token from ${token.position} to ${newPosition}, steps: ${token.stepsFromStart || 0} -> ${newSteps}, finished: ${finished}`,
  );

  // Additional validation: position 105 should always be FINISHED state
  if (newPosition === 105 && !finished) {
    console.error(
      `[GameLogic] ERROR: Position 105 but hasTokenFinished returned false!`,
    );
  }

  return {
    ...token,
    position: newPosition,
    stepsFromStart: newSteps,
    state: finished ? TOKEN_STATE.FINISHED : TOKEN_STATE.ACTIVE,
  };
};

/**
 * Check if player has achieved quick arrow condition (kill + 1 token finished)
 * This is used to track individual player achievement in team mode
 * Returns true if player has killed AND finished 1 token
 */
exports.hasPlayerAchievedQuickArrow = (tokens, hasKilled = false) => {
  const finishedCount = tokens.filter((token) => token.state === TOKEN_STATE.FINISHED).length;
  
  if (!hasKilled) {
    console.log(`⚡ [QUICK ARROW] Player has not killed yet (finished: ${finishedCount}/1)`);
    return false;
  }
  
  const achieved = finishedCount >= 1;
  if (achieved) {
    console.log(`👤 [QUICK ARROW ACHIEVED] Player achieved quick arrow condition! (killed: ✓, finished: ${finishedCount}/1)`);
  }
  return achieved;
};

/**
 * Check if player has won
 * Quick Arrow Mode: Must kill at least 1 opponent, then only 1 token needs to finish
 * Other Modes: All 4 tokens must finish
 */
exports.hasPlayerWon = (tokens, gameMode = 'classic', hasKilled = false) => {
  const finishedCount = tokens.filter((token) => token.state === TOKEN_STATE.FINISHED).length;
  
  if (gameMode === 'quick_arrow') {
    // Quick Arrow: Must have killed at least 1 opponent AND have 1 token finished
    if (!hasKilled) {
      console.log(`⚡ [QUICK ARROW] Player cannot win yet - no kills (finished: ${finishedCount}/1)`);
      return false;
    }
    const won = finishedCount >= 1;
    if (won) {
      console.log(`🏆 [QUICK ARROW] Player wins! (killed: ✓, finished: ${finishedCount}/1)`);
    }
    return won;
  }
  
  // Classic/Arrow mode: All 4 tokens must finish
  return finishedCount === 4;
};

/**
 * Get teammate color in TeamUp mode
 * Team A: Red + Yellow
 * Team B: Green + Blue
 */
exports.getTeammateColor = (playerColor, players) => {
  const player = players[playerColor];
  if (!player || !player.team) return null;

  const teamA = ['RED', 'YELLOW'];
  const teamB = ['GREEN', 'BLUE'];

  if (player.team === 'A') {
    return teamA.find(color => color !== playerColor && players[color]);
  } else if (player.team === 'B') {
    return teamB.find(color => color !== playerColor && players[color]);
  }

  return null;
};

/**
 * Check if a team has won in TeamUp mode
 * Quick Arrow: Team must have at least 1 kill, then 1 token finished wins
 * Other modes: Both players must finish all tokens
 * Team A: Red + Yellow
 * Team B: Green + Blue
 */
exports.hasTeamWon = (players, isTeamMode, gameMode = 'classic') => {
  if (!isTeamMode) return null;

  const teamA = ['RED', 'YELLOW'];
  const teamB = ['GREEN', 'BLUE'];

  if (gameMode === 'quick_arrow') {
    // Quick Arrow Team Mode: BOTH team members must achieve quick arrow condition
    // (kill opponent AND finish 1 token)
    
    // Check Team A
    const teamAPlayers = teamA.filter(color => players[color]);
    if (teamAPlayers.length > 0) {
      // Both players in Team A must have achieved quick arrow condition
      const teamABothAchieved = teamAPlayers.every(color => {
        const player = players[color];
        return exports.hasPlayerAchievedQuickArrow(
          player.tokens,
          player.hasKilled || player.hasQuickArrowWon
        );
      });
      
      if (teamABothAchieved) {
        console.log(`🏆 [QUICK ARROW TEAM] Team A WINS! (Both players achieved: kill ✓ + finish 1 ✓)`);
        return 'A';
      } else {
        // Log individual achievements for debugging
        teamAPlayers.forEach(color => {
          const player = players[color];
          const finishedCount = player.tokens.filter(t => t.state === TOKEN_STATE.FINISHED).length;
          console.log(`👤 [QUICK ARROW TEAM] ${color}: killed=${player.hasKilled}, finished=${finishedCount}/1, achieved=${player.hasQuickArrowWon || false}`);
        });
      }
    }

    // Check Team B
    const teamBPlayers = teamB.filter(color => players[color]);
    if (teamBPlayers.length > 0) {
      // Both players in Team B must have achieved quick arrow condition
      const teamBBothAchieved = teamBPlayers.every(color => {
        const player = players[color];
        return exports.hasPlayerAchievedQuickArrow(
          player.tokens,
          player.hasKilled || player.hasQuickArrowWon
        );
      });
      
      if (teamBBothAchieved) {
        console.log(`🏆 [QUICK ARROW TEAM] Team B WINS! (Both players achieved: kill ✓ + finish 1 ✓)`);
        return 'B';
      } else {
        // Log individual achievements for debugging
        teamBPlayers.forEach(color => {
          const player = players[color];
          const finishedCount = player.tokens.filter(t => t.state === TOKEN_STATE.FINISHED).length;
          console.log(`👤 [QUICK ARROW TEAM] ${color}: killed=${player.hasKilled}, finished=${finishedCount}/1, achieved=${player.hasQuickArrowWon || false}`);
        });
      }
    }
    
    return null;
  }

  // Classic/Arrow mode: Both players must finish all tokens
  // Check Team A
  const teamAPlayers = teamA.filter(color => players[color]);
  if (teamAPlayers.length > 0) {
    const teamAWon = teamAPlayers.every(color => 
      exports.hasPlayerWon(players[color].tokens, gameMode, players[color].hasKilled)
    );
    if (teamAWon) {
      console.log('🏆 [TEAM MODE] Team A wins! (Red + Yellow)');
      return 'A';
    }
  }

  // Check Team B
  const teamBPlayers = teamB.filter(color => players[color]);
  if (teamBPlayers.length > 0) {
    const teamBWon = teamBPlayers.every(color => 
      hasPlayerWon(players[color].tokens, gameMode, players[color].hasKilled)
    );
    if (teamBWon) {
      console.log('🏆 [TEAM MODE] Team B wins! (Green + Blue)');
      return 'B';
    }
  }

  return null;
};

/**
 * Initialize tokens for a player
 * In Quick Arrow mode, first token starts at the starting position (outside home)
 * All other tokens start at home base (-1)
 */
exports.initializeTokens = (playerColor, gameMode = 'classic') => {
  console.log(`[initializeTokens] Called with playerColor=${playerColor}, gameMode=${gameMode}`);
  const isQuickArrow = gameMode === 'quick_arrow';
  
  // In Quick Arrow mode, first token starts at player's starting cell (outside)
  if (isQuickArrow) {
    const playerConfig = PLAYER_POSITIONS[playerColor.toUpperCase()];
    const tokens = [
      { id: 0, position: playerConfig.startCell, state: TOKEN_STATE.ACTIVE, stepsFromStart: 0 },
      { id: 1, position: -1, state: TOKEN_STATE.HOME, stepsFromStart: 0 },
      { id: 2, position: -1, state: TOKEN_STATE.HOME, stepsFromStart: 0 },
      { id: 3, position: -1, state: TOKEN_STATE.HOME, stepsFromStart: 0 },
    ];
    console.log(`✅ [GameLogic] Quick Arrow: ${playerColor} token 0 starts at position ${playerConfig.startCell} (OUTSIDE)`);
    return tokens;
  }
  
  // Classic mode: all tokens start at home
  const tokens = [
    { id: 0, position: -1, state: TOKEN_STATE.HOME, stepsFromStart: 0 },
    { id: 1, position: -1, state: TOKEN_STATE.HOME, stepsFromStart: 0 },
    { id: 2, position: -1, state: TOKEN_STATE.HOME, stepsFromStart: 0 },
    { id: 3, position: -1, state: TOKEN_STATE.HOME, stepsFromStart: 0 },
  ];

  console.log(`[GameLogic] ${gameMode}: ${playerColor} tokens initialized at home base (-1)`);
  return tokens;
};

/**
 * Initialize game state with randomized player positions
 * Supports team mode with proper turn order
 */
exports.initializeGame = (playerColors, userData = null, options = {}) => {
  const { isTeamMode = false, isTournament = false, tournamentData = null, myMatchId = null } = options;
  
  // 1. Determine who is playing
  const totalCount = playerColors.length;
  const aiCount = userData ? totalCount - 1 : totalCount;

  // Get AI profiles
  const aiPlayers = exports.getUniqueAIPlayers(aiCount);

  // Create a list of identity objects to assign
  let identities = [];

  if (isTournament && tournamentData && myMatchId) {
    // Use tournament match players
    const match = tournamentData.matches.find(m => m.id === myMatchId);
    if (match && match.players) {
      identities = match.players.map(p => ({
        type: p.isBot ? "ai" : "user",
        name: p.name,
        username: p.name,
        avatar: p.avatar,
        uid: p.id,
        isBot: p.isBot,
        aiDelay: p.isBot ? 1500 : 0,
        gamesWon: p.isBot ? Math.floor(Math.random() * 50) : (userData?.gamesWon || 0),
        level: p.isBot ? Math.floor(Math.random() * 10) + 1 : (userData?.level || 1),
        selectedToken: p.isBot ? 'classic' : (userData?.selectedToken || 'classic'),
        selectedDice: p.isBot ? 'classic' : (userData?.selectedDice || 'classic'),
      }));
      // Sort so user is first if they exist, or just keep as is
      identities.sort((a, b) => (a.isBot === b.isBot) ? 0 : a.isBot ? 1 : -1);
    }
  }

  if (identities.length === 0) {
    // Add User identity if exists
    if (userData) {
      identities.push({
        type: "user",
        name: userData.username || userData.displayName || "You",
        username: userData.username,
        avatar: userData.avatar,
        uid: userData.uid,
        isBot: false,
        selectedToken: userData.selectedToken || 'classic',
        selectedDice: userData.selectedDice || 'classic',
        gamesWon: userData.gamesWon || 0,
        gamesPlayed: userData.gamesPlayed || 0,
        winStreak: userData.winStreak || 0,
        level: userData.level || 1,
        gems: userData.gems || 0,
        coins: userData.coins || 0,
      });
    }

    // Add AI identities with unique delays and stats
    const aiDelays = [1000, 1500, 2000, 2500, 3000]; // Different delays for different bots
    aiPlayers.forEach((ai, index) => {
      identities.push({
        type: "ai",
        name: ai.name,
        username: ai.name,
        avatar: ai.avatar,
        isBot: true,
        aiDelay: aiDelays[index % aiDelays.length], // Assign unique delay to each bot
        // AI stats for realistic profiles (matching modal field names)
        gamesWon: ai.gamesWon,
        gamesPlayed: ai.gamesPlayed,
        winStreak: ai.winStreak,
        level: ai.level,
        gems: ai.gems,
        coins: ai.coins,
        selectedToken: 'classic', // AI always uses classic
        selectedDice: 'classic',
      });
    });

    // 2. Shuffle identities
    // Using simple sort shuffle with random to ensure variety
    identities.sort(() => Math.random() - 0.5);
  }

  console.log(
    "[GameLogic] Initialized Game with shuffled identities:",
    identities.map((i) => ({
      name: i.name,
      stats: { wins: i.gamesWon, level: i.level },
    })),
  );

  // 3. Determine turn order based on mode
  let turnOrder;
  if (isTeamMode && playerColors.length === 4) {
    // Team Mode: Alternate between teams
    // Team A: Red + Yellow
    // Team B: Green + Blue
    // Turn order: Red (A) → Green (B) → Yellow (A) → Blue (B)
    turnOrder = ['RED', 'GREEN', 'YELLOW', 'BLUE'];
    console.log("🎯 [TEAM MODE ENABLED] Turn order:", turnOrder.join(' → '));
  } else {
    // Regular mode: use provided color order
    turnOrder = playerColors;
    console.log("🎮 [REGULAR MODE] Turn order:", turnOrder.join(' → '));
  }

  // 4. Map identities to Colors in turn order
  const players = {};
  const teamA = ['RED', 'YELLOW'];
  const teamB = ['GREEN', 'BLUE'];
  const gameMode = options.gameMode || 'classic'; // Get game mode from options
  
  console.log(`🎮 [INIT GAME] Game Mode: ${gameMode}, isTeamMode: ${isTeamMode}`);
  
  turnOrder.forEach((color, index) => {
    const identity = identities[index];
    const team = isTeamMode ? (teamA.includes(color) ? 'A' : 'B') : null;

    console.log(`🏷️ [TEAM ASSIGNMENT] ${color} → Team ${team} (isTeamMode: ${isTeamMode})`);

    players[color] = {
      color,
      tokens: exports.initializeTokens(color, gameMode), // Pass color and game mode
      finishedCount: 0,
      hasKilled: false, // Track if player has killed any opponent (for Quick Arrow mode)
      hasQuickArrowWon: false, // Track if player achieved quick arrow condition in team mode
      hasLeft: false, // Track if player has left the game
      team, // Team assignment (A or B) for team mode
      selectedToken: identity.selectedToken || 'classic',
      selectedDice: identity.selectedDice || 'classic',
      // Spread all identity properties
      type: identity.type,
      name: identity.name,
      username: identity.username,
      avatar: identity.avatar,
      isBot: identity.isBot,
      aiDelay: identity.aiDelay,
      uid: identity.uid,
      // Explicitly set stats
      gamesWon: identity.gamesWon || 0,
      gamesPlayed: identity.gamesPlayed || 0,
      winStreak: identity.winStreak || 0,
      level: identity.level || 1,
      gems: identity.gems || 0,
      coins: identity.coins || 0,
    };
  });

  console.log(
    "[GameLogic] Final players object:",
    Object.entries(players).map(([color, p]) => ({
      color,
      name: p.name,
      team: p.team,
      stats: {
        wins: p.gamesWon,
        played: p.gamesPlayed,
        level: p.level,
        gems: p.gems,
        coins: p.coins,
      },
    })),
  );

  return {
    players,
    currentPlayer: turnOrder[0], // First in turn order starts
    diceValue: null,
    turnOrder,
    winner: null,
    isTeamMode, // Store team mode flag
  };
};

/**
 * Get next player in turn order
 * Supports both regular and team-based modes
 * 
 * Team Mode:
 * - Team A: Red + Yellow
 * - Team B: Green + Blue
 * - Turn order alternates between teams: Red (A) → Green (B) → Yellow (A) → Blue (B)
 */
exports.getNextPlayer = (currentPlayer, turnOrder, diceValue, isTeamMode = false) => {
  // Player gets another turn on rolling 6
  console.log('🔄 [GET_NEXT_PLAYER] Called with:', {
    currentPlayer,
    diceValue,
    turnOrderLength: turnOrder?.length,
    turnOrder: turnOrder,
    isBonusTurn: diceValue === 6,
  });
  
  if (diceValue === 6) {
    console.log('🔄 [GET_NEXT_PLAYER] BONUS TURN - returning same player:', currentPlayer);
    return currentPlayer;
  }

  // Both Regular and Team Mode: use simple clockwise rotation
  // In Team Mode, the turnOrder is already initialized to alternate between teams
  // (e.g. ['RED', 'GREEN', 'YELLOW', 'BLUE'] or ['BLUE', 'RED', 'GREEN', 'YELLOW'])
  const currentIndex = turnOrder.indexOf(currentPlayer);
  const nextPlayerResult = turnOrder[(currentIndex + 1) % turnOrder.length];
  
  console.log('🔄 [GET_NEXT_PLAYER] Result:', {
    currentIndex,
    nextPlayer: nextPlayerResult,
    turnOrderLength: turnOrder.length,
    isTeamMode
  });
  
  return nextPlayerResult;
};
