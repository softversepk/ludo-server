/**
 * AI Player Logic for Ludo
 * Smart AI that plays according to difficulty level
 */
const { 
    AI_DIFFICULTY,
    CELL_COUNT,
    PLAYER_POSITIONS,
    TOKEN_STATE,
 } = require('./gameConstants');
const gameLogic = require('./gameLogic');



/**
 * Calculate distance to home for a token
 */
const getDistanceToHome = (position, playerColor) => {
  if (position === -1) return 61; // Home + full track (52 cells + 6 home stretch + 3 buffer)
  if (position >= 100) return 106 - position; // In home stretch

  const playerConfig = PLAYER_POSITIONS[playerColor];
  const stepsFromStart =
    (position - playerConfig.startCell + CELL_COUNT) % CELL_COUNT;
  return CELL_COUNT - 1 - stepsFromStart + 6; // Steps to home entry + home stretch
};

/**
 * Check if a position is threatened by opponents
 */
const isPositionThreatened = (position, allPlayers, currentPlayerColor, gameMode = 'classic') => {
  if (position < 0 || position >= 100 || gameLogic.isSafeZone(position)) return false;

  for (const [color, player] of Object.entries(allPlayers)) {
    if (color === currentPlayerColor) continue;

    for (const token of player.tokens) {
      if (token.state !== TOKEN_STATE.ACTIVE) continue;

      // Check if opponent can reach this position with any dice roll
      for (let dice = 1; dice <= 6; dice++) {
        // FIX: pass stepsFromStart and extract numeric position from result object
        const result = gameLogic.calculateNewPosition(
          token.position,
          dice,
          color,
          token.stepsFromStart || 0,
          gameMode,
          player.hasKilled || false
        );
        const opponentNewPos =
          typeof result === "object" ? result.position : result;
        if (opponentNewPos === position) {
          return true;
        }
      }
    }
  }
  return false;
};

/**
 * Count how many opponent tokens are behind this position
 */
const countOpponentsBehind = (position, allPlayers, currentPlayerColor) => {
  let count = 0;
  for (const [color, player] of Object.entries(allPlayers)) {
    if (color === currentPlayerColor) continue;

    for (const token of player.tokens) {
      if (
        token.state === TOKEN_STATE.ACTIVE &&
        token.position < position &&
        token.position >= 0
      ) {
        count++;
      }
    }
  }
  return count;
};

/**
 * Score a potential move based on various factors
 */
