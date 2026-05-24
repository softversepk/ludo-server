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
    });
  }

  handleResign(socket, { roomId, playerRole }) {
    try {
      const room = this.rooms[roomId];
      if (!room || !room.gameState || room.status === 'game_over') return;

      const gameState = room.gameState;
      if (gameState.winner) return;

      // SECURITY: Validate that the socket making the request belongs to the claimed playerRole
      const playerId = gameState.players[playerRole];
      if (!playerId) return;

      const expectedSocketId = this.userSockets[playerId] || (room.players[playerId] && room.players[playerId].socketId);
      if (expectedSocketId && socket.id !== expectedSocketId) {
        console.warn(`[TicTacToe] Security Alert: Socket ${socket.id} attempted to resign for player ${playerId} (role ${playerRole}) but expected socket ${expectedSocketId}`);
        return;
      }

      gameState.playerLeft = playerRole;
      gameState.winner = playerRole === 'X' ? 'O' : 'X';
      room.status = 'game_over';

      this.io.to(roomId).emit("game_state_update", gameState);

      if (!gameState.rewardsProcessed) {
        gameState.rewardsProcessed = true;
        this.processRewards(room, gameState);
      }

      // Trigger cleanup when a player resigns
      if (this.rooms && typeof this.rooms.scheduleRoomDelete === 'function') {
        this.rooms.scheduleRoomDelete(roomId, 60000);
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
        
        if (winnerRole === 'draw') {
          await RewardServiceServer.awardGameDraw(uid, 'TIC_TAC_TOE', betAmount);
        } else if (role === winnerRole) {
          const result = await RewardServiceServer.awardGameWin(uid, 'TIC_TAC_TOE', betAmount);
          if (result.success) {
            this.io.to(room.id || room.roomCode).emit(`reward:awarded:${uid}`, result);
          }
        } else {
          await RewardServiceServer.awardGameLoss(uid, 'TIC_TAC_TOE', betAmount);
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

      // Allow if the socket matches the user's registered socket, OR if the socket matches the player's stored socketId
      const expectedSocketId = this.userSockets[playerId] || (room.players[playerId] && room.players[playerId].socketId);
      if (expectedSocketId && socket.id !== expectedSocketId) {
        console.warn(`[TicTacToe] Security Alert: Socket ${socket.id} attempted to move for player ${playerId} (role ${playerRole}) but expected socket ${expectedSocketId}`);
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
        this.processRewards(room, gameState);
        
        if (this.rooms && typeof this.rooms.scheduleRoomDelete === 'function') {
          this.rooms.scheduleRoomDelete(roomId, 60000);
        }
      }

    } catch (error) {
      console.error("[TicTacToe] Move error:", error);
    }
  }

  handleTriggerBot(socket, { roomId }) {
    try {
      const room = this.rooms[roomId];
      if (!room || !room.gameState || room.status === 'game_over') return;

      const gameState = room.gameState;
      if (gameState.winner) return;

      // SECURITY: Validate that the socket making the request is a player in the room
      let isPlayerInRoom = false;
      for (const [playerId, player] of Object.entries(room.players)) {
        if (!player.isBot) {
          const expectedSocketId = this.userSockets[playerId] || player.socketId;
          if (expectedSocketId === socket.id) {
            isPlayerInRoom = true;
            break;
          }
        }
      }
      
      if (!isPlayerInRoom) {
        console.warn(`[TicTacToe] Security Alert: Unauthorized socket ${socket.id} attempted to trigger bot in room ${roomId}`);
        return;
      }

      // Find empty spots
      const emptyIndices = gameState.board
        .map((val, idx) => (val === null ? idx : null))
        .filter((val) => val !== null);
        
      if (emptyIndices.length === 0) return;

      // Pick a random spot
      const randomIndex = emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
      const botRole = gameState.xIsNext ? 'X' : 'O';

      // Apply move
      gameState.board[randomIndex] = botRole;
      gameState.xIsNext = !gameState.xIsNext;
      gameState.lastMove = randomIndex;

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
      }

    } catch (error) {
      console.error("[TicTacToe] Bot move error:", error);
    }
  }
}

module.exports = TicTacToeGameServer;
