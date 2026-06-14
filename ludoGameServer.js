/**
 * Optimized Ludo Game Server with Socket.IO
 * Real-time synchronization with delta updates and server-side validation
 */

const GAME_STATE = {
  WAITING: 'waiting',
  ROLLING: 'rolling',
  MOVING: 'moving',
  FINISHED: 'finished'
};

const TOKEN_STATE = {
  HOME: 'home',
  ACTIVE: 'active',
  SAFE: 'safe',
  FINISHED: 'finished'
};

const RewardServiceServer = require('./rewardServiceServer');
const { getAIMove, getAIThinkingDelay } = require('./utils/aiPlayer');
const { AI_DIFFICULTY } = require('./utils/gameConstants');

class LudoGameServer {
  constructor(io, admin) {
    this.io = io;
    this.admin = admin;
    this.rooms = new Map();
    this.playerConnections = new Map(); // Track socket.id to room mapping
  }

  /**
   * Initialize Socket.IO event handlers
   */
  initialize() {
    this.io.on('connection', (socket) => {
      console.log(`✅ Player connected: ${socket.id}`);

      // Game Lifecycle Events
      socket.on('ludo:join_game', (data) => this.handleJoinGame(socket, data));
      socket.on('ludo:leave_game', (data) => this.handleLeaveGame(socket, data));
      socket.on('ludo:player_ready', (data) => this.handlePlayerReady(socket, data));
      socket.on('ludo:start_game', (data) => this.handleStartGame(socket, data));

      // Game Action Events (Optimized with Delta Updates)
      socket.on('ludo:roll_dice', (data) => this.handleRollDice(socket, data));
      socket.on('ludo:undo_roll', (data) => this.handleUndoRoll(socket, data));
      socket.on('ludo:move_token', (data) => this.handleMoveToken(socket, data));
      socket.on('ludo:skip_turn', (data) => this.handleSkipTurn(socket, data));

      // Real-time Sync Events
      socket.on('ludo:request_sync', (data) => this.handleRequestSync(socket, data));
      socket.on('ludo:heartbeat', (data) => this.handleHeartbeat(socket, data));

      // Disconnection
      socket.on('disconnect', () => this.handleDisconnect(socket));
    });
  }

  /**
   * Join a Ludo game room
   */
  async handleJoinGame(socket, { roomId, playerId, playerData, token }) {
    try {
      console.log(`🎮 [JOIN] Player ${playerId} joining room ${roomId}`);

      // SECURITY: Token-based Authentication
      if (!token) {
        console.warn(`[Ludo] Security Alert: Join attempt without token by ${playerId}`);
        socket.emit('ludo:join_error', { error: 'Authentication token required' });
        return;
      }

      if (this.admin) {
        try {
          const decodedToken = await this.admin.auth().verifyIdToken(token);
          if (decodedToken.uid !== playerId) {
            console.warn(`[Ludo] Security Alert: UID mismatch. Token UID: ${decodedToken.uid}, Requested: ${playerId}`);
            socket.emit('ludo:join_error', { error: 'Unauthorized user ID mismatch' });
            return;
          }
          // Mark socket as securely authenticated
          socket.userId = playerId;
        } catch (authError) {
          console.error('[Ludo] Security Alert: Token verification failed:', authError.message);
          socket.emit('ludo:join_error', { error: 'Invalid or expired authentication token' });
          return;
        }
      } else {
        // Fallback if admin not initialized (e.g., local dev without Firebase)
        socket.userId = playerId;
      }

      // Get or create room
      let room = this.rooms.get(roomId);
      if (!room) {
        room = this.createRoom(roomId);
        if (playerData) {
          room.isTeam = playerData.isTeamMode || playerData.isTeam || false;
          room.isTeamMode = room.isTeam;
          room.gameMode = playerData.gameMode || 'classic';
          room.mode = room.gameMode;
          room.betAmount = playerData.betAmount || 100;
          room.gameState.isTeamMode = room.isTeam;
          room.gameState.gameMode = room.gameMode;
        }
        this.rooms.set(roomId, room);
      }

      // Check if room is full
      if (Object.keys(room.players).length >= room.maxPlayers) {
        socket.emit('ludo:join_error', { error: 'Room is full' });
        return;
      }

      // Check if game already started
      if (room.gameState.status !== GAME_STATE.WAITING) {
        socket.emit('ludo:join_error', { error: 'Game already in progress' });
        return;
      }

      // Add player to room
      const playerColor = this.assignPlayerColor(room);
      room.players[playerId] = {
        id: playerId,
        socketId: socket.id,
        color: playerColor,
        name: playerData.name || 'Player',
        avatar: playerData.avatar || '',
        selectedToken: playerData.selectedToken || 'classic',
        ready: false,
        connected: true,
        lastHeartbeat: Date.now()
      };

      // Initialize player tokens
      room.gameState.players[playerColor] = {
        tokens: [
          { id: 0, position: -1, state: TOKEN_STATE.HOME },
          { id: 1, position: -1, state: TOKEN_STATE.HOME },
          { id: 2, position: -1, state: TOKEN_STATE.HOME },
          { id: 3, position: -1, state: TOKEN_STATE.HOME }
        ],
        finishedCount: 0,
        isBot: playerData.isBot || false
      };

      // Add socket to room
      socket.join(roomId);
      this.playerConnections.set(socket.id, { roomId, playerId, playerColor });

      // Notify all players
      this.broadcastRoomUpdate(roomId);

      // Send success response to joining player
      socket.emit('ludo:join_success', {
        roomId,
        playerColor,
        roomState: this.getRoomState(room)
      });

      console.log(`✅ [JOIN] Player ${playerId} joined as ${playerColor}`);
    } catch (error) {
      console.error('❌ [JOIN ERROR]', error);
      socket.emit('ludo:join_error', { error: error.message });
    }
  }

