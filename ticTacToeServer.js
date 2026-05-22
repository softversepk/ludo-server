const GAME_STATE = {
  WAITING: 'waiting',
  PLAYING: 'playing',
  FINISHED: 'finished'
};

class TicTacToeGameServer {
  constructor(io, roomsMap) {
    this.io = io;
    this.rooms = roomsMap; // Reference to the shared rooms object in index.js
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

      gameState.playerLeft = playerRole;
      gameState.winner = playerRole === 'X' ? 'O' : 'X';
      room.status = 'game_over';

      this.io.to(roomId).emit("game_state_update", gameState);

      // Trigger cleanup when a player resigns
      if (this.rooms && typeof this.rooms.scheduleRoomDelete === 'function') {
        this.rooms.scheduleRoomDelete(roomId, 60000);
      }
    } catch (error) {
      console.error("[TicTacToe] Resign error:", error);
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

      // Trigger cleanup when game is over
      if (room.status === 'game_over' && this.rooms && typeof this.rooms.scheduleRoomDelete === 'function') {
        this.rooms.scheduleRoomDelete(roomId, 60000);
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

      // Trigger cleanup when game is over
      if (room.status === 'game_over' && this.rooms && typeof this.rooms.scheduleRoomDelete === 'function') {
        this.rooms.scheduleRoomDelete(roomId, 60000);
      }

    } catch (error) {
      console.error("[TicTacToe] Bot move error:", error);
    }
  }
}

module.exports = TicTacToeGameServer;
