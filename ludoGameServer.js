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
  handleJoinGame(socket, { roomId, playerId, playerData }) {
    try {
      console.log(`🎮 [JOIN] Player ${playerId} joining room ${roomId}`);

      // Get or create room
      let room = this.rooms.get(roomId);
      if (!room) {
        room = this.createRoom(roomId);
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
      const room = this.rooms.get(roomId);
      if (!room || !room.players[playerId]) return;

      room.players[playerId].ready = ready;

      // Broadcast update
      this.broadcastRoomUpdate(roomId);

      // Check if all players are ready
      const allReady = Object.values(room.players).every(p => p.ready);
      if (allReady && Object.keys(room.players).length >= 2) {
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

      const room = this.rooms.get(roomId);
      if (!room) return;

      // Verify all players ready
      const allReady = Object.values(room.players).every(p => p.ready);
      if (!allReady) {
        socket.emit('ludo:start_error', { error: 'Not all players are ready' });
        return;
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

        if (!room.gameState.lastDiceValues) {
          room.gameState.lastDiceValues = {};
        }
        room.gameState.lastDiceValues[currentColor] = diceValue;

        // Calculate valid moves
        const validMoves = this.calculateValidMoves(
          room,
          room.gameState.players[currentColor].tokens,
          diceValue,
          currentColor
        );

        if (validMoves.length > 0) {
          room.gameState.status = GAME_STATE.MOVING;
          room.gameState.validMoves = validMoves;
          
          this.broadcastDeltaUpdate(roomId, {
            type: 'dice_roll',
            playerColor: currentColor,
            diceValue,
            validMoves,
            status: GAME_STATE.MOVING,
            timestamp: Date.now()
          });

          // Trigger the moving part of the bot's turn
          this.playBotTurn(roomId);
        } else {
          // No valid moves, skip turn
          this.broadcastDeltaUpdate(roomId, {
            type: 'dice_roll',
            playerColor: currentColor,
            diceValue,
            validMoves: [],
            status: GAME_STATE.ROLLING,
            timestamp: Date.now()
          });

          await new Promise(resolve => setTimeout(resolve, 1000)); // Show dice result briefly
          this.skipTurn(room, currentColor, diceValue);
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
            this.handlePlayerWin(room, currentColor);
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

      // SECURITY: Validate that the socket making the request belongs to the player
      const expectedSocketId = player.socketId;
      if (expectedSocketId && socket.id !== expectedSocketId) {
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

      // Store last dice value for this player
      if (!room.gameState.lastDiceValues) {
        room.gameState.lastDiceValues = {};
      }
      room.gameState.lastDiceValues[player.color] = diceValue;

      // Calculate valid moves passing room context for quick arrow mode
      const validMoves = this.calculateValidMoves(
        room,
        room.gameState.players[player.color].tokens,
        diceValue,
        player.color
      );

      if (validMoves.length > 0) {
        room.gameState.status = GAME_STATE.MOVING;
        room.gameState.validMoves = validMoves;
      } else {
        // No valid moves, auto-skip turn
        this.skipTurn(room, player.color, diceValue);
      }

      // Broadcast delta update (only changed fields)
      this.broadcastDeltaUpdate(roomId, {
        type: 'dice_roll',
        playerColor: player.color,
        diceValue,
        validMoves: validMoves.length > 0 ? validMoves : [],
        status: room.gameState.status,
        timestamp: Date.now()
      });

      console.log(`🎲 [DICE] ${player.color} rolled ${diceValue}. Valid moves: ${validMoves.length}`);
    } catch (error) {
      console.error('❌ [DICE ERROR]', error);
      socket.emit('ludo:action_error', { error: error.message });
    }
  }

  /**
   * Handle undo roll (Secure backend deduction)
   */
  async handleUndoRoll(socket, { roomId, playerId }) {
    try {
      const room = this.rooms.get(roomId);
      if (!room) return;

      const player = room.players[playerId];
      if (!player) return;

      // SECURITY: Validate that the socket making the request belongs to the player
      const expectedSocketId = player.socketId;
      if (expectedSocketId && socket.id !== expectedSocketId) {
        console.warn(`[Ludo] Security Alert: Socket ${socket.id} attempted to undo roll for player ${playerId} but expected socket ${expectedSocketId}`);
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

      // Deduct diamonds using Firebase Admin
      if (!this.admin || !this.admin.apps.length) {
        socket.emit('ludo:action_error', { error: 'Server configuration error' });
        return;
      }

      const db = this.admin.firestore();
      const userRef = db.collection('users').doc(playerId);
      
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

      // Generate new dice roll
      const diceValue = Math.floor(Math.random() * 6) + 1;
      room.gameState.diceValue = diceValue;
      room.gameState.lastDiceRoll = Date.now();

      if (!room.gameState.lastDiceValues) {
        room.gameState.lastDiceValues = {};
      }
      room.gameState.lastDiceValues[player.color] = diceValue;

      // Calculate valid moves passing room context for quick arrow mode
      const validMoves = this.calculateValidMoves(
        room,
        room.gameState.players[player.color].tokens,
        diceValue,
        player.color
      );

      if (validMoves.length > 0) {
        room.gameState.status = GAME_STATE.MOVING;
        room.gameState.validMoves = validMoves;
      } else {
        // No valid moves, auto-skip turn
        this.skipTurn(room, player.color, diceValue);
      }

      // Broadcast delta update for the new roll
      this.broadcastDeltaUpdate(roomId, {
        type: 'dice_roll',
        playerColor: player.color,
        diceValue,
        validMoves: validMoves.length > 0 ? validMoves : [],
        status: room.gameState.status,
        timestamp: Date.now(),
        isUndo: true // Flag to notify frontend
      });
      
      socket.emit('ludo:undo_success', { diamondsDeducted: 5 });
      console.log(`⏪ [UNDO] ${player.color} paid 5 diamonds and re-rolled ${diceValue}.`);

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

      // SECURITY: Validate that the socket making the request belongs to the player
      const expectedSocketId = player.socketId;
      if (expectedSocketId && socket.id !== expectedSocketId) {
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
        this.handlePlayerWin(room, player.color);
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

      // SECURITY: Validate that the socket making the request belongs to the player
      const expectedSocketId = player.socketId;
      if (expectedSocketId && socket.id !== expectedSocketId) {
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
    const player = room.gameState.players[playerColor];
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

    // Update token
    token.position = newPosition;
    token.state = newState;

    // Check for kills
    let killed = null;
    if (newState === TOKEN_STATE.ACTIVE) {
      killed = this.checkForKill(room, playerColor, newPosition);
      if (killed !== null) {
        player.hasKilled = true;
      }
    }

    // Check for win
    const won = player.finishedCount === 4;

    // Determine next turn
    const bonusTurn = diceValue === 6 || killed !== null || tokenFinished;

    if (!bonusTurn && !won) {
      this.nextTurn(room);
    } else {
      room.gameState.status = GAME_STATE.ROLLING;
    }

    return {
      newPosition,
      newState,
      killed,
      bonusTurn,
      won
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

    // Skip players who have already won
    let loopCount = 0;
    while (room.gameState.winners && room.gameState.winners.includes(nextPlayer) && loopCount < room.gameState.turnOrder.length) {
        nextIndex = (nextIndex + 1) % room.gameState.turnOrder.length;
        nextPlayer = room.gameState.turnOrder[nextIndex];
        loopCount++;
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
  async handlePlayerWin(room, playerColor) {
    const gameMode = room.gameMode || room.mode || 'classic';
    const totalPlayers = room.maxPlayers || Object.keys(room.players).length || room.gameState.turnOrder.length;
    
    if (!room.gameState.winners) {
      room.gameState.winners = [];
    }
    
    if (!room.gameState.winners.includes(playerColor)) {
      room.gameState.winners.push(playerColor);
      
      // --- IMMEDIATE REWARD PROCESSING FOR WINNER ---
      try {
        const betAmount = room.betAmount || 100;
        const position = room.gameState.winners.length;
        const playerInfo = Object.values(room.players).find(p => p.color === playerColor);
        
        if (playerInfo && !playerInfo.isBot && playerInfo.id) {
          if (room.isTeamMode) {
            // Team mode rewards can be handled at game over when team result is final
          } else {
            // Normal mode (Classic, Arrow, Quick Arrow)
            const result = await RewardServiceServer.awardGameWin(playerInfo.id, 'LUDO', betAmount, position, totalPlayers);
            if (result.success) {
              this.io.to(room.id).emit(`reward:awarded:${playerInfo.id}`, result);
              // Also notify the player directly with their reward details so UI can update
              this.io.to(playerInfo.socketId).emit('ludo:reward_received', {
                position,
                reward: result.rewardAmount || (betAmount * (position === 1 ? 2 : position === 2 ? 1.5 : 1)),
                coins: result.coins
              });
            }
          }
        }
      } catch (error) {
        console.error('Error processing immediate reward in Ludo:', error);
      }
      // ----------------------------------------------
    }
    
    // Check if game is completely over
    // It's over if:
    // - Only 2 players started the game
    // - Total winners >= totalPlayers - 1 (e.g. 3 winners in a 4 player game)
    if (totalPlayers <= 2 || room.gameState.winners.length >= totalPlayers - 1) {
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
      
      // Pass turn to next player
      this.nextTurn(room);
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
