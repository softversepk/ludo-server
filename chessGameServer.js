/**
 * Chess Game Server
 * Handles real-time chess game synchronization using Socket.io
 */

const RewardServiceServer = require('./rewardServiceServer');

class ChessGameServer {
  constructor(io, admin) {
    this.io = io;
    this.admin = admin;
    this.matchmakingQueue = new Map(); // userId -> player data
    this.activeGames = new Map(); // roomId -> game data
    this.userSockets = new Map(); // userId -> socketId
    
    this.setupEventHandlers();
  }

  // Helper to securely deduct coins
  async secureDeductCoins(userId, amount) {
    if (!amount || amount <= 0) return true;
    try {
      const userRef = this.admin.firestore().collection('users').doc(userId);
      return await this.admin.firestore().runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) throw new Error('User not found');
        const currentCoins = userDoc.data().coins || 0;
        if (currentCoins < amount) throw new Error('Not enough coins');
        transaction.update(userRef, {
          coins: this.admin.firestore.FieldValue.increment(-amount)
        });
        return true;
      });
    } catch (error) {
      console.error(`♟️ [CHESS SECURITY] Coin deduction failed for ${userId}:`, error.message);
      return false;
    }
  }

  // Helper to securely refund coins
  async secureRefundCoins(userId, amount) {
    if (!amount || amount <= 0) return true;
    try {
      const userRef = this.admin.firestore().collection('users').doc(userId);
      await userRef.update({
        coins: this.admin.firestore.FieldValue.increment(amount)
      });
      return true;
    } catch (error) {
      console.error(`♟️ [CHESS SECURITY] Coin refund failed for ${userId}:`, error.message);
      return false;
    }
  }

  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`♟️ [CHESS] Player connected: ${socket.id}`);

      // Register user socket
      socket.on('chess:register', (userId) => {
        this.userSockets.set(userId, socket.id);
        socket.userId = userId;
        console.log(`♟️ [CHESS] User registered: ${userId} -> ${socket.id}`);
        
        // Update socket and connected status for any active games
        for (const [roomId, game] of this.activeGames.entries()) {
           if (game.players.white.uid === userId) {
               game.players.white.socketId = socket.id;
               game.players.white.connected = true;
           } else if (game.players.black.uid === userId) {
               game.players.black.socketId = socket.id;
               game.players.black.connected = true;
           }
        }
      });

      // Join room (for players navigating to game screen)
      socket.on('chess:joinRoom', (data, callback) => {
        const { roomId } = data;
        socket.join(roomId);
        console.log(`♟️ [CHESS] Socket ${socket.id} joined room ${roomId}`);
        if (callback) callback({ success: true });
      });

      // Find match
      socket.on('chess:findMatch', async (data, callback) => {
        await this.handleFindMatch(socket, data, callback);
      });

      // Cancel matchmaking
      socket.on('chess:cancelMatchmaking', async (data, callback) => {
        const userId = data.userId || socket.userId;
        if (userId && this.matchmakingQueue.has(userId)) {
          const playerInQueue = this.matchmakingQueue.get(userId);
          
          if (playerInQueue && playerInQueue.betAmount > 0) {
            await this.secureRefundCoins(userId, playerInQueue.betAmount);
          }
          
          this.matchmakingQueue.delete(userId);
          
          if (this.matchmakingIntervals && this.matchmakingIntervals.has(userId)) {
            clearInterval(this.matchmakingIntervals.get(userId));
            this.matchmakingIntervals.delete(userId);
          }
          
          if (this.aiTimeouts && this.aiTimeouts.has(userId)) {
            clearTimeout(this.aiTimeouts.get(userId));
            this.aiTimeouts.delete(userId);
          }
          
          console.log(`♟️ [CHESS] Matchmaking cancelled for ${userId}`);
        }
        if (callback) callback({ success: true });
      });

      // Make move
      socket.on('chess:makeMove', (data, callback) => {
        this.handleMakeMove(socket, data, callback);
      });

      // Trigger Bot
      socket.on('chess:trigger_bot', (data) => {
        this.handleTriggerBot(socket, data);
      });

      // Get AI move for local games
      socket.on('chess:get_ai_move', (data, callback) => {
        try {
          const { gameState } = data;
          const { getLegalMoves, movePiece, isCheckmate } = require('./utils/chessLogic');
          const { pieces, currentTurn } = gameState;
          
          const aiPieces = pieces.filter((p) => p.color === currentTurn);
          const allMoves = [];
          aiPieces.forEach((piece) => {
            const moves = getLegalMoves(piece, pieces);
            moves.forEach((move) => {
              allMoves.push({ piece, move });
            });
          });

          if (allMoves.length === 0) {
            if (callback) callback({ success: false, error: 'No valid moves' });
            return;
          }

          const randomMove = allMoves[Math.floor(Math.random() * allMoves.length)];
          const newState = movePiece(
            gameState,
            randomMove.piece.position,
            randomMove.move
          );

          if (isCheckmate(newState.pieces, newState.currentTurn)) {
            newState.isCheckmate = true;
          }

          if (callback) callback({ success: true, newState });
        } catch (error) {
          console.error('Error generating local AI move:', error);
          if (callback) callback({ success: false, error: error.message });
        }
      });

      // Resign game
      socket.on('chess:resign', (data, callback) => {
        this.handleResign(socket, data, callback);
      });

      // Leave game
      socket.on('chess:leave', (data, callback) => {
        this.handleLeaveGame(socket, data, callback);
      });

      // Disconnect
      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });
    });
  }

  async processRewards(game, winnerId, status = 'won') {
    if (!game || !game.players || game.isAI) return;
    
    const betAmount = game.betAmount || 100;
    const players = [game.players.white, game.players.black];
    
    for (const player of players) {
      if (!player || player.uid === 'ai_bot') continue;
      
      try {
        if (status === 'draw') {
          await RewardServiceServer.awardGameDraw(player.uid, 'CHESS', betAmount);
        } else if (player.uid === winnerId) {
          const result = await RewardServiceServer.awardGameWin(player.uid, 'CHESS', betAmount);
          if (result.success) {
            this.io.to(game.roomId).emit(`reward:awarded:${player.uid}`, result);
          }
        } else {
          await RewardServiceServer.awardGameLoss(player.uid, 'CHESS', betAmount);
        }
      } catch (error) {
        console.error(`♟️ [CHESS] Error processing rewards for ${player.uid}:`, error);
      }
    }
  }

  async handleFindMatch(socket, data, callback) {
    const { userId, username, avatar, level, betAmount } = data;

    console.log(`♟️ [CHESS] ${username} searching for match (bet: ${betAmount})`);
    console.log(`♟️ [CHESS] Current queue size: ${this.matchmakingQueue.size}`);

    // Check if player is already in queue
    if (this.matchmakingQueue.has(userId)) {
      console.log(`♟️ [CHESS] Player already in queue: ${userId}`);
      if (callback) callback({ success: true, created: false, joined: false });
      return;
    }

    // Check and deduct coins before adding to queue
    if (betAmount > 0) {
      const deductionSuccess = await this.secureDeductCoins(userId, betAmount);
      if (!deductionSuccess) {
        if (callback) callback({ success: false, error: "Not enough coins or error deducting coins" });
        return;
      }
    }

    // Add to matchmaking queue with fresh socket reference
    this.matchmakingQueue.set(userId, {
      userId,
      username,
      avatar,
      level,
      betAmount,
      socket: socket, // Store socket reference, not just ID
      socketId: socket.id,
      timestamp: Date.now()
    });

    console.log(`♟️ [CHESS] Queue size after adding: ${this.matchmakingQueue.size}`);

    // Check for match immediately
    const match = this.findMatchInQueue(userId, betAmount);
    
    if (match) {
      console.log(`♟️ [CHESS] Match found immediately!`);
      this.createGame(userId, match.userId, betAmount);
      // Callback is optional, but since game is created and emitted, we don't strictly need it to trigger navigation,
      // but let's call it just in case the client relies on it for UI updates.
      if (callback) callback({ success: true, joined: true });
    } else {
      console.log(`♟️ [CHESS] No match found yet. Waiting for opponent...`);
      
      // Emit waiting status to player
      socket.emit('chess:waiting', {
        status: 'waiting',
        message: 'Waiting for opponent...'
      });
      if (callback) callback({ success: true, created: true, joined: false });
      
      // Set up periodic check for this player (check every 100ms for faster matching)
      const checkInterval = setInterval(() => {
        // Check if player is still in queue
        if (!this.matchmakingQueue.has(userId)) {
          clearInterval(checkInterval);
          return;
        }

        // Try to find a match
        const newMatch = this.findMatchInQueue(userId, betAmount);
        if (newMatch) {
          clearInterval(checkInterval);
          console.log(`♟️ [CHESS] Match found after waiting!`);
          this.createGame(userId, newMatch.userId, betAmount);
        }
      }, 100); // Check every 100ms for faster matching

      // Store interval ID for cleanup
      if (!this.matchmakingIntervals) {
        this.matchmakingIntervals = new Map();
      }
      this.matchmakingIntervals.set(userId, checkInterval);

      // Set up 3-second timeout for AI bot auto-join
      const aiTimeoutId = setTimeout(() => {
        // Check if player is still waiting (no match found)
        if (this.matchmakingQueue.has(userId)) {
          console.log(`♟️ [CHESS] No opponent found after 3 seconds. Creating AI game for ${username}`);
          
          // Remove from queue
          this.matchmakingQueue.delete(userId);
          
          // Clear interval
          if (this.matchmakingIntervals && this.matchmakingIntervals.has(userId)) {
            clearInterval(this.matchmakingIntervals.get(userId));
            this.matchmakingIntervals.delete(userId);
          }
          
          // Create AI game
          this.createAIGame(userId, username, avatar, level, betAmount, socket);
        }
      }, 3000); // 3 seconds

      // Store timeout ID for cleanup
      if (!this.aiTimeouts) {
        this.aiTimeouts = new Map();
      }
      this.aiTimeouts.set(userId, aiTimeoutId);
    }
  }

  findMatchInQueue(currentUserId, betAmount) {
    for (const [userId, player] of this.matchmakingQueue.entries()) {
      if (userId !== currentUserId && player.betAmount === betAmount) {
        return player;
      }
    }
    return null;
  }

  createGame(player1Id, player2Id, betAmount) {
    const roomId = `chess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const player1Data = this.matchmakingQueue.get(player1Id);
    const player2Data = this.matchmakingQueue.get(player2Id);

    if (!player1Data || !player2Data) {
      console.error(`♟️ [CHESS] Error: Player data not found`);
      return;
    }

    // Determine colors (first player is white)
    const isPlayer1White = player1Data.timestamp < player2Data.timestamp;
    const player1Color = isPlayer1White ? 'white' : 'black';
    const player2Color = isPlayer1White ? 'black' : 'white';

    const gameData = {
      roomId,
      betAmount,
      players: {
        white: isPlayer1White ? {
          uid: player1Id,
          username: player1Data.username,
          avatar: player1Data.avatar,
          level: player1Data.level,
          socketId: player1Data.socketId
        } : {
          uid: player2Id,
          username: player2Data.username,
          avatar: player2Data.avatar,
          level: player2Data.level,
          socketId: player2Data.socketId
        },
        black: !isPlayer1White ? {
          uid: player1Id,
          username: player1Data.username,
          avatar: player1Data.avatar,
          level: player1Data.level,
          socketId: player1Data.socketId
        } : {
          uid: player2Id,
          username: player2Data.username,
          avatar: player2Data.avatar,
          level: player2Data.level,
          socketId: player2Data.socketId
        }
      },
      gameState: null,
      status: 'active',
      createdAt: Date.now()
    };

    this.activeGames.set(roomId, gameData);

    // Remove from matchmaking queue
    this.matchmakingQueue.delete(player1Id);
    this.matchmakingQueue.delete(player2Id);

    // Clean up intervals
    if (this.matchmakingIntervals) {
      if (this.matchmakingIntervals.has(player1Id)) {
        clearInterval(this.matchmakingIntervals.get(player1Id));
        this.matchmakingIntervals.delete(player1Id);
      }
      if (this.matchmakingIntervals.has(player2Id)) {
        clearInterval(this.matchmakingIntervals.get(player2Id));
        this.matchmakingIntervals.delete(player2Id);
      }
    }

    // Clean up AI timeouts
    if (this.aiTimeouts) {
      if (this.aiTimeouts.has(player1Id)) {
        clearTimeout(this.aiTimeouts.get(player1Id));
        this.aiTimeouts.delete(player1Id);
      }
      if (this.aiTimeouts.has(player2Id)) {
        clearTimeout(this.aiTimeouts.get(player2Id));
        this.aiTimeouts.delete(player2Id);
      }
    }

    // Use fresh socket references from the queue data
    const socket1 = player1Data.socket;
    const socket2 = player2Data.socket;

    if (socket1 && socket1.connected) {
      socket1.join(roomId);
      socket1.emit('chess:matchFound', {
        status: 'matched',
        roomId,
        playerColor: player1Color,
        opponent: gameData.players[player2Color]
      });
      console.log(`♟️ [CHESS] Notified player 1: ${player1Data.username} (${player1Color})`);
    } else {
      console.error(`♟️ [CHESS] Socket not available for player 1: ${player1Id}`);
    }

    if (socket2 && socket2.connected) {
      socket2.join(roomId);
      socket2.emit('chess:matchFound', {
        status: 'matched',
        roomId,
        playerColor: player2Color,
        opponent: gameData.players[player1Color]
      });
      console.log(`♟️ [CHESS] Notified player 2: ${player2Data.username} (${player2Color})`);
    } else {
      console.error(`♟️ [CHESS] Socket not available for player 2: ${player2Id}`);
    }

    console.log(`♟️ [CHESS] Game created: ${roomId}`);
    console.log(`  White: ${gameData.players.white.username}`);
    console.log(`  Black: ${gameData.players.black.username}`);
  }

  /**
   * Create AI game when no opponent found after 3 seconds
   */
  createAIGame(playerId, username, avatar, level, betAmount, socket) {
    const roomId = `chess_ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Random AI name
    const aiNames = ['Chess Master', 'AI Bot', 'Smart AI', 'Chess AI', 'Bot Player'];
    const aiName = aiNames[Math.floor(Math.random() * aiNames.length)];
    
    // Random player color
    const playerColor = Math.random() > 0.5 ? 'white' : 'black';
    const aiColor = playerColor === 'white' ? 'black' : 'white';

    const gameData = {
      roomId,
      betAmount,
      isAI: true,
      players: {
        white: playerColor === 'white' ? {
          uid: playerId,
          username: username,
          avatar: avatar,
          level: level,
          socketId: socket.id,
          isAI: false
        } : {
          uid: 'ai_bot',
          username: aiName,
          avatar: 'https://via.placeholder.com/100?text=AI',
          level: level + 2,
          socketId: null,
          isAI: true
        },
        black: playerColor === 'black' ? {
          uid: playerId,
          username: username,
          avatar: avatar,
          level: level,
          socketId: socket.id,
          isAI: false
        } : {
          uid: 'ai_bot',
          username: aiName,
          avatar: 'https://via.placeholder.com/100?text=AI',
          level: level + 2,
          socketId: null,
          isAI: true
        }
      },
      gameState: null,
      status: 'active',
      createdAt: Date.now()
    };

    this.activeGames.set(roomId, gameData);

    // Notify player
    if (socket && socket.connected) {
      socket.join(roomId);
      socket.emit('chess:matchFound', {
        status: 'matched',
        roomId,
        playerColor: playerColor,
        opponent: gameData.players[aiColor],
        isAI: true
      });
      console.log(`♟️ [CHESS] AI Game created for ${username} (${playerColor}) vs ${aiName} (${aiColor})`);
    } else {
      console.error(`♟️ [CHESS] Socket not available for AI game`);
    }
  }

  handleMakeMove(socket, data, callback) {
    const { roomId, gameState } = data;
    const game = this.activeGames.get(roomId);

    if (!game) {
      if (callback) callback({ error: 'Game not found' });
      else socket.emit('chess:error', { message: 'Game not found' });
      return;
    }

    // SECURITY: Validate that the socket making the request belongs to one of the players
    const whiteSocketId = game.players.white.socketId;
    const blackSocketId = game.players.black.socketId;
    if (socket.id !== whiteSocketId && socket.id !== blackSocketId) {
      console.warn(`[CHESS] Security Alert: Unauthorized socket ${socket.id} attempted to move in room ${roomId}`);
      if (callback) callback({ error: 'Unauthorized move' });
      return;
    }

    // Initialize game state if this is the first move/sync
    if (!game.gameState) {
      game.gameState = gameState;
      console.log(`♟️ [CHESS] Game state initialized for ${roomId}`);
    } else {
      // Update game state with new move
      game.gameState = gameState;
    }
    
    game.lastUpdate = Date.now();

    // Broadcast to both players
    // We must ensure the socket explicitly broadcasts to the room using `socket.to(roomId).emit` 
    // or `this.io.to(roomId).emit`, since `this.io.to(roomId)` works for sending it to everyone.
    socket.to(roomId).emit('chess:gameUpdate', {
      gameState,
      timestamp: Date.now()
    });

    console.log(`♟️ [CHESS] Move in ${roomId}: ${gameState.lastMove?.from} -> ${gameState.lastMove?.to}`);

    if (callback) callback({ success: true });

    // Check for checkmate
    if (gameState.isCheckmate) {
      this.handleGameEnd(roomId, gameState);
    }
  }

  handleTriggerBot(socket, { roomId }) {
    try {
      const game = this.activeGames.get(roomId);
      if (!game || !game.gameState) return;

      const { pieces, currentTurn } = game.gameState;

      // Ensure it's actually AI's turn
      const whitePlayer = game.players.white;
      const blackPlayer = game.players.black;
      
      const isAITurn = (currentTurn === 'white' && whitePlayer.isAI) || 
                       (currentTurn === 'black' && blackPlayer.isAI);
                       
      if (!isAITurn) return;

      const { getLegalMoves, movePiece, isCheckmate } = require('./utils/chessLogic');

      // Get all AI pieces
      const aiPieces = pieces.filter((p) => p.color === currentTurn);

      // Get all possible moves
      const allMoves = [];
      aiPieces.forEach((piece) => {
        const moves = getLegalMoves(piece, pieces);
        moves.forEach((move) => {
          allMoves.push({ piece, move });
        });
      });

      if (allMoves.length === 0) return;

      // Pick random move (simple AI)
      const randomMove = allMoves[Math.floor(Math.random() * allMoves.length)];
      const newState = movePiece(
        game.gameState,
        randomMove.piece.position,
        randomMove.move
      );

      // Update game state
      game.gameState = newState;
      game.lastUpdate = Date.now();

      // Check for checkmate BEFORE broadcasting
      if (isCheckmate(newState.pieces, newState.currentTurn)) {
        newState.isCheckmate = true;
      }

      // Broadcast to players
      this.io.to(roomId).emit('chess:gameUpdate', {
        gameState: newState,
        timestamp: Date.now()
      });

      console.log(`♟️ [CHESS] AI Move in ${roomId}: ${newState.lastMove?.from} -> ${newState.lastMove?.to}`);

      if (newState.isCheckmate) {
        this.handleGameEnd(roomId, newState);
      }

    } catch (error) {
      console.error("[CHESS] AI move error:", error);
    }
  }

  handleResign(socket, data, callback) {
    const { roomId, resigningPlayerId, betAmount } = data;
    const game = this.activeGames.get(roomId);

    if (!game) {
      if (callback) callback({ error: 'Game not found' });
      else socket.emit('chess:error', { message: 'Game not found' });
      return;
    }

    // SECURITY: Validate that the socket belongs to the resigning player
    const resigningPlayer = game.players.white.uid === resigningPlayerId ? game.players.white : 
                            game.players.black.uid === resigningPlayerId ? game.players.black : null;
    
    if (!resigningPlayer) {
      if (callback) callback({ error: 'Player not found' });
      return;
    }

    if (resigningPlayer.socketId && socket.id !== resigningPlayer.socketId) {
      console.warn(`[CHESS] Security Alert: Socket ${socket.id} attempted to resign for player ${resigningPlayerId} but expected socket ${resigningPlayer.socketId}`);
      if (callback) callback({ error: 'Unauthorized resign' });
      return;
    }

    // Determine winner
    const whitePlayer = game.players.white;
    const blackPlayer = game.players.black;
    const winnerId = resigningPlayerId === whitePlayer.uid ? blackPlayer.uid : whitePlayer.uid;

    // Notify both players
    this.io.to(roomId).emit('chess:gameEnded', {
      status: 'resigned',
      winnerId,
      betAmount
    });

    if (!game.rewardsProcessed) {
      game.rewardsProcessed = true;
      this.processRewards(game, winnerId);
    }

    // Clean up game
    this.activeGames.delete(roomId);
    console.log(`♟️ [CHESS] Game ${roomId} ended by resignation`);

    if (callback) callback({ success: true });
  }

  handleLeaveGame(socket, data, callback) {
    const { roomId, playerId, betAmount } = data;
    const game = this.activeGames.get(roomId);

    if (!game) {
      if (callback) callback({ error: 'Game not found' });
      return;
    }

    // SECURITY: Validate that the socket belongs to the leaving player
    const leavingPlayer = game.players.white.uid === playerId ? game.players.white : 
                          game.players.black.uid === playerId ? game.players.black : null;
    
    if (!leavingPlayer) {
      if (callback) callback({ error: 'Player not found' });
      return;
    }

    if (leavingPlayer.socketId && socket.id !== leavingPlayer.socketId) {
      console.warn(`[CHESS] Security Alert: Socket ${socket.id} attempted to leave game for player ${playerId} but expected socket ${leavingPlayer.socketId}`);
      if (callback) callback({ error: 'Unauthorized leave' });
      return;
    }

    // Determine winner (opponent wins)
    const whitePlayer = game.players.white;
    const blackPlayer = game.players.black;
    const winnerId = playerId === whitePlayer.uid ? blackPlayer.uid : whitePlayer.uid;

    // Notify both players
    this.io.to(roomId).emit('chess:gameEnded', {
      status: 'playerLeft',
      winnerId,
      betAmount
    });

    if (!game.rewardsProcessed) {
      game.rewardsProcessed = true;
      this.processRewards(game, winnerId);
    }

    // Clean up game
    this.activeGames.delete(roomId);
    console.log(`♟️ [CHESS] Game ${roomId} ended - player left`);

    if (callback) callback({ success: true });
  }

  handleGameEnd(roomId, gameState) {
    const game = this.activeGames.get(roomId);
    if (!game) return;

    // Determine winner based on whose turn it is (they're in checkmate)
    const whitePlayer = game.players.white;
    const blackPlayer = game.players.black;
    const winnerId = gameState.currentTurn === 'white' ? blackPlayer.uid : whitePlayer.uid;

    // Notify both players
    this.io.to(roomId).emit('chess:gameEnded', {
      status: 'checkmate',
      winnerId,
      betAmount: game.betAmount
    });

    if (!game.rewardsProcessed) {
      game.rewardsProcessed = true;
      this.processRewards(game, winnerId);
    }

    // Clean up game
    this.activeGames.delete(roomId);
    console.log(`♟️ [CHESS] Game ${roomId} ended - checkmate`);
  }

  handleDisconnect(socket) {
    const userId = socket.userId;
    
    // Remove from matchmaking queue
    if (userId) {
      if (this.matchmakingQueue.has(userId)) {
        const playerInQueue = this.matchmakingQueue.get(userId);
        
        // Refund if they paid to enter queue but disconnected before match
        if (playerInQueue && playerInQueue.betAmount > 0) {
          this.secureRefundCoins(userId, playerInQueue.betAmount).catch(err => 
            console.error('Failed to refund chess matchmaking on disconnect:', err)
          );
        }
      }
      
      this.matchmakingQueue.delete(userId);
      this.userSockets.delete(userId);
      
      // Clean up interval
      if (this.matchmakingIntervals && this.matchmakingIntervals.has(userId)) {
        clearInterval(this.matchmakingIntervals.get(userId));
        this.matchmakingIntervals.delete(userId);
      }
    }

    // Find and handle any active games
    for (const [roomId, game] of this.activeGames.entries()) {
      const whitePlayer = game.players.white;
      const blackPlayer = game.players.black;

      if (whitePlayer.uid === userId || blackPlayer.uid === userId) {
        // Mark as disconnected
        const player = whitePlayer.uid === userId ? whitePlayer : blackPlayer;
        player.connected = false;

        // Wait 30 seconds before ending the game
        setTimeout(() => {
          const currentGame = this.activeGames.get(roomId);
          if (currentGame && currentGame.players) {
            const p = currentGame.players.white.uid === userId ? currentGame.players.white : currentGame.players.black;
            if (!p.connected && p.socketId === socket.id) {
              const winnerId = whitePlayer.uid === userId ? blackPlayer.uid : whitePlayer.uid;
              
              this.io.to(roomId).emit('chess:gameEnded', {
                status: 'playerDisconnected',
                winnerId,
                betAmount: currentGame.betAmount
              });

              if (!currentGame.rewardsProcessed) {
                currentGame.rewardsProcessed = true;
                this.processRewards(currentGame, winnerId);
              }

              this.activeGames.delete(roomId);
              console.log(`♟️ [CHESS] Game ${roomId} ended - player disconnected`);
            }
          }
        }, 30000);
      }
    }

    console.log(`♟️ [CHESS] Player disconnected: ${socket.id}`);
  }

  // Get game stats
  getStats() {
    return {
      matchmakingQueueSize: this.matchmakingQueue.size,
      activeGamesCount: this.activeGames.size,
      connectedUsers: this.userSockets.size
    };
  }
}

module.exports = ChessGameServer;
