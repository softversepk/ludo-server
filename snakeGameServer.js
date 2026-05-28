const ARENA_WIDTH = 300;
const ARENA_HEIGHT = 450;
const SNAKE_RADIUS = 5;
const FOOD_RADIUS = 6;
const BASE_SPEED = 0.008;
const ROTATION_SPEED = 0.15;
const TICK_RATE = 50; // 20 FPS for server

class SnakeGameServer {
  constructor(io, rooms, RewardServiceServer) {
    this.io = io;
    this.rooms = rooms;
    this.RewardServiceServer = RewardServiceServer;
    this.gameLoops = {};
  }

  startGame(roomCode) {
    const room = this.rooms[roomCode];
    if (!room || !room.gameState) return;

    // Initialize game state if needed
    if (!room.gameState.snakes) return;

    room.status = "playing";
    room.gameState.status = "playing";
    
    // Set up turn directions
    room.gameState.turnDirections = {
      player1: 0,
      player2: 0
    };

    console.log(`[SNAKE SERVER] Starting secure game loop for room ${roomCode}`);

    // Clear existing loop if any
    if (this.gameLoops[roomCode]) {
      clearInterval(this.gameLoops[roomCode]);
    }

    // Start 1-second timer interval
    room.gameState.timerInterval = setInterval(() => {
      this.updateTimer(roomCode);
    }, 1000);

    // Start physics loop
    this.gameLoops[roomCode] = setInterval(() => {
      this.updatePhysics(roomCode);
    }, TICK_RATE);
  }

  updateTimer(roomCode) {
    const room = this.rooms[roomCode];
    if (!room || room.status !== "playing" || !room.gameState) {
      if (room && room.gameState && room.gameState.timerInterval) {
        clearInterval(room.gameState.timerInterval);
      }
      return;
    }

    if (room.gameState.timeLeft > 0) {
      room.gameState.timeLeft -= 1;
    } else {
      const s = room.gameState.snakes;
      const winner = s.player1.score > s.player2.score
        ? "player1"
        : s.player1.score < s.player2.score
          ? "player2"
          : "draw";
      this.handleGameOver(roomCode, winner);
    }
  }

  handleTurn(roomCode, playerKey, turnDirection) {
    const room = this.rooms[roomCode];
    if (!room || !room.gameState || !room.gameState.turnDirections) return;
    
    room.gameState.turnDirections[playerKey] = turnDirection;
  }

  updatePhysics(roomCode) {
    const room = this.rooms[roomCode];
    if (!room || room.status !== "playing" || !room.gameState) {
      this.stopGame(roomCode);
      return;
    }

    const state = room.gameState;
    let stateChanged = false;

    // 1. Move Both Snakes
    ["player1", "player2"].forEach((pKey) => {
      const snake = state.snakes[pKey];
      if (snake.isDead) return;

      // Handle Input
      const turnDir = state.turnDirections[pKey] || 0;
      
      // Handle Bot Logic if Player 2 is Bot
      if (pKey === "player2" && state.isPlayer2Bot) {
        this.processBotTurn(state, snake);
      } else {
        snake.angle += turnDir * ROTATION_SPEED;
      }

      // Update Position
      const oldHead = { ...snake.head };
      snake.head.x += Math.cos(snake.angle) * BASE_SPEED;
      snake.head.y += Math.sin(snake.angle) * BASE_SPEED;

      // Body Follow Logic
      if (!snake.history) snake.history = [];
      snake.history.unshift(oldHead);
      if (snake.history.length > 500) snake.history.pop();

      // Position segments
      if (snake.body) {
        snake.body.forEach((seg, i) => {
          const historyIndex = (i + 1) * 3;
          if (snake.history[historyIndex]) {
            snake.body[i] = snake.history[historyIndex];
          }
        });
      }

      // 2. Collisions
      // Wall
      if (
        snake.head.x < 0 ||
        snake.head.x > 1 ||
        snake.head.y < 0 ||
        snake.head.y > 1
      ) {
        this.handleDeath(roomCode, pKey);
        return;
      }

      // Self/Other Body (Circle vs Circle)
      const checkBodyCollision = (targetSnake, fromIndex = 0) => {
        if (!targetSnake || !targetSnake.body) return false;
        for (let i = fromIndex; i < targetSnake.body.length; i++) {
          const seg = targetSnake.body[i];
          const dx = (snake.head.x - seg.x) * ARENA_WIDTH;
          const dy = (snake.head.y - seg.y) * ARENA_HEIGHT;
          if (Math.sqrt(dx * dx + dy * dy) < SNAKE_RADIUS * 1.5) return true;
        }
        return false;
      };

      if (checkBodyCollision(state.snakes.player1, pKey === "player1" ? 10 : 0)) {
        this.handleDeath(roomCode, pKey);
        return;
      }
      if (checkBodyCollision(state.snakes.player2, pKey === "player2" ? 10 : 0)) {
        this.handleDeath(roomCode, pKey);
        return;
      }

      // 3. Food Eating
      if (state.food) {
        state.food.forEach((food, idx) => {
          const dx = (snake.head.x - food.x) * ARENA_WIDTH;
          const dy = (snake.head.y - food.y) * ARENA_HEIGHT;
          if (Math.sqrt(dx * dx + dy * dy) < SNAKE_RADIUS + FOOD_RADIUS) {
            snake.score += 10;
            // Grow
            for (let i = 0; i < 3; i++) {
              if (snake.body.length > 0) {
                snake.body.push({ ...snake.body[snake.body.length - 1] });
              } else {
                snake.body.push({ ...snake.head });
              }
            }

            // Respawn food
            state.food[idx] = {
              id: Date.now() + idx,
              x: Math.random() * 0.8 + 0.1,
              y: Math.random() * 0.8 + 0.1,
              type: "normal",
            };
            
            // We need to notify clients of sound somehow, 
            // but clients can play sound on score change
          }
        });
      }
      
      stateChanged = true;
    });

    // Broadcast state to clients
    if (stateChanged && room.status === "playing") {
      // Send a clean state to avoid sending too much data (e.g. history)
      const cleanState = {
        status: state.status,
        timeLeft: state.timeLeft,
        winner: state.winner,
        food: state.food,
        snakes: {
          player1: {
            head: state.snakes.player1.head,
            body: state.snakes.player1.body,
            angle: state.snakes.player1.angle,
            score: state.snakes.player1.score,
            isDead: state.snakes.player1.isDead
          },
          player2: {
            head: state.snakes.player2.head,
            body: state.snakes.player2.body,
            angle: state.snakes.player2.angle,
            score: state.snakes.player2.score,
            isDead: state.snakes.player2.isDead
          }
        }
      };
      
      this.io.to(roomCode).emit("game_state_update", cleanState);
    }
  }

