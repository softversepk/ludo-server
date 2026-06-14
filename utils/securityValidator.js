/**
 * Security Validator - Bank-level security for Ludo game
 * Prevents all forms of cheating, hacking, and exploitation
 */

// ═══════════════════════════════════════════════════════════════════════════
// RATE LIMITS
// ═══════════════════════════════════════════════════════════════════════════
const RATE_LIMITS = {
  ACTIONS_PER_SECOND: 10,      // Max 10 actions per second
  ACTIONS_PER_MINUTE: 300,     // Max 300 actions per minute
  DICE_ROLLS_PER_TURN: 10,     // Max 10 dice rolls per turn
  MOVES_PER_TURN: 20,          // Max 20 moves per turn
  SUSPICION_THRESHOLD: 15,     // Flag after 15 suspiciously fast actions
  MIN_ACTION_DELAY: 50,        // Minimum 50ms between actions (anti-bot)
};

// Player action history
const playerActionHistory = new Map();

// ═══════════════════════════════════════════════════════════════════════════
// INPUT SANITIZATION
// ═══════════════════════════════════════════════════════════════════════════
function sanitizeInput(value, type, allowedValues = null) {
  if (value === null || value === undefined) return null;
  
  switch (type) {
    case 'string':
      if (typeof value !== 'string') return null;
      // Remove potential XSS/injection characters
      return value.replace(/[<>"'`]/g, '').substring(0, 100);
    
    case 'number':
      const num = Number(value);
      if (!Number.isFinite(num)) return null;
      return num;
    
    case 'integer':
      if (!Number.isInteger(value)) return null;
      return value;
    
    case 'enum':
      if (!allowedValues || !allowedValues.includes(value)) return null;
      return value;
    
    case 'boolean':
      return Boolean(value);
    
    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RATE LIMIT CHECKING
// ═══════════════════════════════════════════════════════════════════════════
function checkRateLimit(playerId, actionType = 'general') {
  const now = Date.now();
  
  // Initialize history if needed
  if (!playerActionHistory.has(playerId)) {
    playerActionHistory.set(playerId, { 
      actions: [], 
      suspiciousCount: 0,
      turnActions: {}
    });
  }
  
  const history = playerActionHistory.get(playerId);
  
  // Clean old actions (older than 1 minute)
  history.actions = history.actions.filter(timestamp => now - timestamp < 60000);
  
  // 1. Check actions per minute
  if (history.actions.length >= RATE_LIMITS.ACTIONS_PER_MINUTE) {
    console.warn(`🚨 [SECURITY] Player ${playerId} exceeded actions per minute limit`);
    return { allowed: false, reason: 'rate_limit_minute' };
  }
  
  // 2. Check actions per second
  const recentActions = history.actions.filter(timestamp => now - timestamp < 1000);
  if (recentActions.length >= RATE_LIMITS.ACTIONS_PER_SECOND) {
    console.warn(`🚨 [SECURITY] Player ${playerId} exceeded actions per second limit`);
    return { allowed: false, reason: 'rate_limit_second' };
  }
  
  // 3. Check turn-specific limits
  if (actionType === 'dice_roll') {
    const turnRolls = (history.turnActions.dice_rolls || 0);
    if (turnRolls >= RATE_LIMITS.DICE_ROLLS_PER_TURN) {
      console.warn(`🚨 [SECURITY] Player ${playerId} exceeded dice rolls per turn`);
      return { allowed: false, reason: 'rate_limit_dice' };
    }
  }
  
  if (actionType === 'move_token') {
    const turnMoves = (history.turnActions.moves || 0);
    if (turnMoves >= RATE_LIMITS.MOVES_PER_TURN) {
      console.warn(`🚨 [SECURITY] Player ${playerId} exceeded moves per turn`);
      return { allowed: false, reason: 'rate_limit_moves' };
    }
  }
  
  // 4. Check for bot/automation (suspiciously fast actions)
  if (history.actions.length > 0) {
    const lastAction = history.actions[history.actions.length - 1];
    const timeSinceLastAction = now - lastAction;
    
    if (timeSinceLastAction < RATE_LIMITS.MIN_ACTION_DELAY) {
      history.suspiciousCount++;
      
      if (history.suspiciousCount >= RATE_LIMITS.SUSPICION_THRESHOLD) {
        console.warn(`🚨 [SECURITY ESCALATION] Player ${playerId} flagged for bot/automation (${history.suspiciousCount} fast actions)`);
        return { allowed: false, reason: 'suspicious_activity' };
      }
    } else {
      // Reduce suspicion count if actions are normal pace
      history.suspiciousCount = Math.max(0, history.suspiciousCount - 1);
    }
  }
  
  // Record this action
  history.actions.push(now);
  
  // Update turn-specific counters
  if (actionType === 'dice_roll') {
    history.turnActions.dice_rolls = (history.turnActions.dice_rolls || 0) + 1;
  } else if (actionType === 'move_token') {
    history.turnActions.moves = (history.turnActions.moves || 0) + 1;
  }
  
  return { allowed: true };
}

// Reset turn counters when turn changes
function resetTurnCounters(playerId) {
  const history = playerActionHistory.get(playerId);
  if (history) {
    history.turnActions = {};
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTHENTICATION VALIDATION
// ═══════════════════════════════════════════════════════════════════════════
function validateAuthentication(socket, playerId, player) {
  // 1. Verify socket has authenticated user ID
  if (socket.userId && socket.userId !== playerId) {
    console.warn(`🚨 [SECURITY BREACH] Socket ${socket.id} (User: ${socket.userId}) attempted action for player ${playerId}`);
    return { valid: false, reason: 'user_mismatch' };
  }
  
  // 2. Verify socket ID matches player's registered socket
  if (!player) {
    console.warn(`🚨 [SECURITY] Player ${playerId} not found in room`);
    return { valid: false, reason: 'player_not_found' };
  }
  
  const expectedSocketId = player.socketId;
  if (!socket.userId && expectedSocketId && socket.id !== expectedSocketId) {
    console.warn(`🚨 [SECURITY BREACH] Socket ${socket.id} attempted action for player ${playerId} (expected ${expectedSocketId})`);
    return { valid: false, reason: 'socket_mismatch' };
  }
  
  // 3. Block bot control from clients
  if (player.isBot) {
    console.warn(`🚨 [SECURITY BREACH] Socket ${socket.id} attempted to control BOT player ${playerId}`);
    return { valid: false, reason: 'bot_control_blocked' };
  }
  
  return { valid: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME STATE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════
function validateGameState(room, playerColor) {
  // 1. Validate room exists
  if (!room) {
    console.warn(`🚨 [SECURITY] Room not found`);
    return { valid: false, reason: 'room_not_found' };
  }
  
  // 2. Validate game state exists
  if (!room.gameState) {
    console.warn(`🚨 [SECURITY] Game state not initialized`);
    return { valid: false, reason: 'game_not_initialized' };
  }
  
  // 3. Validate it's player's turn
  if (room.gameState.currentPlayer !== playerColor) {
    console.warn(`🚨 [SECURITY] Wrong player turn. Expected: ${room.gameState.currentPlayer}, Got: ${playerColor}`);
    return { valid: false, reason: 'wrong_turn' };
  }
  
  // 4. Validate game not finished
  if (room.gameState.status === 'finished') {
    console.warn(`🚨 [SECURITY] Attempted action in finished game`);
    return { valid: false, reason: 'game_finished' };
  }
  
  return { valid: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// MOVE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════
function validateMove(room, playerColor, tokenIndex, diceValue) {
  // 1. Validate token index range
  if (tokenIndex < 0 || tokenIndex > 3) {
    console.warn(`🚨 [SECURITY] Invalid token index: ${tokenIndex}`);
    return { valid: false, reason: 'invalid_token_index' };
  }
  
  // 2. Validate dice value matches server value
  if (diceValue && diceValue !== room.gameState.diceValue) {
    console.warn(`🚨 [SECURITY] Dice value mismatch. Server: ${room.gameState.diceValue}, Client: ${diceValue}`);
    return { valid: false, reason: 'dice_mismatch' };
  }
  
  // 3. Validate token is in valid moves list
  if (!room.gameState.validMoves || !room.gameState.validMoves.includes(tokenIndex)) {
    console.warn(`🚨 [SECURITY] Token ${tokenIndex} not in valid moves: ${room.gameState.validMoves}`);
    return { valid: false, reason: 'invalid_move' };
  }
  
  // 4. Validate player color exists
  if (!room.gameState.players[playerColor]) {
    console.warn(`🚨 [SECURITY] Player color ${playerColor} not found in game`);
    return { valid: false, reason: 'player_color_not_found' };
  }
  
  // 5. Validate token exists
  const token = room.gameState.players[playerColor].tokens[tokenIndex];
  if (!token) {
    console.warn(`🚨 [SECURITY] Token ${tokenIndex} not found for player ${playerColor}`);
    return { valid: false, reason: 'token_not_found' };
  }
  
  return { valid: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════════
function cleanupRateLimitHistory() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [playerId, history] of playerActionHistory.entries()) {
    // Remove actions older than 1 minute
    history.actions = history.actions.filter(timestamp => now - timestamp < 60000);
    
    // Remove player history if no recent actions
    if (history.actions.length === 0) {
      playerActionHistory.delete(playerId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 [CLEANUP] Removed ${cleaned} inactive player histories. Active: ${playerActionHistory.size}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  sanitizeInput,
  checkRateLimit,
  resetTurnCounters,
  validateAuthentication,
  validateGameState,
  validateMove,
  cleanupRateLimitHistory,
  RATE_LIMITS,
  playerActionHistory
};