  /**
   * Handle player leaving game
   */
  handleLeaveGame(socket, { roomId, playerId }) {
    try {
      console.log(`👋 [LEAVE] Player ${playerId} leaving room ${roomId}`);

      // SECURITY: Validate authenticated socket
      if (socket.userId && socket.userId !== playerId) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} (User: ${socket.userId}) attempted to leave game for player ${playerId}`);
        return;
      }

      const room = this.rooms.get(roomId);
      if (!room) return;

      // Remove player
      if (room.players[playerId]) {
        const playerColor = room.players[playerId].color;
        
        // Mark player as left instead of deleting immediately if game is in progress
        if (room.gameState.status === GAME_STATE.MOVING || room.gameState.status === GAME_STATE.ROLLING) {
           room.players[playerId].hasLeft = true;
           room.players[playerId].connected = false;
           // Move all tokens home and finish them so they can't be played
           if (room.gameState.players[playerColor]) {
               room.gameState.players[playerColor].tokens.forEach(t => {
                   t.position = -1;
                   t.state = TOKEN_STATE.FINISHED;
               });
           }
           
           // Check if there's only 1 real player left, auto-win
           const activeRealPlayers = Object.values(room.players).filter(p => !p.hasLeft && !p.isBot);
           if (activeRealPlayers.length === 1) {
               this.handleGameOver(room, activeRealPlayers[0].color);
           }
        } else {
           delete room.players[playerId];
           delete room.gameState.players[playerColor];
        }
      }

      socket.leave(roomId);
      this.playerConnections.delete(socket.id);

      // Check if any real human players are left
      const remainingPlayers = Object.values(room.players);
      const hasRealPlayers = remainingPlayers.some(p => !p.isBot && !p.hasLeft);

      // If room is empty or only bots left, delete it
      if (!hasRealPlayers) {
        this.rooms.delete(roomId);
        console.log(`🗑️ [CLEANUP] Room ${roomId} deleted (only bots left or empty)`);
      } else {
        // Notify remaining players
        this.broadcastRoomUpdate(roomId);
      }
    } catch (error) {
      console.error('❌ [LEAVE ERROR]', error);
    }
  }

  /**
   * Handle player ready status
   */
  handlePlayerReady(socket, { roomId, playerId, ready }) {
    try {
      // SECURITY: Validate authenticated socket
      if (socket.userId && socket.userId !== playerId) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} (User: ${socket.userId}) attempted to set ready for player ${playerId}`);
        return;
      }

      const room = this.rooms.get(roomId);
      if (!room || !room.players[playerId]) return;

      room.players[playerId].ready = ready;

      // Broadcast update
      this.broadcastRoomUpdate(roomId);

      // Check if all players are ready
      const allReady = Object.values(room.players).every(p => p.ready);
      
      const isFourPlayer = room.isTeamMode || room.gameMode === 'team' || room.gameMode === 'ludo_teamup' || room.gameMode === 'ludo_4p' || room.mode === 'ludo_teamup' || room.mode === 'ludo_4p' || room.maxPlayers === 4;
      const requiredPlayers = isFourPlayer ? 4 : 2;

      if (allReady && Object.keys(room.players).length >= requiredPlayers) {
        this.io.to(roomId).emit('ludo:all_ready', { canStart: true });
      }
    } catch (error) {
      console.error('❌ [READY ERROR]', error);
    }
  }

  /**
   * Start the game
   */
  handleStartGame(socket, { roomId, playerId }) {
    try {
      console.log(`🎬 [START] Starting game in room ${roomId}`);

      // SECURITY: Validate authenticated socket
      if (socket.userId && socket.userId !== playerId) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} (User: ${socket.userId}) attempted to start game for player ${playerId}`);
        return;
      }

      const room = this.rooms.get(roomId);
      if (!room) return;

      // Verify all players ready
      const allReady = Object.values(room.players).every(p => p.ready);
      if (!allReady) {
        socket.emit('ludo:start_error', { error: 'Not all players are ready' });
        return;
      }

      // SECURITY: Ensure correct player count to prevent hackers from starting games alone
      const isFourPlayer = room.isTeamMode || room.gameMode === 'team' || room.gameMode === 'ludo_teamup' || room.gameMode === 'ludo_4p' || room.mode === 'ludo_teamup' || room.mode === 'ludo_4p' || room.maxPlayers === 4;
      const currentPlayersCount = Object.keys(room.players).length;
      
      if (isFourPlayer) {
        if (currentPlayersCount < 4) {
          console.warn(`[SECURITY] Blocked hacked start_game: Host tried to start a 4-player game with only ${currentPlayersCount} players`);
          socket.emit('ludo:start_error', { error: 'This game mode requires exactly 4 players to start.' });
          return;
        }
      } else {
        if (currentPlayersCount < 2) {
          console.warn(`[SECURITY] Blocked hacked start_game: Host tried to start a 2-player game with only ${currentPlayersCount} players`);
          socket.emit('ludo:start_error', { error: 'This game mode requires at least 2 players to start.' });
          return;
        }
      }

      // Initialize turn order
      room.gameState.turnOrder = Object.values(room.players).map(p => p.color);
      room.gameState.currentPlayer = room.gameState.turnOrder[0];
      room.gameState.status = GAME_STATE.ROLLING;
      room.gameState.startTime = Date.now();

      // Broadcast game start
      this.io.to(roomId).emit('ludo:game_started', {
        gameState: this.getGameState(room),
        timestamp: Date.now()
      });

      console.log(`✅ [START] Game started. Turn order: ${room.gameState.turnOrder.join(' → ')}`);

      // Trigger bot turn if first player is a bot
      this.playBotTurn(roomId);
    } catch (error) {
      console.error('❌ [START ERROR]', error);
      socket.emit('ludo:start_error', { error: error.message });
    }
  }

  /**
   * Handle AI bot turn automatically
   */
  async playBotTurn(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || room.gameState.status === GAME_STATE.FINISHED) return;

    const currentColor = room.gameState.currentPlayer;
    const player = Object.values(room.players).find(p => p.color === currentColor);
    
    // Check if the current player is actually a bot
    if (!player || !player.isBot) return;

    // Optional: Determine AI difficulty based on room settings or default
    const difficulty = room.aiDifficulty || AI_DIFFICULTY.MEDIUM;
    const gameMode = room.mode || 'classic';

    try {
      // 1. ROLLING STATE
      if (room.gameState.status === GAME_STATE.ROLLING) {
        // Simulate thinking before rolling
        await new Promise(resolve => setTimeout(resolve, getAIThinkingDelay(difficulty)));

        // Double check room state hasn't changed during delay
        if (!this.rooms.has(roomId) || room.gameState.status !== GAME_STATE.ROLLING || room.gameState.currentPlayer !== currentColor) return;

        // Roll dice
        const diceValue = Math.floor(Math.random() * 6) + 1;
        room.gameState.diceValue = diceValue;
        room.gameState.lastDiceRoll = Date.now();

        if (!room.gameState.accumulatedDice) {
          room.gameState.accumulatedDice = [];
        }
        if (!room.gameState.turnDiceValues) {
          room.gameState.turnDiceValues = [];
        }
        room.gameState.accumulatedDice.push(diceValue);
        room.gameState.turnDiceValues.push(diceValue);

        if (!room.gameState.lastDiceValues) {
          room.gameState.lastDiceValues = {};
        }
        room.gameState.lastDiceValues[currentColor] = diceValue;

        // Count consecutive sixes securely in backend
        const consecutiveSixesCount = room.gameState.accumulatedDice.filter(d => d === 6).length;

        if (diceValue === 6) {
          if (consecutiveSixesCount >= 3) {
            // 3 consecutive sixes: turn is cancelled
            console.log(`🚫 [RULE] BOT ${currentColor} rolled 3 consecutive sixes. Turn cancelled.`);
            room.gameState.accumulatedDice = [];
            room.gameState.validMoves = [];
            this.nextTurn(room);
            return;
          } else {
            // Allow another roll, keep status ROLLING
            room.gameState.status = GAME_STATE.ROLLING;
            room.gameState.validMoves = [];
            
            this.broadcastDeltaUpdate(roomId, {
              type: 'dice_roll',
              playerColor: currentColor,
              diceValue,
              accumulatedDice: room.gameState.accumulatedDice,
              turnDiceValues: room.gameState.turnDiceValues,
              validMoves: [],
              status: GAME_STATE.ROLLING,
              timestamp: Date.now()
            });

            // Trigger bot to roll again after a short delay
            await new Promise(resolve => setTimeout(resolve, 1000));
            this.playBotTurn(roomId);
            return;
          }
        }

        // Calculate valid moves with the FIRST accumulated dice
        const assistingPlayerColor = this.getAssistingPlayer(room, currentColor);
        const targetColor = assistingPlayerColor || currentColor;

        // We use the accumulated dice logic for moving
        this.processNextAccumulatedDice(room, currentColor);

        // We don't need to manually calculate validMoves here anymore since processNextAccumulatedDice handles it
        // but we need to broadcast the result if processNextAccumulatedDice changed state
        if (room.gameState.status === GAME_STATE.MOVING && room.gameState.validMoves.length > 0) {
          this.broadcastDeltaUpdate(roomId, {
            type: 'dice_roll',
            playerColor: currentColor,
            diceValue: room.gameState.diceValue, // The dice currently being processed
            accumulatedDice: room.gameState.accumulatedDice,
            turnDiceValues: room.gameState.turnDiceValues,
            validMoves: room.gameState.validMoves,
            status: GAME_STATE.MOVING,
            timestamp: Date.now()
          });

          // Trigger the moving part of the bot's turn
          this.playBotTurn(roomId);
        } else if (room.gameState.status === GAME_STATE.ROLLING) {
           // If processNextAccumulatedDice moved turn to next player or gave bonus roll
           this.broadcastDeltaUpdate(roomId, {
            type: 'dice_roll',
            playerColor: currentColor,
            diceValue,
            accumulatedDice: room.gameState.accumulatedDice,
            turnDiceValues: room.gameState.turnDiceValues,
            validMoves: [],
            status: GAME_STATE.ROLLING,
            timestamp: Date.now()
          });
        }
      } 
      // 2. MOVING STATE
      else if (room.gameState.status === GAME_STATE.MOVING) {
        // Simulate thinking before moving
        await new Promise(resolve => setTimeout(resolve, getAIThinkingDelay(difficulty)));

        // Double check room state
        if (!this.rooms.has(roomId) || room.gameState.status !== GAME_STATE.MOVING || room.gameState.currentPlayer !== currentColor) return;

        const diceValue = room.gameState.diceValue;
        
        // Use AI logic to pick best move
        const tokenIndex = getAIMove(
          room.gameState.players[currentColor].tokens,
          diceValue,
          currentColor,
          room.gameState.players,
          difficulty,
          gameMode
        );

        if (tokenIndex !== null && room.gameState.validMoves.includes(tokenIndex)) {
          const moveResult = this.executeMove(room, currentColor, tokenIndex);

          this.broadcastDeltaUpdate(roomId, {
            type: 'token_move',
            playerColor: currentColor,
            tokenIndex,
            newPosition: moveResult.newPosition,
            newState: moveResult.newState,
            killed: moveResult.killed,
            bonusTurn: moveResult.bonusTurn,
            won: moveResult.won,
            currentPlayer: room.gameState.currentPlayer,
            status: room.gameState.status,
            timestamp: Date.now()
          });

          console.log(`🤖 [BOT MOVE] ${currentColor} moved token ${tokenIndex} to ${moveResult.newPosition}`);

          if (moveResult.won) {
            this.handlePlayerWin(room, moveResult.targetColor || currentColor);
          } else if (room.gameState.currentPlayer === currentColor) {
             // Bot got a bonus turn, play again
             this.playBotTurn(roomId);
          }
        } else {
          // Fallback if AI fails to pick a valid move
          this.skipTurn(room, currentColor, diceValue);
        }
      }
    } catch (error) {
      console.error('❌ [BOT ERROR]', error);
      // Failsafe: skip turn on error so game doesn't hang
      if (room && room.gameState && room.gameState.currentPlayer === currentColor) {
        this.skipTurn(room, currentColor, room.gameState.diceValue || 1);
      }
    }
  }

  /**
   * Handle dice roll (Server validates)
   */
  handleRollDice(socket, { roomId, playerId }) {
    try {
      const room = this.rooms.get(roomId);
      if (!room) return;

      const player = room.players[playerId];
      if (!player) return;

      // SECURITY: Validate authenticated socket
      if (socket.userId && socket.userId !== playerId) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} (User: ${socket.userId}) attempted to roll dice for player ${playerId}`);
        return;
      }

      // SECURITY: Validate that the socket making the request belongs to the player (fallback)
      const expectedSocketId = player.socketId;
      if (!socket.userId && expectedSocketId && socket.id !== expectedSocketId) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} attempted to roll dice for player ${playerId} but expected socket ${expectedSocketId}`);
        return;
      }

      // Validate: Is it this player's turn?
      if (player.color !== room.gameState.currentPlayer) {
        socket.emit('ludo:action_error', {
          error: 'Not your turn',
          currentPlayer: room.gameState.currentPlayer
        });
        return;
      }

      // Validate: Should be in ROLLING state
      if (room.gameState.status !== GAME_STATE.ROLLING) {
        socket.emit('ludo:action_error', { error: 'Cannot roll now' });
        return;
      }

      // Roll dice (server-side random for fairness)
      const diceValue = Math.floor(Math.random() * 6) + 1;
      room.gameState.diceValue = diceValue;
      room.gameState.lastDiceRoll = Date.now();

      if (!room.gameState.accumulatedDice) {
        room.gameState.accumulatedDice = [];
      }
      if (!room.gameState.turnDiceValues) {
        room.gameState.turnDiceValues = [];
      }
      room.gameState.accumulatedDice.push(diceValue);
      room.gameState.turnDiceValues.push(diceValue);

      // Store last dice value for this player
      if (!room.gameState.lastDiceValues) {
        room.gameState.lastDiceValues = {};
      }
      room.gameState.lastDiceValues[player.color] = diceValue;

      // Count consecutive sixes securely in backend
      const consecutiveSixesCount = room.gameState.accumulatedDice.filter(d => d === 6).length;

      if (diceValue === 6) {
        if (consecutiveSixesCount >= 3) {
          // 3 consecutive sixes: turn is cancelled
          console.log(`🚫 [RULE] ${player.color} rolled 3 consecutive sixes. Turn cancelled.`);
          room.gameState.accumulatedDice = [];
          room.gameState.validMoves = [];
          this.nextTurn(room);
        } else {
          // Allow another roll, keep status ROLLING
          room.gameState.status = GAME_STATE.ROLLING;
          room.gameState.validMoves = [];
        }
      } else {
        // Finished rolling, start moving phase with accumulated dice
        this.processNextAccumulatedDice(room, player.color);
      }

      // Broadcast delta update (only changed fields)
      this.broadcastDeltaUpdate(roomId, {
        type: 'dice_roll',
        playerColor: player.color,
        diceValue,
        accumulatedDice: room.gameState.accumulatedDice,
        turnDiceValues: room.gameState.turnDiceValues,
        validMoves: room.gameState.validMoves.length > 0 ? room.gameState.validMoves : [],
        status: room.gameState.status,
        timestamp: Date.now()
      });

      console.log(`🎲 [DICE] ${player.color} rolled ${diceValue}. Accumulated: ${room.gameState.accumulatedDice}. Valid moves: ${room.gameState.validMoves?.length}`);
    } catch (error) {
      console.error('❌ [DICE ERROR]', error);
      socket.emit('ludo:action_error', { error: error.message });
    }
  }

  /**
   * Handle undo roll (Secure backend deduction with bank-level security)
   */
  async handleUndoRoll(socket, { roomId, playerId }) {
    try {
      const room = this.rooms.get(roomId);
      if (!room) return;

      const player = room.players[playerId];
      if (!player) return;

      // SECURITY: Validate authenticated socket
      if (socket.userId && socket.userId !== playerId) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} (User: ${socket.userId}) attempted to undo roll for player ${playerId}`);
        socket.emit('ludo:security_violation', { 
          error: 'Authentication violation detected',
          action: 'undo_roll',
          severity: 'high'
        });
        return;
      }

      // SECURITY: Validate that the socket making the request belongs to the player (fallback)
      const expectedSocketId = player.socketId;
      if (!socket.userId && expectedSocketId && socket.id !== expectedSocketId) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} attempted to undo roll for player ${playerId} but expected socket ${expectedSocketId}`);
        socket.emit('ludo:security_violation', { 
          error: 'Socket validation failed',
          action: 'undo_roll',
          severity: 'high'
        });
        return;
      }

      // SECURITY: Block bot players from using undo (bots don't pay diamonds)
      if (player.isBot) {
        console.warn(`[Ludo] Security Alert: Attempted undo for BOT player ${playerId}`);
        socket.emit('ludo:action_error', { error: 'Bots cannot use undo feature' });
        return;
      }

      // Validate: Is it this player's turn?
      if (player.color !== room.gameState.currentPlayer) {
        socket.emit('ludo:action_error', { error: 'Not your turn' });
        return;
      }

      // Validate: Should be in MOVING state and have a dice value
      if (room.gameState.status !== GAME_STATE.MOVING || room.gameState.diceValue === null) {
        socket.emit('ludo:action_error', { error: 'Cannot undo roll right now' });
        return;
      }

      // SECURITY: Rate limiting - prevent spam/abuse of undo feature
      if (!room.undoRateLimiter) room.undoRateLimiter = {};
      const now = Date.now();
      const lastUndoTime = room.undoRateLimiter[playerId] || 0;
      const timeSinceLastUndo = now - lastUndoTime;
      
      // Minimum 2 seconds between undo attempts to prevent rapid fire exploitation
      if (timeSinceLastUndo < 2000) {
        console.warn(`[Ludo] Security Alert: Player ${playerId} attempting rapid undo (${timeSinceLastUndo}ms since last)`);
        socket.emit('ludo:action_error', { 
          error: 'Please wait before using undo again',
          remainingTime: Math.ceil((2000 - timeSinceLastUndo) / 1000)
        });
        return;
      }

      // SECURITY: Limit undos per turn to prevent infinite re-rolling
      if (!room.undoCountPerTurn) room.undoCountPerTurn = {};
      if (!room.undoCountPerTurn[player.color]) room.undoCountPerTurn[player.color] = 0;
      
      const maxUndosPerTurn = 3; // Maximum 3 undos per turn
      if (room.undoCountPerTurn[player.color] >= maxUndosPerTurn) {
        console.warn(`[Ludo] Security Alert: Player ${playerId} exceeded max undos per turn (${room.undoCountPerTurn[player.color]})`);
        socket.emit('ludo:action_error', { 
          error: `Maximum ${maxUndosPerTurn} undos per turn allowed`
        });
        return;
      }

      // SECURITY: Prevent race conditions by locking state during async transaction
      if (room.gameState.status === 'undoing') {
        socket.emit('ludo:action_error', { error: 'Undo already in progress' });
        return;
      }
      room.gameState.status = 'undoing';

      // Deduct diamonds using Firebase Admin
      if (!this.admin || !this.admin.apps.length) {
        room.gameState.status = GAME_STATE.MOVING;
        socket.emit('ludo:action_error', { error: 'Server configuration error' });
        return;
      }

      const db = this.admin.firestore();
      const userRef = db.collection('users').doc(playerId);
      
      try {
        await db.runTransaction(async (transaction) => {
          const userDoc = await transaction.get(userRef);
          if (!userDoc.exists) throw new Error('User not found');
          
          const userData = userDoc.data();
          const currentGems = userData.gems || 0;
          
          if (currentGems < 5) {
            throw new Error('Not enough diamonds');
          }
          
          transaction.update(userRef, {
            gems: currentGems - 5
          });
        });
      } catch (txError) {
        room.gameState.status = GAME_STATE.MOVING;
        throw txError;
      }

      // SECURITY: Store the old dice value that was undone for audit trail
      const oldDiceValue = room.gameState.diceValue;
      
      // Generate new dice roll
      const diceValue = Math.floor(Math.random() * 6) + 1;
      room.gameState.diceValue = diceValue;
      room.gameState.lastDiceRoll = Date.now();

      if (!room.gameState.lastDiceValues) {
        room.gameState.lastDiceValues = {};
      }
      room.gameState.lastDiceValues[player.color] = diceValue;

      // CRITICAL FIX: When undo is called, we must DISCARD the old dice value completely
      // The old value should NOT remain in the arrays - this prevents hacking/exploitation
      if (!room.gameState.accumulatedDice) room.gameState.accumulatedDice = [];
      if (!room.gameState.turnDiceValues) room.gameState.turnDiceValues = [];
      
      // SECURITY: Clear the current dice being processed and replace with new one
      // Remove the last added dice (which was the old one being undone)
      if (room.gameState.accumulatedDice.length > 0) {
        room.gameState.accumulatedDice.shift(); // Remove the old dice value
      }
      if (room.gameState.turnDiceValues.length > 0) {
        room.gameState.turnDiceValues.shift(); // Remove the old dice value from turn history
      }
      
      // Now add the new dice value
      room.gameState.accumulatedDice.unshift(diceValue);
      room.gameState.turnDiceValues.unshift(diceValue);
      
      // AUDIT LOG: Record undo action for security monitoring
      if (!room.undoAuditLog) room.undoAuditLog = [];
      room.undoAuditLog.push({
        playerId: playerId,
        playerColor: player.color,
        timestamp: Date.now(),
        oldDiceValue: oldDiceValue,
        newDiceValue: diceValue,
        remainingAccumulated: [...room.gameState.accumulatedDice]
      });
      
      // SECURITY: Limit audit log size to prevent memory issues
      if (room.undoAuditLog.length > 100) {
        room.undoAuditLog = room.undoAuditLog.slice(-50); // Keep last 50 entries
      }

      // SECURITY: Update rate limiter and turn counter
      room.undoRateLimiter[playerId] = Date.now();
      room.undoCountPerTurn[player.color]++;

      // Count consecutive sixes securely in backend
      const consecutiveSixesCount = room.gameState.accumulatedDice.filter(d => d === 6).length;

      if (diceValue === 6) {
        if (consecutiveSixesCount >= 3) {
          // 3 consecutive sixes: turn is cancelled
          console.log(`🚫 [RULE] ${player.color} rolled 3 consecutive sixes after undo. Turn cancelled.`);
          room.gameState.accumulatedDice = [];
          room.gameState.validMoves = [];
          this.nextTurn(room);
        } else {
          // Roll again
          room.gameState.status = GAME_STATE.ROLLING;
          room.gameState.validMoves = [];
        }
      } else {
        // Process next accumulated dice
        this.processNextAccumulatedDice(room, player.color);
      }

      // Broadcast delta update for the new roll
      this.broadcastDeltaUpdate(roomId, {
        type: 'dice_roll',
        playerColor: player.color,
        diceValue,
        accumulatedDice: room.gameState.accumulatedDice,
        turnDiceValues: room.gameState.turnDiceValues,
        validMoves: room.gameState.validMoves.length > 0 ? room.gameState.validMoves : [],
        status: room.gameState.status,
        timestamp: Date.now(),
        isUndo: true // Flag to notify frontend
      });
      
      socket.emit('ludo:undo_success', { diamondsDeducted: 5 });
      console.log(`⏪ [UNDO] ${player.color} paid 5 diamonds and re-rolled ${diceValue}. Accumulated: ${room.gameState.accumulatedDice}`);

    } catch (error) {
      console.error('❌ [UNDO ERROR]', error);
      socket.emit('ludo:action_error', { error: error.message });
    }
  }

  /**
   * Handle token move (Server validates and resolves)
   */
  handleMoveToken(socket, { roomId, playerId, tokenIndex }) {
    try {
      const room = this.rooms.get(roomId);
      if (!room) return;

      const player = room.players[playerId];
      if (!player) return;

      // SECURITY: Validate authenticated socket
      if (socket.userId && socket.userId !== playerId) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} (User: ${socket.userId}) attempted to move token for player ${playerId}`);
        return;
      }

      // SECURITY: Validate that the socket making the request belongs to the player (fallback)
      const expectedSocketId = player.socketId;
      if (!socket.userId && expectedSocketId && socket.id !== expectedSocketId) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} attempted to move token for player ${playerId} but expected socket ${expectedSocketId}`);
        return;
      }

      // SECURITY: Block clients from moving for bots
      if (player.isBot) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} attempted to move token for BOT player ${playerId}`);
        return;
      }

      // Validate: Is it this player's turn?
      if (player.color !== room.gameState.currentPlayer) {
        socket.emit('ludo:action_error', { error: 'Not your turn' });
        return;
      }

      // Validate: Should be in MOVING state
      if (room.gameState.status !== GAME_STATE.MOVING) {
        socket.emit('ludo:action_error', { error: 'Not in moving state' });
        return;
      }

      // Validate: Is this token in valid moves?
      if (!room.gameState.validMoves.includes(tokenIndex)) {
        socket.emit('ludo:action_error', { error: 'Invalid token selection' });
        return;
      }

      // Execute move (server-side calculation)
      const moveResult = this.executeMove(room, player.color, tokenIndex);

      // Broadcast delta update
      this.broadcastDeltaUpdate(roomId, {
        type: 'token_move',
        playerColor: player.color,
        tokenIndex,
        newPosition: moveResult.newPosition,
        newState: moveResult.newState,
        killed: moveResult.killed,
        bonusTurn: moveResult.bonusTurn,
        won: moveResult.won,
        currentPlayer: room.gameState.currentPlayer,
        status: room.gameState.status,
        timestamp: Date.now()
      });

      console.log(`🎯 [MOVE] ${player.color} moved token ${tokenIndex} to ${moveResult.newPosition}`);

      // Check for game over
      if (moveResult.won) {
        this.handlePlayerWin(room, moveResult.targetColor || player.color);
      }
    } catch (error) {
      console.error('❌ [MOVE ERROR]', error);
      socket.emit('ludo:action_error', { error: error.message });
    }
  }

  /**
   * Handle manual turn skip
   */
  handleSkipTurn(socket, { roomId, playerId }) {
    try {
      const room = this.rooms.get(roomId);
      if (!room) return;

      const player = room.players[playerId];
      if (!player || player.color !== room.gameState.currentPlayer) return;

      // SECURITY: Validate authenticated socket
      if (socket.userId && socket.userId !== playerId) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} (User: ${socket.userId}) attempted to skip turn for player ${playerId}`);
        return;
      }

      // SECURITY: Validate that the socket making the request belongs to the player (fallback)
      const expectedSocketId = player.socketId;
      if (!socket.userId && expectedSocketId && socket.id !== expectedSocketId) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} attempted to skip turn for player ${playerId} but expected socket ${expectedSocketId}`);
        return;
      }

      // SECURITY: Block clients from skipping turns for bots
      if (player.isBot) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} attempted to skip turn for BOT player ${playerId}`);
        return;
      }

      this.skipTurn(room, player.color, room.gameState.diceValue);

      this.broadcastDeltaUpdate(roomId, {
        type: 'turn_skip',
        playerColor: player.color,
        currentPlayer: room.gameState.currentPlayer,
        status: room.gameState.status,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('❌ [SKIP ERROR]', error);
    }
  }

  /**
   * Handle full state sync request
   */
  handleRequestSync(socket, { roomId, playerId }) {
    try {
      const room = this.rooms.get(roomId);
      if (!room) return;

      socket.emit('ludo:full_sync', {
        gameState: this.getGameState(room),
        roomState: this.getRoomState(room),
        timestamp: Date.now()
      });

      console.log(`🔄 [SYNC] Sent full state to ${playerId}`);
    } catch (error) {
      console.error('❌ [SYNC ERROR]', error);
    }
  }

  /**
   * Handle heartbeat for connection monitoring
   */
  handleHeartbeat(socket, { roomId, playerId }) {
    const room = this.rooms.get(roomId);
    if (!room || !room.players[playerId]) return;

    room.players[playerId].lastHeartbeat = Date.now();
  }

  /**
   * Handle disconnection
   */
  handleDisconnect(socket) {
    try {
      console.log(`❌ Player disconnected: ${socket.id}`);

      const connection = this.playerConnections.get(socket.id);
      if (!connection) return;

      const { roomId, playerId } = connection;
      const room = this.rooms.get(roomId);
      if (!room) return;

      // Mark player as disconnected
      if (room.players[playerId]) {
        room.players[playerId].connected = false;
      }

      // Notify other players
      this.io.to(roomId).emit('ludo:player_disconnected', {
        playerId,
        playerColor: room.players[playerId]?.color
      });

      // Auto-remove after 30 seconds if not reconnected
      setTimeout(() => {
        const stillDisconnected = room.players[playerId] && !room.players[playerId].connected;
        if (stillDisconnected) {
          this.handleLeaveGame(socket, { roomId, playerId });
        }
      }, 30000);
    } catch (error) {
      console.error('❌ [DISCONNECT ERROR]', error);
    }
  }

  /**
   * Create a new room
   */
  createRoom(roomId) {
    return {
      id: roomId,
      players: {},
      maxPlayers: 4,
      gameState: {
        status: GAME_STATE.WAITING,
        currentPlayer: null,
        turnOrder: [],
        diceValue: null,
        lastDiceValues: {},
        validMoves: [],
        players: {},
        winner: null,
        startTime: null
      },
      createdAt: Date.now()
    };
  }

  /**
   * Determine if the given player is assisting a teammate
   * Returns the color of the teammate if assisting, otherwise null
   */
  getAssistingPlayer(room, playerColor) {
    const isTeamMode = room.isTeamMode || room.isTeam || room.gameState.isTeamMode;
    if (!isTeamMode) return null;

    // Has this player won?
    const hasWon = room.gameState.winners && room.gameState.winners.includes(playerColor);
    if (!hasWon) return null;

    // Find teammate color based on teams
    const teamA = ['RED', 'YELLOW'];
    const teamB = ['BLUE', 'GREEN'];
    
    let teammateColor = null;
    if (teamA.includes(playerColor)) {
      teammateColor = teamA.find(c => c !== playerColor);
    } else if (teamB.includes(playerColor)) {
      teammateColor = teamB.find(c => c !== playerColor);
    }

    if (!teammateColor) return null;
    
    // Check if teammate is actually in the game
    if (!room.players || !Object.values(room.players).some(p => p.color === teammateColor && !p.hasLeft)) {
      return null;
    }

    // Has teammate won?
    const teammateWon = room.gameState.winners && room.gameState.winners.includes(teammateColor);
    if (teammateWon) return null;

    return teammateColor;
  }

  /**
   * Assign player color based on available colors

   * For TeamUp mode: Prioritize keeping real players in same team
   */
  assignPlayerColor(room) {
    const colors = ['RED', 'GREEN', 'YELLOW', 'BLUE'];
    const usedColors = Object.values(room.players).map(p => p.color).filter(Boolean);
    const availableColors = colors.filter(c => !usedColors.includes(c));
    
    if (availableColors.length === 0) {
      return null; // No colors available
    }
    
    // For non-team mode, assign sequentially
    if (!room.isTeam) {
      return availableColors[0];
    }
    
    // TeamUp mode: Smart color assignment
    // Team A: RED + YELLOW, Team B: BLUE + GREEN
    const teamAColors = ['RED', 'YELLOW'];
    const teamBColors = ['BLUE', 'GREEN'];
    
    const existingPlayers = Object.values(room.players);
    const realPlayers = existingPlayers.filter(p => !p.isBot);
    
    // If this is the first player, assign RED (Team A)
    if (realPlayers.length === 0) {
      return availableColors.includes('RED') ? 'RED' : availableColors[0];
    }
    
    // If this is the second real player, put them in same team as first
    if (realPlayers.length === 1) {
      const firstPlayerColor = realPlayers[0].color;
      
      if (teamAColors.includes(firstPlayerColor)) {
        // First player in Team A, assign other Team A color
        const teammateColor = teamAColors.find(c => c !== firstPlayerColor && availableColors.includes(c));
        if (teammateColor) {
          console.log(`👥 [TEAM ASSIGNMENT] Assigning ${teammateColor} to keep real players in Team A`);
          return teammateColor;
        }
      } else if (teamBColors.includes(firstPlayerColor)) {
        // First player in Team B, assign other Team B color
        const teammateColor = teamBColors.find(c => c !== firstPlayerColor && availableColors.includes(c));
        if (teammateColor) {
          console.log(`👥 [TEAM ASSIGNMENT] Assigning ${teammateColor} to keep real players in Team B`);
          return teammateColor;
        }
      }
    }
    
    // For 3rd and 4th players (or if teammate color not available), assign any available
    return availableColors[0];
  }

  /**
   * Process the next accumulated dice for moving
   */
  processNextAccumulatedDice(room, playerColor) {
    if (!room.gameState.accumulatedDice || room.gameState.accumulatedDice.length === 0) {
      // No more dice. Check if they earned a bonus turn during moving phase
      if (room.gameState.earnedBonusTurn) {
        room.gameState.earnedBonusTurn = false;
        room.gameState.status = GAME_STATE.ROLLING;
        this.playBotTurn(room.id);
      } else {
        this.nextTurn(room);
      }
      return;
    }

    const currentDice = room.gameState.accumulatedDice.shift();
    room.gameState.diceValue = currentDice;
    room.gameState.status = GAME_STATE.MOVING;

    const assistingPlayerColor = this.getAssistingPlayer(room, playerColor);
    const targetColor = assistingPlayerColor || playerColor;

    const validMoves = this.calculateValidMoves(
      room,
      room.gameState.players[targetColor].tokens,
      currentDice,
      targetColor
    );

    room.gameState.validMoves = validMoves;

    if (validMoves.length === 0) {
      // Skip this dice, process next
      this.processNextAccumulatedDice(room, playerColor);
    } else {
      // We found valid moves, wait for player interaction
      // The state will be broadcasted by the caller or when the turn continues
      if (room.gameState.players[playerColor].isBot) {
        this.playBotTurn(room.id);
      }
    }
  }

  /**
   * Calculate valid moves for current player
   */
  calculateValidMoves(room, tokens, diceValue, playerColor) {
    const validMoves = [];
    const player = room.gameState.players[playerColor];
    const hasKilled = player.hasKilled || false;
    const gameMode = room.gameMode || 'classic';

    tokens.forEach((token, index) => {
      if (token.state === TOKEN_STATE.FINISHED) return;

      // Token at home needs 6 to come out
      if (token.position === -1) {
        if (diceValue === 6) {
          validMoves.push(index);
        }
        return;
      }

      // Token on board (position here tracks steps from start 0-56)
      const newPosition = token.position + diceValue;
      
      // --- QUICK ARROW MODE LOGIC (BACKEND SECURED) ---
      // In quick_arrow mode, a player CANNOT enter the home stretch (step 51+)
      // unless they have killed at least one opponent's token.
      if (gameMode === 'quick_arrow' && !hasKilled && newPosition >= 51) {
        // Token is forced to loop around the board instead of entering home stretch.
        // It's technically a valid move to keep moving around, but we must calculate 
        // the looped steps. For simplicity, we just allow the move and handle the loop 
        // in executeMove, but here we validate that the move itself is possible.
        validMoves.push(index);
        return;
      }
      
      // Must roll exactly the number needed to finish (56 steps total)
      if (newPosition <= 56) {
        validMoves.push(index);
      }
    });

    return validMoves;
  }

  /**
   * Execute token move (server-side calculation)
   */
  executeMove(room, playerColor, tokenIndex) {
    const assistingPlayerColor = this.getAssistingPlayer(room, playerColor);
    const targetColor = assistingPlayerColor || playerColor;

    const player = room.gameState.players[targetColor];
    const token = player.tokens[tokenIndex];
    const diceValue = room.gameState.diceValue;
    const gameMode = room.gameMode || 'classic';

    let newPosition;
    let newState = token.state;
    let tokenFinished = false;

    // Moving from home
    if (token.position === -1) {
      newPosition = 0; // Start position
      newState = TOKEN_STATE.ACTIVE;
    } else {
      newPosition = token.position + diceValue;

      // Quick Arrow Mode constraint logic
      if (gameMode === 'quick_arrow' && !player.hasKilled && newPosition >= 51) {
        // Force the token to loop back to the start of the board
        // newPosition tracks steps from start (0-56).
        // 52 is the total steps around the board before home stretch.
        // We loop it around keeping the same step format but effectively pushing it back
        newPosition = newPosition % 52;
      }

      // Check if finished (exactly 56 steps)
      if (newPosition === 56) {
        newState = TOKEN_STATE.FINISHED;
        player.finishedCount++;
        tokenFinished = true;
      }
    }

    // Check for kills
    let killed = null;
    let arrowJumpOccurred = false;

    // --- ARROW MODE JUMP LOGIC ---
    if (newState === TOKEN_STATE.ACTIVE) {
      const isArrowMode = gameMode === 'arrow' || gameMode === 'quick_arrow';
      const tailPositions = [4, 17, 30, 43];
      
      if (isArrowMode && tailPositions.includes(newPosition)) {
        console.log(`⚡ [ARROW JUMP SERVER] Token landed on arrow tail ${newPosition}! Jumping to next box...`);
        newPosition += 1;
        arrowJumpOccurred = true;
      }
      
      killed = this.checkForKill(room, targetColor, newPosition);
      if (killed !== null) {
        player.hasKilled = true;
      }
    }

    // Update token
    token.position = newPosition;
    token.state = newState;

    // Check for win securely based on game mode
    let won = false;
    if (gameMode === 'quick_arrow') {
      // In Quick Arrow, they just need 1 token finished (hasKilled is enforced before entering home stretch)
      won = player.finishedCount >= 1;
    } else {
      // Classic and Arrow mode require all 4 tokens to finish
      won = player.finishedCount === 4;
    }

    // Determine next turn
    let earnedBonusTurn = false;
    if (killed !== null || tokenFinished || arrowJumpOccurred) {
      room.gameState.earnedBonusTurn = true;
      earnedBonusTurn = true;
    }

    // Instead of directly calling nextTurn, process next accumulated dice
    if (!won) {
      this.processNextAccumulatedDice(room, room.gameState.currentPlayer);
    }

    return {
      newPosition,
      newState,
      killed,
      bonusTurn: earnedBonusTurn, // 6 is handled via accumulated dice, bonus turn here means kill/finish
      won,
      targetColor
    };
  }

  /**
   * Check if move kills opponent token
   */
  checkForKill(room, attackerColor, position) {
    // Safe zones (starting positions)
    const safePositions = [0, 8, 13, 21, 26, 34, 39, 47];
    if (safePositions.includes(position)) return null;

    // Check all opponent tokens
    for (const [color, player] of Object.entries(room.gameState.players)) {
      if (color === attackerColor) continue;

      for (let i = 0; i < player.tokens.length; i++) {
        const token = player.tokens[i];
        if (token.position === position && token.state === TOKEN_STATE.ACTIVE) {
          // Kill this token
          token.position = -1;
          token.state = TOKEN_STATE.HOME;
          return { color, tokenIndex: i };
        }
      }
    }

    return null;
  }

  /**
   * Skip turn and move to next player
   */
  skipTurn(room, currentColor, diceValue) {
    room.gameState.accumulatedDice = []; // Clear accumulated dice
    room.gameState.turnDiceValues = []; // Clear turn dice values
    // Don't skip if rolled 6
    if (diceValue !== 6) {
      this.nextTurn(room);
    } else {
      room.gameState.status = GAME_STATE.ROLLING;
      this.playBotTurn(room.id); // Trigger in case the bot rolled 6 but couldn't move
    }
  }

  /**
   * Move to next player
   */
  nextTurn(room) {
    let currentIndex = room.gameState.turnOrder.indexOf(room.gameState.currentPlayer);
    let nextIndex = (currentIndex + 1) % room.gameState.turnOrder.length;
    let nextPlayer = room.gameState.turnOrder[nextIndex];

    // Skip players who have already won (unless they can assist a teammate in TeamUp mode)
    let loopCount = 0;
    while (room.gameState.winners && room.gameState.winners.includes(nextPlayer) && loopCount < room.gameState.turnOrder.length) {
        // If this player can assist a teammate, don't skip them
        if (this.getAssistingPlayer(room, nextPlayer)) {
            break;
        }
        
        nextIndex = (nextIndex + 1) % room.gameState.turnOrder.length;
        nextPlayer = room.gameState.turnOrder[nextIndex];
        loopCount++;
    }

    // SECURITY: Reset undo counter for the previous player's turn
    const previousPlayer = room.gameState.currentPlayer;
    if (room.undoCountPerTurn && previousPlayer) {
      room.undoCountPerTurn[previousPlayer] = 0;
    }

    room.gameState.currentPlayer = nextPlayer;
    room.gameState.status = GAME_STATE.ROLLING;
    room.gameState.diceValue = null;
    room.gameState.validMoves = [];
    
    // Check and trigger bot turn
    this.playBotTurn(room.id);
  }

  /**
   * Handle a player finishing all tokens
   */
  handlePlayerWin(room, playerColor) {
    const gameMode = room.gameMode || room.mode || 'classic';
    const totalPlayers = room.maxPlayers || Object.keys(room.players).length || room.gameState.turnOrder.length;
    
    if (!room.gameState.winners) {
      room.gameState.winners = [];
    }
    
    if (!room.gameState.winners.includes(playerColor)) {
      room.gameState.winners.push(playerColor);
      
      // --- IMMEDIATE REWARD PROCESSING FOR WINNER (Fire and Forget to avoid blocking state) ---
      const betAmount = room.betAmount || 100;
      const position = room.gameState.winners.length;
      const playerInfo = Object.values(room.players).find(p => p.color === playerColor);
      
      if (playerInfo && !playerInfo.isBot && playerInfo.id && !room.isTeamMode) {
        RewardServiceServer.awardGameWin(playerInfo.id, 'LUDO', betAmount, position, totalPlayers)
          .then(result => {
            if (result.success) {
              this.io.to(room.id).emit(`reward:awarded:${playerInfo.id}`, result);
              this.io.to(playerInfo.socketId).emit('ludo:reward_received', {
                position,
                reward: result.coins !== undefined ? result.coins : 0,
                coins: result.coins !== undefined ? result.coins : 0
              });
            }
          })
          .catch(error => console.error('Error processing immediate reward in Ludo:', error));
      }
      // ----------------------------------------------
    }
    
    // Check if game is completely over securely in backend
    let isGameOver = false;
    
    if (room.isTeamMode) {
      // In TeamUp mode, game is over when BOTH players of a team finish
      const teamA = ['RED', 'YELLOW'];
      const teamB = ['GREEN', 'BLUE'];
      
      // Check if all active players in Team A have won
      const teamAActive = teamA.filter(c => room.players[c]);
      const teamAWon = teamAActive.length > 0 && teamAActive.every(c => room.gameState.winners.includes(c));
      
      // Check if all active players in Team B have won
      const teamBActive = teamB.filter(c => room.players[c]);
      const teamBWon = teamBActive.length > 0 && teamBActive.every(c => room.gameState.winners.includes(c));
      
      if (teamAWon || teamBWon) {
        isGameOver = true;
      }
    } else {
      // Normal mode: It's over if only 1 player is left to finish
      if (totalPlayers <= 2 || room.gameState.winners.length >= totalPlayers - 1) {
        isGameOver = true;
      }
    }

    if (isGameOver) {
      this.handleGameOver(room, room.gameState.winners);
    } else {
      // Game continues for remaining players
      this.io.to(room.id).emit('ludo:player_won', {
        color: playerColor,
        position: room.gameState.winners.length,
        timestamp: Date.now()
      });
      console.log(`🏆 [PLAYER WON] ${playerColor} got position ${room.gameState.winners.length} in room ${room.id}. Game continues for ${totalPlayers - room.gameState.winners.length} players.`);
      
      // Update room state to client so profile ranks update immediately
      this.broadcastRoomUpdate(room.id);
      
      // Pass turn to next player unless they can assist a teammate
      const assistingPlayer = this.getAssistingPlayer(room, playerColor);
      if (assistingPlayer) {
          console.log(`🤝 [TEAM ASSIST] ${playerColor} will now assist ${assistingPlayer}`);
          room.gameState.status = GAME_STATE.ROLLING;
          room.gameState.diceValue = null;
          room.gameState.validMoves = [];
          
          // Need to broadcast that it's their turn to roll again
          this.broadcastDeltaUpdate(room.id, {
              type: 'turn_skip', // using turn_skip or similar to trigger state update
              playerColor: playerColor,
              currentPlayer: playerColor,
              status: GAME_STATE.ROLLING,
              timestamp: Date.now()
          });
          
          this.playBotTurn(room.id);
      } else {
          this.nextTurn(room);
      }
    }
  }

  /**
   * Handle game over
   */
  async handleGameOver(room, winnerColor) {
    room.gameState.status = GAME_STATE.FINISHED;
    const isArray = Array.isArray(winnerColor);
    const firstWinner = isArray ? winnerColor[0] : winnerColor;
    const allWinners = isArray ? winnerColor : [winnerColor];

    room.gameState.winner = firstWinner;
    room.gameState.winners = allWinners;

    this.io.to(room.id).emit('ludo:game_over', {
      winner: firstWinner,
      winners: allWinners,
      finalState: this.getGameState(room),
      timestamp: Date.now()
    });

    console.log(`🏆 [GAME OVER] Winners: ${allWinners.join(', ')} in room ${room.id}`);

    // Process rewards for losers (and team mode winners)
    try {
      const betAmount = room.betAmount || 100;
      const totalPlayers = room.gameState.turnOrder.length;

      for (const [playerId, player] of Object.entries(room.players)) {
        if (!player || player.isBot || !player.id) continue;
        
        let position = allWinners.indexOf(player.color) + 1; // 1-based index
        const isWinner = position > 0;
        
        if (room.isTeamMode) {
          const winningTeam = room.gameState.players[firstWinner]?.team;
          if (player.team === winningTeam) {
            const result = await RewardServiceServer.awardGameWin(player.id, 'LUDO', betAmount, 1, 2);
            if (result.success) {
              this.io.to(room.id).emit(`reward:awarded:${player.id}`, result);
            }
          } else {
            await RewardServiceServer.awardGameLoss(player.id, 'LUDO', betAmount);
          }
        } else {
          // Normal mode (Classic, Arrow, Quick Arrow)
          if (!isWinner) {
            // It's a loss - process deduction
            await RewardServiceServer.awardGameLoss(player.id, 'LUDO', betAmount);
          }
          // Winners already received their rewards immediately in handlePlayerWin
        }
      }
    } catch (error) {
      console.error('Error processing rewards in Ludo:', error);
    }

      // Clear the room after a grace period so bots stop playing
      setTimeout(() => {
        if (this.rooms.has(room.id)) {
          this.rooms.delete(room.id);
          console.log(`🗑️ [CLEANUP] Room ${room.id} deleted after game over`);
        }
      }, 30000);
  }

  /**
   * Broadcast room update to all players
   */
  broadcastRoomUpdate(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    this.io.to(roomId).emit('ludo:room_update', {
      players: this.getPlayersInfo(room),
      timestamp: Date.now()
    });
  }

  /**
   * Broadcast delta update (only changed data)
   */
  broadcastDeltaUpdate(roomId, delta) {
    this.io.to(roomId).emit('ludo:delta_update', delta);
    console.log(`📡 [DELTA] Broadcasting to room ${roomId}:`, delta.type);
  }

  /**
   * Get game state for sync
   */
  getGameState(room) {
    return {
      status: room.gameState.status,
      currentPlayer: room.gameState.currentPlayer,
      turnOrder: room.gameState.turnOrder,
      diceValue: room.gameState.diceValue,
      accumulatedDice: room.gameState.accumulatedDice || [],
      turnDiceValues: room.gameState.turnDiceValues || [],
      lastDiceValues: room.gameState.lastDiceValues,
      validMoves: room.gameState.validMoves,
      players: room.gameState.players,
      winner: room.gameState.winner,
      winners: room.gameState.winners || []
    };
  }

  /**
   * Get room state for sync
   */
  getRoomState(room) {
    return {
      id: room.id,
      players: this.getPlayersInfo(room),
      maxPlayers: room.maxPlayers,
      status: room.gameState.status
    };
  }

  /**
   * Get players info (without sensitive data)
   */
  getPlayersInfo(room) {
    const playersInfo = {};
    for (const [id, player] of Object.entries(room.players)) {
      // Determine player's rank/position if they have won
      let rank = null;
      if (room.gameState.winners && room.gameState.winners.includes(player.color)) {
        rank = room.gameState.winners.indexOf(player.color) + 1; // 1st, 2nd, 3rd
      } else if (room.gameState.status === GAME_STATE.FINISHED && room.gameState.winners) {
        // If game is finished and they are not in winners, they are the last
        rank = room.gameState.turnOrder.length; 
      }

      playersInfo[id] = {
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        color: player.color,
        selectedToken: player.selectedToken || 'classic',
        selectedDice: player.selectedDice || 'classic',
        ready: player.ready,
        connected: player.connected,
        rank: rank
      };
    }
    return playersInfo;
  }

  /**
   * Monitor stale connections
   */
  startConnectionMonitoring() {
    setInterval(() => {
      const now = Date.now();
      for (const [roomId, room] of this.rooms.entries()) {
        for (const [playerId, player] of Object.entries(room.players)) {
          if (now - player.lastHeartbeat > 60000) {
            console.log(`⚠️ [STALE] Player ${playerId} inactive, disconnecting...`);
            player.connected = false;
            this.io.to(roomId).emit('ludo:player_disconnected', {
              playerId,
              playerColor: player.color
            });
          }
        }
      }
    }, 30000); // Check every 30 seconds
  }
}

module.exports = LudoGameServer;