  processBotTurn(state, snake) {
    const isPositionSafe = (fx, fy) => {
      if (fx < 0.05 || fx > 0.95 || fy < 0.05 || fy > 0.95) return false;

      const p1 = state.snakes.player1;
      if (p1 && !p1.isDead) {
        const dxHead = (fx - p1.head.x) * ARENA_WIDTH;
        const dyHead = (fy - p1.head.y) * ARENA_HEIGHT;
        if (Math.sqrt(dxHead * dxHead + dyHead * dyHead) < SNAKE_RADIUS * 2.5) return false;

        for (let i = 0; i < p1.body.length; i++) {
          const seg = p1.body[i];
          const dx = (fx - seg.x) * ARENA_WIDTH;
          const dy = (fy - seg.y) * ARENA_HEIGHT;
          if (Math.sqrt(dx * dx + dy * dy) < SNAKE_RADIUS * 2.2) return false;
        }
      }

      const p2 = state.snakes.player2;
      if (p2) {
        for (let i = 4; i < p2.body.length; i++) {
          const seg = p2.body[i];
          const dx = (fx - seg.x) * ARENA_WIDTH;
          const dy = (fy - seg.y) * ARENA_HEIGHT;
          if (Math.sqrt(dx * dx + dy * dy) < SNAKE_RADIUS * 2.2) return false;
        }
      }
      return true;
    };

    let closestFood = null;
    let minDistance = Infinity;
    if (state.food && state.food.length > 0) {
      state.food.forEach((f) => {
        if (f.x < 0 || f.y < 0) return;
        const dx = (f.x - snake.head.x) * ARENA_WIDTH;
        const dy = (f.y - snake.head.y) * ARENA_HEIGHT;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDistance) {
          minDistance = dist;
          closestFood = f;
        }
      });
    }

    const target = closestFood || { x: 0.5, y: 0.5 };
    const idealAngle = Math.atan2(
      target.y - snake.head.y,
      target.x - snake.head.x,
    );

    let chosenAngle = null;
    const lookAheadDist = 0.07;
    const angleSteps = [];
    for (let dev = 0; dev <= Math.PI; dev += 0.15) {
      if (dev === 0) {
        angleSteps.push(0);
      } else {
        angleSteps.push(dev);
        angleSteps.push(-dev);
      }
    }

