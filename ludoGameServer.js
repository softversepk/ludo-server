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

class LudoGameServer {
  constructor(io) {
    this.io = io;
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
        delete room.players[playerId];
        delete room.gameState.players[playerColor];
      }

      socket.leave(roomId);
      this.playerConnections.delete(socket.id);

      // If room is empty, delete it
      if (Object.keys(room.players).length === 0) {
        this.rooms.delete(roomId);
        console.log(`🗑️ [CLEANUP] Room ${roomId} deleted`);
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
    } catch (error) {
      console.error('❌ [START ERROR]', error);
      socket.emit('ludo:start_error', { error: error.message });
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

      // Calculate valid moves
      const validMoves = this.calculateValidMoves(
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
   * Handle token move (Server validates and resolves)
   */
  handleMoveToken(socket, { roomId, playerId, tokenIndex }) {
    try {
      const room = this.rooms.get(roomId);
      if (!room) return;

      const player = room.players[playerId];
      if (!player) return;

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
        this.handleGameOver(room, player.color);
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
  calculateValidMoves(tokens, diceValue, playerColor) {
    const validMoves = [];

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

    let newPosition;
    let newState = token.state;

    // Moving from home
    if (token.position === -1) {
      newPosition = 0; // Start position
      newState = TOKEN_STATE.ACTIVE;
    } else {
      newPosition = token.position + diceValue;

      // Check if finished (exactly 56 steps)
      if (newPosition === 56) {
        newState = TOKEN_STATE.FINISHED;
        player.finishedCount++;
      }
    }

    // Update token
    token.position = newPosition;
    token.state = newState;

    // Check for kills
    let killed = null;
    if (newState === TOKEN_STATE.ACTIVE) {
      killed = this.checkForKill(room, playerColor, newPosition);
    }

    // Check for win
    const won = player.finishedCount === 4;

    // Determine next turn
    const bonusTurn = diceValue === 6 || killed !== null;

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
    }
  }

  /**
   * Move to next player
   */
  nextTurn(room) {
    const currentIndex = room.gameState.turnOrder.indexOf(room.gameState.currentPlayer);
    const nextIndex = (currentIndex + 1) % room.gameState.turnOrder.length;
    room.gameState.currentPlayer = room.gameState.turnOrder[nextIndex];
    room.gameState.status = GAME_STATE.ROLLING;
    room.gameState.diceValue = null;
    room.gameState.validMoves = [];
  }

  /**
   * Handle game over
   */
  handleGameOver(room, winnerColor) {
    room.gameState.status = GAME_STATE.FINISHED;
    room.gameState.winner = winnerColor;

    this.io.to(room.id).emit('ludo:game_over', {
      winner: winnerColor,
      finalState: this.getGameState(room),
      timestamp: Date.now()
    });

    console.log(`🏆 [GAME OVER] Winner: ${winnerColor} in room ${room.id}`);
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
      winner: room.gameState.winner
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
      playersInfo[id] = {
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        color: player.color,
        selectedToken: player.selectedToken || 'classic',
        selectedDice: player.selectedDice || 'classic',
        ready: player.ready,
        connected: player.connected
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