const scoreMove = (
  token,
  tokenIndex,
  diceValue,
  playerColor,
  allPlayers,
  difficulty,
  gameMode = 'classic'
) => {
  let score = 0;

  // FIX: pass stepsFromStart so home-stretch detection works.
  // Extract numeric position from the returned object for all comparisons.
  const newPositionData = gameLogic.calculateNewPosition(
    token.position,
    diceValue,
    playerColor,
    token.stepsFromStart || 0,
    gameMode,
    allPlayers[playerColor]?.hasKilled || false
  );
  const newPosition =
    typeof newPositionData === "object"
      ? newPositionData.position
      : newPositionData;

  // === PRIORITY 1: Finishing moves (highest priority) ===
  if (gameLogic.hasTokenFinished(newPosition)) {
    // hasTokenFinished expects a number
    score += 1000;
  }

  // === PRIORITY 2: Killing opponent tokens ===
  const killTarget = gameLogic.checkForKill(newPosition, allPlayers, playerColor); // numeric
  if (killTarget) {
    const targetToken =
      allPlayers[killTarget.color].tokens[killTarget.tokenIndex];
    const targetDistanceToHome = getDistanceToHome(
      targetToken.position,
      killTarget.color,
    );

    // Higher score for killing tokens closer to finishing
    score += 500 + (57 - targetDistanceToHome) * 5;

    // Extra bonus in hard mode for strategic kills
    if (difficulty === AI_DIFFICULTY.HARD) {
      if (targetDistanceToHome < 15) {
        score += 200; // Kill tokens about to finish
      }
    }
  }

  // === PRIORITY 3: Bringing tokens out of home ===
  if (token.state === TOKEN_STATE.HOME && diceValue === 6) {
    score += 300;

    // In hard mode, consider if start position is safe
    if (difficulty === AI_DIFFICULTY.HARD) {
      const startCell = PLAYER_POSITIONS[playerColor.toUpperCase()].startCell;
      if (isPositionThreatened(startCell, allPlayers, playerColor, gameMode)) {
        score -= 100; // Risky to come out
      }
    }
  }

  // === PRIORITY 4: Entering home stretch ===
  if (newPosition >= 100 && newPosition < 106 && token.position < 100) {
    score += 400;
  }

  // === PRIORITY 5: Moving to safe zones ===
  if (gameLogic.isSafeZone(newPosition) && token.state === TOKEN_STATE.ACTIVE) {
    score += 150;

    // Extra value if currently threatened
    if (isPositionThreatened(token.position, allPlayers, playerColor, gameMode)) {
      score += 100;
    }
  }

  // === PRIORITY 6: Escaping danger ===
  if (token.state === TOKEN_STATE.ACTIVE) {
    const currentlyThreatened = isPositionThreatened(
      token.position,
      allPlayers,
      playerColor,
      gameMode
    );
    const willBeThreatened = isPositionThreatened(
      newPosition,
      allPlayers,
      playerColor,
      gameMode
    );

    if (currentlyThreatened && !willBeThreatened) {
      score += 200; // Escaping danger
    } else if (!currentlyThreatened && willBeThreatened && newPosition < 100) {
      score -= 100; // Moving into danger
    }
  }

  // === PRIORITY 7: Progress towards home ===
  if (token.state === TOKEN_STATE.ACTIVE) {
    const currentDistance = getDistanceToHome(token.position, playerColor);
    const newDistance = getDistanceToHome(newPosition, playerColor);
    score += (currentDistance - newDistance) * 10;
  }

  // === Difficulty-based adjustments ===
  switch (difficulty) {
    case AI_DIFFICULTY.EASY:
      // Add significant randomness - makes suboptimal choices
      score += Math.random() * 300;
      // Sometimes ignore good moves
      if (Math.random() < 0.3) {
        score *= 0.5;
      }
      break;

    case AI_DIFFICULTY.MEDIUM:
      // Moderate randomness
      score += Math.random() * 100;
      break;

    case AI_DIFFICULTY.HARD:
      // Strategic considerations
      // Prefer spreading tokens rather than stacking
      const tokensOnBoard = allPlayers[playerColor].tokens.filter(
        (t) => t.state === TOKEN_STATE.ACTIVE,
      ).length;

      if (token.state === TOKEN_STATE.HOME && tokensOnBoard < 2) {
        score += 50; // Encourage getting more tokens out
      }

      // Block opponent paths
      const opponentsBehind = countOpponentsBehind(
        newPosition,
        allPlayers,
        playerColor,
      );
      score += opponentsBehind * 15;

      // Avoid clustering tokens (can all be killed together)
      const ownTokensAtPosition = allPlayers[playerColor].tokens.filter(
        (t) => t.position === newPosition && t.state === TOKEN_STATE.ACTIVE,
      ).length;
      if (ownTokensAtPosition > 0 && !gameLogic.isSafeZone(newPosition)) {
        score -= 30;
      }
      break;
  }

  return score;
};

/**
 * AI decides which token to move
 */
exports.getAIMove = (
  tokens,
  diceValue,
  playerColor,
  allPlayers,
  difficulty = AI_DIFFICULTY.MEDIUM,
  gameMode = 'classic'
) => {
  const validMoves = gameLogic.getValidMoves(tokens, diceValue, playerColor, gameMode, 
    allPlayers[playerColor]?.hasKilled || false);

  if (validMoves.length === 0) return null;
  if (validMoves.length === 1) return validMoves[0].index;

  // Score each valid move
  const scoredMoves = validMoves.map(({ token, index }) => ({
    index,
    score: scoreMove(
      token,
      index,
      diceValue,
      playerColor,
      allPlayers,
      difficulty,
      gameMode
    ),
  }));

  // Sort by score (highest first)
  scoredMoves.sort((a, b) => b.score - a.score);

  // Difficulty-based selection
  switch (difficulty) {
    case AI_DIFFICULTY.EASY:
      // 40% chance to pick a random move instead of best
      if (Math.random() < 0.4 && scoredMoves.length > 1) {
        const randomIndex = Math.floor(Math.random() * scoredMoves.length);
        return scoredMoves[randomIndex].index;
      }
      break;

    case AI_DIFFICULTY.MEDIUM:
      // 20% chance to pick second best if available
      if (Math.random() < 0.2 && scoredMoves.length > 1) {
        return scoredMoves[1].index;
      }
      break;

    case AI_DIFFICULTY.HARD:
      // Always pick the best move
      break;
  }

  return scoredMoves[0].index;
};

/**
 * Simulate AI thinking delay based on difficulty
 */
exports.getAIThinkingDelay = (difficulty) => {
  switch (difficulty) {
    case AI_DIFFICULTY.EASY:
      return 100 + Math.random() * 200; // Very quick
    case AI_DIFFICULTY.MEDIUM:
      return 200 + Math.random() * 300; // Quick thinking
    case AI_DIFFICULTY.HARD:
      return 300 + Math.random() * 400; // Slightly more thought
    default:
      return 200;
  }
};