    for (let i = 0; i < angleSteps.length; i++) {
      const testAngle = idealAngle + angleSteps[i];
      const testX = snake.head.x + Math.cos(testAngle) * lookAheadDist;
      const testY = snake.head.y + Math.sin(testAngle) * lookAheadDist;

      if (isPositionSafe(testX, testY)) {
        chosenAngle = testAngle;
        break;
      }
    }

    const finalSteerAngle = chosenAngle !== null ? chosenAngle : idealAngle;
    let diff = finalSteerAngle - snake.angle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;

    snake.angle += Math.sign(diff) * Math.min(Math.abs(diff), ROTATION_SPEED * 0.95);
  }

  handleDeath(roomCode, pKey) {
    const room = this.rooms[roomCode];
    if (!room || !room.gameState || !room.gameState.snakes[pKey]) return;
    
    room.gameState.snakes[pKey].isDead = true;
    const winner = pKey === "player1" ? "player2" : "player1";
    this.handleGameOver(roomCode, winner);
  }

  handleGameOver(roomCode, winner) {
    const room = this.rooms[roomCode];
    if (!room || room.status === "game_over" || !room.gameState) return;

    console.log(`[SNAKE SERVER] Game Over in room ${roomCode}. Winner: ${winner}`);

    room.status = "game_over";
    room.gameState.status = "game_over";
    room.gameState.winner = winner;

    // Broadcast game over
    this.io.to(roomCode).emit("game_state_update", {
      status: "game_over",
      winner: winner,
      playerLeft: room.gameState.playerLeft,
      snakes: room.gameState.snakes,
      food: room.gameState.food,
      timeLeft: room.gameState.timeLeft
    });

    this.stopGame(roomCode);

    // Process Rewards Securely on Backend
    if (room.betAmount && this.RewardServiceServer) {
      const players = room.players;
      if (players) {
        for (const [playerId, playerObj] of Object.entries(players)) {
          if (!playerId || playerObj.isBot) continue;
          
          const p1Uid = Object.keys(players)[0];
          const p2Uid = Object.keys(players)[1];
          
          if (winner === "draw") {
            this.RewardServiceServer.awardGameDraw(playerId, 'SNAKE', room.betAmount)
              .catch(e => console.error(e));
          } else {
            const isWinner = (winner === 'player1' && p1Uid === playerId) || (winner === 'player2' && p2Uid === playerId);
            
            if (isWinner) {
              this.RewardServiceServer.awardGameWin(playerId, 'SNAKE', room.betAmount)
                .then(result => {
                  if (result && result.success) {
                    this.io.to(roomCode).emit(`reward:awarded:${playerId}`, result);
                  }
                }).catch(e => console.error(e));
            } else {
              this.RewardServiceServer.awardGameLoss(playerId, 'SNAKE', room.betAmount)
                .catch(e => console.error(e));
            }
          }
        }
      }
    }
  }

  stopGame(roomCode) {
    if (this.gameLoops[roomCode]) {
      clearInterval(this.gameLoops[roomCode]);
      delete this.gameLoops[roomCode];
    }
    const room = this.rooms[roomCode];
    if (room && room.gameState && room.gameState.timerInterval) {
      clearInterval(room.gameState.timerInterval);
    }
  }

  handleDisconnect(socket) {
    // If a player disconnects, handle game over if playing after a grace period
    for (const [code, room] of Object.entries(this.rooms)) {
      if (room.mode !== 'snake_vs_snake' && room.gameMode !== 'snake_vs_snake') continue;
      
      if (room.status === "playing") {
        const playerKeys = Object.keys(room.players);
        const disconnectedUid = playerKeys.find(uid => room.players[uid].socketId === socket.id);
        
        if (disconnectedUid) {
          room.players[disconnectedUid].connected = false;
          
          // Wait 30 seconds before ending the game to allow for reconnection
          setTimeout(() => {
            const currentRoom = this.rooms[code];
            if (currentRoom && currentRoom.status === "playing" && currentRoom.players[disconnectedUid]) {
              // Check if they are still disconnected (socketId didn't update to a new connected socket)
              if (!currentRoom.players[disconnectedUid].connected && currentRoom.players[disconnectedUid].socketId === socket.id) {
                const isPlayer1 = disconnectedUid === playerKeys[0];
                const winner = isPlayer1 ? "player2" : "player1";
                
                if (currentRoom.gameState) {
                  currentRoom.gameState.playerLeft = isPlayer1 ? "player1" : "player2";
                }
                
                console.log(`[SNAKE SERVER] Player ${disconnectedUid} failed to reconnect in room ${code}. Ending game.`);
                this.handleGameOver(code, winner);
              }
            }
          }, 30000);
        }
      }
    }
  }
}

module.exports = SnakeGameServer;
