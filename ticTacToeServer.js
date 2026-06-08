const GAME_STATE = {
  WAITING: 'waiting',
  PLAYING: 'playing',
  FINISHED: 'finished'
};

const RewardServiceServer = require('./rewardServiceServer');

class TicTacToeGameServer {
  constructor(io, roomsMap, admin, userSockets) {
    this.io = io;
    this.rooms = roomsMap; // Reference to the shared rooms object in index.js
    this.admin = admin;
    this.userSockets = userSockets || {};
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
      // SECURITY: Strict Input Validation
      if (!roomId || typeof roomId !== 'string') {
        console.warn(`[TicTacToe] Security Alert: Invalid roomId in resign`);
        return;
      }
      if (playerRole !== 'X' && playerRole !== 'O') {
        console.warn(`[TicTacToe] Security Alert: Invalid playerRole in resign`);
        return;
      }

      const room = this.rooms[roomId];
      if (!room || !room.gameState || room.status === 'game_over') return;

      const gameState = room.gameState;
      if (gameState.winner) return;

      // SECURITY: Validate that the socket making the request belongs to the claimed playerRole
      const playerId = gameState.players[playerRole];
      if (!playerId) return;

      // Ensure socket is authenticated and matches playerId
      if (socket.userId && socket.userId !== playerId) {
        console.warn(`[TicTacToe] Security Alert: Socket ${socket.id} (User: ${socket.userId}) attempted to resign for player ${playerId}`);
        return;
      }

      const expectedSocketId = this.userSockets[playerId] || (room.players[playerId] && room.players[playerId].socketId);
      if (!socket.userId && (!expectedSocketId || socket.id !== expectedSocketId)) {
        console.warn(`[TicTacToe] Security Alert: Socket ${socket.id} attempted to resign for player ${playerId} (role ${playerRole}) but expected socket ${expectedSocketId}`);
        return;
      }

      gameState.playerLeft = playerRole;
      gameState.winner = playerRole === 'X' ? 'O' : 'X';
      room.status = 'game_over';

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
      console.error("[TicTacToe] Resign error:", error);
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
      // SECURITY: Strict Input Validation
      if (!roomId || typeof roomId !== 'string') {
        console.warn(`[TicTacToe] Security Alert: Invalid roomId in make_move`);
        return;
      }
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 8) {
        console.warn(`[TicTacToe] Security Alert: Invalid move index ${index} by socket ${socket.id}`);
        return;
      }
      if (playerRole !== 'X' && playerRole !== 'O') {
        console.warn(`[TicTacToe] Security Alert: Invalid playerRole ${playerRole} in make_move`);
        return;
      }

      const room = this.rooms[roomId];
      if (!room || !room.gameState) return;

      const gameState = room.gameState;
      
      // Validations
      if (gameState.winner) return; // Game already over
      if (gameState.board[index] !== null) return; // Cell already taken
      
      // SECURITY: Validate that the socket making the move belongs to the claimed playerRole
      const playerId = gameState.players[playerRole];
      if (!playerId) {
        console.warn(`[TicTacToe] Player ID not found for role ${playerRole}`);
        return;
      }

      // Ensure socket is authenticated and matches playerId
      if (socket.userId && socket.userId !== playerId) {
        console.warn(`[TicTacToe] Security Alert: Socket ${socket.id} (User: ${socket.userId}) attempted to move for player ${playerId}`);
        return;
      }

      // Allow if the socket matches the user's registered socket, OR if the socket matches the player's stored socketId
      const expectedSocketId = this.userSockets[playerId] || (room.players[playerId] && room.players[playerId].socketId);
      if (!socket.userId && (!expectedSocketId || socket.id !== expectedSocketId)) {
        console.warn(`[TicTacToe] Security Alert: Socket ${socket.id} attempted to move for player ${playerId} (role ${playerRole}) but expected socket ${expectedSocketId}`);
        return;
      }

      // SECURITY: Block clients from making moves for bots
      const player = room.players[playerId];
      if (player && player.isBot) {
        console.warn(`[TicTacToe] Security Alert: Socket ${socket.id} attempted to make move for BOT player ${playerId}`);
        return;
      }
      
      // Check turn
      const expectedRole = gameState.xIsNext ? 'X' : 'O';
      if (playerRole !== expectedRole) {
        console.warn(`[TicTacToe] Invalid turn. Expected ${expectedRole}, got ${playerRole}`);
        return; 
      }

      // Apply move
      gameState.board[index] = playerRole;
      gameState.xIsNext = !gameState.xIsNext;
      gameState.lastMove = index;

      // Check for win or draw
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
        
        // Prevent state blocking during async reward processing (fire and forget)
        this.processRewards(room, gameState).catch(e => console.error('[TicTacToe] Reward processing error:', e));
        
        if (this.rooms && typeof this.rooms.scheduleRoomDelete === 'function') {
          this.rooms.scheduleRoomDelete(roomId, 60000);
        }
      } else if (room.status !== 'game_over') {
        this.playBotTurn(roomId).catch(e => console.error('[TicTacToe] Bot turn error:', e));
      }

    } catch (error) {
      console.error("[TicTacToe] Move error:", error);
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
      if (!roomId || typeof roomId !== 'string') return;
      const room = this.rooms[roomId];
      if (!room || !room.gameState || room.status === 'game_over') return;
      
      const gameState = room.gameState;
      const expectedRole = gameState.xIsNext ? 'X' : 'O';
      const playerId = gameState.players[expectedRole];
      const player = room.players[playerId];

      // SECURITY: Validate that the socket triggering the bot belongs to the OTHER player
      const otherRole = expectedRole === 'X' ? 'O' : 'X';
      const otherPlayerId = gameState.players[otherRole];
      
      if (socket.userId && socket.userId !== otherPlayerId) {
        console.warn(`[TicTacToe] Security Alert: Socket ${socket.id} (User: ${socket.userId}) attempted to trigger bot but is not the opponent.`);
        return;
      }

      if (player && player.isBot) {
        this.playBotTurn(roomId);
      }
    } catch (error) {
      console.error("[TicTacToe] Trigger Bot error:", error);
    }
  }
}

module.exports = TicTacToeGameServer;
