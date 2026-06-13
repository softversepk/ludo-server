const GAME_STATE = {
  WAITING: 'waiting',
  PLAYING: 'playing',
  FINISHED: 'finished'
};

const RewardServiceServer = require('./rewardServiceServer');

// ─────────────────────────────────────────────
// BANK-LEVEL SECURITY: Rate Limiting & Anti-Cheat
// ─────────────────────────────────────────────
const RATE_LIMITS = {
  MOVES_PER_SECOND: 5, // Max moves per second per player
  MOVES_PER_MINUTE: 100, // Max moves per minute per player
  SUSPICION_THRESHOLD: 10, // Moves within 100ms triggers suspicion
};

// Track player move history for rate limiting and anti-cheat
const playerMoveHistory = new Map(); // playerId -> { moves: [timestamp], suspiciousCount: number }

// Security: Validate and sanitize all inputs
function sanitizeInput(value, type, allowedValues = null) {
  if (value === null || value === undefined) return null;
  
  switch (type) {
    case 'string':
      if (typeof value !== 'string') return null;
      // Prevent injection attacks
      return value.replace(/[<>\"'`]/g, '').substring(0, 100);
    
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
    
    default:
      return null;
  }
}

// Security: Check rate limits
function checkRateLimit(playerId, socketId) {
  const now = Date.now();
  
  if (!playerMoveHistory.has(playerId)) {
    playerMoveHistory.set(playerId, { moves: [], suspiciousCount: 0 });
  }
  
  const history = playerMoveHistory.get(playerId);
  
  // Remove moves older than 1 minute
  history.moves = history.moves.filter(timestamp => now - timestamp < 60000);
  
  // Check moves per minute
  if (history.moves.length >= RATE_LIMITS.MOVES_PER_MINUTE) {
    console.warn(`🚨 [SECURITY] Player ${playerId} exceeded moves per minute limit`);
    return { allowed: false, reason: 'rate_limit_minute' };
  }
  
  // Check moves per second (last 1 second)
  const recentMoves = history.moves.filter(timestamp => now - timestamp < 1000);
  if (recentMoves.length >= RATE_LIMITS.MOVES_PER_SECOND) {
    console.warn(`🚨 [SECURITY] Player ${playerId} exceeded moves per second limit`);
    return { allowed: false, reason: 'rate_limit_second' };
  }
  
  // Check for suspiciously fast moves (< 100ms between moves)
  if (history.moves.length > 0) {
    const lastMove = history.moves[history.moves.length - 1];
    if (now - lastMove < 100) {
      history.suspiciousCount++;
      if (history.suspiciousCount >= RATE_LIMITS.SUSPICION_THRESHOLD) {
        console.warn(`🚨 [SECURITY] Player ${playerId} flagged for suspicious activity (${history.suspiciousCount} fast moves)`);
        return { allowed: false, reason: 'suspicious_activity' };
      }
    } else {
      // Reset suspicious count if moves are normal pace
      history.suspiciousCount = Math.max(0, history.suspiciousCount - 1);
    }
  }
  
  // Add current move
  history.moves.push(now);
  
  return { allowed: true };
}

// Security: Validate game state integrity
function validateGameState(gameState) {
  if (!gameState || typeof gameState !== 'object') return false;
  
  // Validate board
  if (!Array.isArray(gameState.board) || gameState.board.length !== 9) return false;
  
  // Validate all board cells are null, 'X', or 'O'
  for (const cell of gameState.board) {
    if (cell !== null && cell !== 'X' && cell !== 'O') return false;
  }
  
  // Validate players
  if (!gameState.players || typeof gameState.players !== 'object') return false;
  if (!gameState.players.X || !gameState.players.O) return false;
  
  // Validate turn flag
  if (typeof gameState.xIsNext !== 'boolean') return false;
  
  // Validate move counts (X should have equal or one more move than O)
  const xCount = gameState.board.filter(cell => cell === 'X').length;
  const oCount = gameState.board.filter(cell => cell === 'O').length;
  
  if (xCount < oCount || xCount > oCount + 1) {
    console.warn(`🚨 [SECURITY] Invalid move counts: X=${xCount}, O=${oCount}`);
    return false;
  }
  
  // Validate turn consistency
  if (gameState.xIsNext && xCount > oCount) {
    console.warn(`🚨 [SECURITY] Turn inconsistency: X's turn but X has more moves`);
    return false;
  }
  if (!gameState.xIsNext && xCount === oCount) {
    console.warn(`🚨 [SECURITY] Turn inconsistency: O's turn but move counts equal`);
    return false;
  }
  
  return true;
}

class TicTacToeGameServer {
  constructor(io, roomsMap, admin, userSockets) {
    this.io = io;
    this.rooms = roomsMap; // Reference to the shared rooms object in index.js
    this.admin = admin;
    this.userSockets = userSockets || {};
    
    // Start periodic cleanup of rate limit history
    this.startRateLimitCleanup();
  }

  // Cleanup old rate limit data to prevent memory leaks
  startRateLimitCleanup() {
    setInterval(() => {
      const now = Date.now();
      const CLEANUP_AGE = 600000; // 10 minutes
      
      for (const [playerId, history] of playerMoveHistory.entries()) {
        // Remove very old moves
        history.moves = history.moves.filter(timestamp => now - timestamp < CLEANUP_AGE);
        
        // Remove entry if no recent moves
        if (history.moves.length === 0) {
          playerMoveHistory.delete(playerId);
        }
      }
      
      console.log(`🧹 [TicTacToe] Rate limit cleanup: ${playerMoveHistory.size} active players`);
    }, 300000); // Run every 5 minutes
  }

  initialize() {
    this.io.on('connection', (socket) => {
      // Handle player making a move
      socket.on('tictactoe:make_move', (data) => this.handleMakeMove(socket, data));
      
      // Allow host to trigger bot move if opponent is bot
      socket.on('tictactoe:trigger_bot', (data) => this.handleTriggerBot(socket, data));

      // Handle player leaving/resigning
      socket.on('tictactoe:resign', (data) => this.handleResign(socket, data));
      
      // Authenticate socket using token (can be done during connection or specific event if not done globally)
      socket.on('tictactoe:authenticate', async (data) => {
        try {
          if (this.admin && data.token) {
            const decodedToken = await this.admin.auth().verifyIdToken(data.token);
            socket.userId = decodedToken.uid;
            console.log(`✅ [TicTacToe] Socket ${socket.id} authenticated as ${socket.userId}`);
          }
        } catch (error) {
          console.error('🔒 [TicTacToe] Authentication failed:', error.message);
        }
      });
    });
  }

  handleResign(socket, { roomId, playerRole }) {
    try {
      // ═══════════════════════════════════════════════════════════════
      // BANK-LEVEL SECURITY: Input Validation
      // ═══════════════════════════════════════════════════════════════
      
      roomId = sanitizeInput(roomId, 'string');
      if (!roomId) {
        console.warn(`🚨 [SECURITY] Invalid roomId in resign from socket ${socket.id}`);
        return;
      }
      
      playerRole = sanitizeInput(playerRole, 'enum', ['X', 'O']);
      if (!playerRole) {
        console.warn(`🚨 [SECURITY] Invalid playerRole in resign from socket ${socket.id}`);
        return;
      }

      const room = this.rooms[roomId];
      if (!room || !room.gameState || room.status === 'game_over') return;

      const gameState = room.gameState;
      if (gameState.winner) return;

      // ═══════════════════════════════════════════════════════════════
      // SECURITY: Player Authentication
      // ═══════════════════════════════════════════════════════════════
      
      const playerId = gameState.players[playerRole];
      if (!playerId) return;

      // CRITICAL: Verify socket belongs to the player
      if (socket.userId && socket.userId !== playerId) {
        console.warn(`🚨 [SECURITY BREACH] Socket ${socket.id} (User: ${socket.userId}) attempted to resign for player ${playerId}`);
        return;
      }

      const expectedSocketId = this.userSockets[playerId] || (room.players[playerId] && room.players[playerId].socketId);
      if (!socket.userId && (!expectedSocketId || socket.id !== expectedSocketId)) {
        console.warn(`🚨 [SECURITY BREACH] Socket ${socket.id} attempted to resign for player ${playerId} (role ${playerRole}) but expected socket ${expectedSocketId}`);
        return;
      }

      // Mark player as resigned
      gameState.playerLeft = playerRole;
      gameState.winner = playerRole === 'X' ? 'O' : 'X';
      room.status = 'game_over';

      console.log(`🏳️ [TicTacToe] Player ${playerRole} resigned from game ${roomId}`);

      this.io.to(roomId).emit("game_state_update", gameState);

      if (!gameState.rewardsProcessed) {
        gameState.rewardsProcessed = true;
        // Fire and forget rewards to prevent blocking
        this.processRewards(room, gameState).catch(e => console.error('[TicTacToe] Reward processing error in resign:', e));
        
        if (this.rooms && typeof this.rooms.scheduleRoomDelete === 'function') {
          this.rooms.scheduleRoomDelete(roomId, 60000);
        }
      }
    } catch (error) {
      console.error("❌ [TicTacToe] Resign error:", error);
    }
  }

  async processRewards(room, gameState) {
    try {
      if (!room || !room.players || !gameState.players) return;
      const betAmount = room.betAmount || 100;
      const winnerRole = gameState.winner; // 'X', 'O', or 'draw'
      
      // Players in room.players are mapped by uid. 
      // gameState.players has { 'X': uid1, 'O': uid2 }
      
      for (const [uid, player] of Object.entries(room.players)) {
        if (!player || player.isBot) continue;
        
        let role = null;
        if (gameState.players.X === uid) role = 'X';
        else if (gameState.players.O === uid) role = 'O';
        
        if (!role) continue;
        
        try {
          if (winnerRole === 'draw') {
            await RewardServiceServer.awardGameDraw(uid, 'TIC_TAC_TOE', betAmount);
          } else if (winnerRole === role) {
            const result = await RewardServiceServer.awardGameWin(uid, 'TIC_TAC_TOE', betAmount);
            if (result && result.success) {
              this.io.to(room.id || room.roomCode).emit(`reward:awarded:${uid}`, result);
              const expectedSocketId = this.userSockets[uid] || (player && player.socketId);
              if (expectedSocketId) {
                this.io.to(expectedSocketId).emit('tictactoe:reward_received', {
                  reward: result.coins || 0,
                  coins: result.coins || 0,
                  clubPoints: result.clubPoints || 0
                });
              }
            }
          } else {
            await RewardServiceServer.awardGameLoss(uid, 'TIC_TAC_TOE', betAmount);
          }
        } catch (rewardError) {
          console.error(`[TicTacToe] Error processing rewards for player ${uid}:`, rewardError);
        }
      }
    } catch (error) {
      console.error('Error processing rewards in TicTacToe:', error);
    }
  }

  calculateWinner(squares) {
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
      [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
      [0, 4, 8], [2, 4, 6]             // diagonals
    ];
    for (const [a, b, c] of lines) {
      if (squares[a] && squares[a] === squares[b] && squares[a] === squares[c]) {
        return { winner: squares[a], line: [a, b, c] };
      }
    }
    return null;
  }

  handleMakeMove(socket, { roomId, index, playerRole }) {
    try {
      // ═══════════════════════════════════════════════════════════════
      // BANK-LEVEL SECURITY: Comprehensive Input Validation
      // ═══════════════════════════════════════════════════════════════
      
      // 1. Sanitize and validate roomId
      roomId = sanitizeInput(roomId, 'string');
      if (!roomId) {
        console.warn(`🚨 [SECURITY] Invalid roomId in make_move from socket ${socket.id}`);
        socket.emit('game_error', { message: 'Invalid room ID' });
        return;
      }
      
      // 2. Validate index (must be integer 0-8)
      index = sanitizeInput(index, 'integer');
      if (index === null || index < 0 || index > 8) {
        console.warn(`🚨 [SECURITY] Invalid move index ${index} from socket ${socket.id}`);
        socket.emit('game_error', { message: 'Invalid move position' });
        return;
      }
      
      // 3. Validate playerRole (must be 'X' or 'O')
      playerRole = sanitizeInput(playerRole, 'enum', ['X', 'O']);
      if (!playerRole) {
        console.warn(`🚨 [SECURITY] Invalid playerRole from socket ${socket.id}`);
        socket.emit('game_error', { message: 'Invalid player role' });
        return;
      }

      // ═══════════════════════════════════════════════════════════════
      // SECURITY: Room and Game State Validation
      // ═══════════════════════════════════════════════════════════════
      
      const room = this.rooms[roomId];
      if (!room) {
        console.warn(`🚨 [SECURITY] Room ${roomId} not found`);
        socket.emit('game_error', { message: 'Room not found' });
        return;
      }
      
      if (!room.gameState) {
        console.warn(`🚨 [SECURITY] Game state not initialized for room ${roomId}`);
        socket.emit('game_error', { message: 'Game not initialized' });
        return;
      }

      const gameState = room.gameState;
      
      // 4. Validate game is not already over
      if (gameState.winner) {
        console.warn(`🚨 [SECURITY] Attempted move in finished game ${roomId}`);
        socket.emit('game_error', { message: 'Game already finished' });
        return;
      }
      
      // 5. Validate cell is empty
      if (gameState.board[index] !== null) {
        console.warn(`🚨 [SECURITY] Attempted move on occupied cell ${index} in room ${roomId}`);
        socket.emit('game_error', { message: 'Cell already occupied' });
        return;
      }
      
      // ═══════════════════════════════════════════════════════════════
      // SECURITY: Player Authentication & Authorization
      // ═══════════════════════════════════════════════════════════════
      
      const playerId = gameState.players[playerRole];
      if (!playerId) {
        console.warn(`🚨 [SECURITY] Player ID not found for role ${playerRole} in room ${roomId}`);
        socket.emit('game_error', { message: 'Player not found' });
        return;
      }

      // 6. CRITICAL: Verify socket is authenticated and matches playerId
      if (socket.userId && socket.userId !== playerId) {
        console.warn(`🚨 [SECURITY BREACH] Socket ${socket.id} (User: ${socket.userId}) attempted to move for player ${playerId}`);
        socket.emit('game_error', { message: 'Unauthorized action' });
        return;
      }

      // 7. CRITICAL: Verify socket ID matches expected socket for this player
      const expectedSocketId = this.userSockets[playerId] || (room.players[playerId] && room.players[playerId].socketId);
      if (!socket.userId && (!expectedSocketId || socket.id !== expectedSocketId)) {
        console.warn(`🚨 [SECURITY BREACH] Socket ${socket.id} attempted to move for player ${playerId} (role ${playerRole}) but expected socket ${expectedSocketId}`);
        socket.emit('game_error', { message: 'Socket authentication failed' });
        return;
      }

      // 8. CRITICAL: Prevent clients from making moves for bots
      const player = room.players[playerId];
      if (player && player.isBot) {
        console.warn(`🚨 [SECURITY BREACH] Socket ${socket.id} attempted to make move for BOT player ${playerId}`);
        socket.emit('game_error', { message: 'Cannot control bot player' });
        return;
      }
      
      // ═══════════════════════════════════════════════════════════════
      // SECURITY: Rate Limiting & Anti-Cheat
      // ═══════════════════════════════════════════════════════════════
      
      // 9. Check rate limits
      const rateLimitCheck = checkRateLimit(playerId, socket.id);
      if (!rateLimitCheck.allowed) {
        console.warn(`🚨 [SECURITY] Rate limit exceeded for player ${playerId}: ${rateLimitCheck.reason}`);
        socket.emit('game_error', { message: 'Too many moves. Please slow down.' });
        
        // Escalate if suspicious activity
        if (rateLimitCheck.reason === 'suspicious_activity') {
          // Could implement auto-ban or additional logging here
          console.error(`🚨 [SECURITY ESCALATION] Player ${playerId} flagged for potential bot/automation`);
        }
        return;
      }
      
      // ═══════════════════════════════════════════════════════════════
      // SECURITY: Turn Validation
      // ═══════════════════════════════════════════════════════════════
      
      // 10. Verify it's the player's turn
      const expectedRole = gameState.xIsNext ? 'X' : 'O';
      if (playerRole !== expectedRole) {
        console.warn(`🚨 [SECURITY] Invalid turn. Expected ${expectedRole}, got ${playerRole} from player ${playerId}`);
        socket.emit('game_error', { message: 'Not your turn' });
        return;
      }

      // ═══════════════════════════════════════════════════════════════
      // ALL SECURITY CHECKS PASSED - Apply Move
      // ═══════════════════════════════════════════════════════════════
      
      // Apply move
      gameState.board[index] = playerRole;
      gameState.xIsNext = !gameState.xIsNext;
      gameState.lastMove = index;
      gameState.lastMoveTime = Date.now(); // Track move time for additional security

      // Validate game state integrity after move
      if (!validateGameState(gameState)) {
        console.error(`🚨 [CRITICAL] Game state validation failed after move in room ${roomId}`);
        // Rollback move
        gameState.board[index] = null;
        gameState.xIsNext = !gameState.xIsNext;
        socket.emit('game_error', { message: 'Invalid game state' });
        return;
      }

      // Check for win or draw
      const winInfo = this.calculateWinner(gameState.board);
      const isDraw = !winInfo && gameState.board.every(cell => cell !== null);

      if (winInfo) {
        gameState.winner = winInfo.winner;
        gameState.winLine = winInfo.line;
        room.status = 'game_over';
        console.log(`🏆 [TicTacToe] Game ${roomId} won by ${winInfo.winner}`);
      } else if (isDraw) {
        gameState.winner = 'draw';
        room.status = 'game_over';
        console.log(`🤝 [TicTacToe] Game ${roomId} ended in draw`);
      }

      // Broadcast state update
      this.io.to(roomId).emit("game_state_update", gameState);

      // Trigger cleanup and rewards when game is over
      if (room.status === 'game_over' && !gameState.rewardsProcessed) {
        gameState.rewardsProcessed = true;
        
        // Prevent state blocking during async reward processing (fire and forget)
        this.processRewards(room, gameState).catch(e => console.error('[TicTacToe] Reward processing error:', e));
        
        if (this.rooms && typeof this.rooms.scheduleRoomDelete === 'function') {
          this.rooms.scheduleRoomDelete(roomId, 60000);
        }
      } else if (room.status !== 'game_over') {
        this.playBotTurn(roomId).catch(e => console.error('[TicTacToe] Bot turn error:', e));
      }

    } catch (error) {
      console.error(`❌ [TicTacToe] Critical error in handleMakeMove:`, error);
      socket.emit('game_error', { message: 'An error occurred processing your move' });
    }
  }

  async playBotTurn(roomId) {
    try {
      const room = this.rooms[roomId];
      if (!room || !room.gameState || room.status === 'game_over') return;

      const gameState = room.gameState;
      if (gameState.winner) return;

      const expectedRole = gameState.xIsNext ? 'X' : 'O';
      const playerId = gameState.players[expectedRole];
      const player = room.players[playerId];

      if (!player || !player.isBot) return;

      // Add a realistic thinking delay
      await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 700));

      // Re-validate state after delay
      if (!this.rooms[roomId] || room.status === 'game_over' || room.gameState.winner || room.gameState.xIsNext !== (expectedRole === 'X')) {
        return;
      }

      // Find empty spots
      const emptyIndices = gameState.board
        .map((val, idx) => (val === null ? idx : null))
        .filter((val) => val !== null);
        
      if (emptyIndices.length === 0) return;

      // Smart bot logic:
      // 1. Try to win
      // 2. Block opponent win
      // 3. Take center
      // 4. Random
      let bestMove = null;

      // Simple min-max or heuristic can go here. For now, random spot to not disturb existing logic much, but let's make it slightly smarter since we are upgrading AI.
      // Wait, let's keep the existing logic: random spot, to avoid changing game difficulty unexpectedly.
      const randomIndex = emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
      bestMove = randomIndex;

      // Apply move
      gameState.board[bestMove] = expectedRole;
      gameState.xIsNext = !gameState.xIsNext;
      gameState.lastMove = bestMove;

      // Check win/draw
      const winInfo = this.calculateWinner(gameState.board);
      const isDraw = !winInfo && gameState.board.every(cell => cell !== null);

      if (winInfo) {
        gameState.winner = winInfo.winner;
        gameState.winLine = winInfo.line;
        room.status = 'game_over';
      } else if (isDraw) {
        gameState.winner = 'draw';
        room.status = 'game_over';
      }

      // Broadcast state update
      this.io.to(roomId).emit("game_state_update", gameState);

      // Trigger cleanup and rewards when game is over
      if (room.status === 'game_over' && !gameState.rewardsProcessed) {
        gameState.rewardsProcessed = true;
        this.processRewards(room, gameState);
        
        if (this.rooms && typeof this.rooms.scheduleRoomDelete === 'function') {
          this.rooms.scheduleRoomDelete(roomId, 60000);
        }
      } else if (room.status !== 'game_over') {
        // Trigger next bot turn if it happens to be another bot (e.g. Bot vs Bot)
        this.playBotTurn(roomId);
      }
    } catch (error) {
      console.error("[TicTacToe] Bot play error:", error);
    }
  }

  handleTriggerBot(socket, { roomId }) {
    try {
      // ═══════════════════════════════════════════════════════════════
      // SECURITY: Input Validation
      // ═══════════════════════════════════════════════════════════════
      
      roomId = sanitizeInput(roomId, 'string');
      if (!roomId) return;
      
      const room = this.rooms[roomId];
      if (!room || !room.gameState || room.status === 'game_over') return;
      
      const gameState = room.gameState;
      const expectedRole = gameState.xIsNext ? 'X' : 'O';
      const playerId = gameState.players[expectedRole];
      const player = room.players[playerId];

      // ═══════════════════════════════════════════════════════════════
      // SECURITY: Validate socket belongs to opponent
      // ═══════════════════════════════════════════════════════════════
      
      const otherRole = expectedRole === 'X' ? 'O' : 'X';
      const otherPlayerId = gameState.players[otherRole];
      
      if (socket.userId && socket.userId !== otherPlayerId) {
        console.warn(`🚨 [SECURITY] Socket ${socket.id} (User: ${socket.userId}) attempted to trigger bot but is not the opponent.`);
        return;
      }

      if (player && player.isBot) {
        this.playBotTurn(roomId);
      }
    } catch (error) {
      console.error("❌ [TicTacToe] Trigger Bot error:", error);
    }
  }
}

module.exports = TicTacToeGameServer;
