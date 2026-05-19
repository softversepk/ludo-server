const { Server } = require("socket.io");

const PHYSICS_FPS = 60;
const SUB_STEPS = 6;
const INTERVAL_MS = 1000 / PHYSICS_FPS;

// Game Constants (matching client)
const PUCK_RADIUS = 15;
const PADDLE_RADIUS = 25;
// Table size is normalized on server (0.0 to 1.0)
const GOAL_WIDTH_NORMALIZED = 0.4;
const FRICTION = 0.99;

class AirHockeyGameServer {
  constructor(io, rooms) {
    this.io = io;
    this.rooms = rooms; // Reference to global rooms object
    this.gameLoops = {}; // Store active intervals
  }

  initialize() {
    this.io.on("connection", (socket) => {
      // Handle start air hockey game specifically if needed,
      // but usually index.js handles start_game.
      // We will hook into paddle_move and start_game externally.
      
      socket.on("air_hockey_paddle_move", ({ roomCode, playerKey, x, y }) => {
        const room = this.rooms[roomCode];
        if (room && room.gameState && room.gameState.strikers) {
          // Normalize paddle positions
          room.gameState.strikers[playerKey] = { x, y };
          
          // Optionally broadcast opponent paddle move immediately to reduce perceived lag
          socket.to(roomCode).emit("opponent_paddle_move", { playerKey, x, y });
        }
      });
    });
  }

  // Called from index.js when a game starts
  startGameLoop(roomCode) {
    if (this.gameLoops[roomCode]) return; // Already running

    const room = this.rooms[roomCode];
    if (!room || !room.gameState) return;

    // Initialize puck if not present
    if (!room.gameState.puck) {
      room.gameState.puck = { x: 0.5, y: 0.5, vx: 0, vy: 0 };
    }
    
    room.gameState.hits = { p1: 0, p2: 0, wall: 0 };

    let lastP1Pos = { ...room.gameState.strikers.player1 };
    let lastP2Pos = { ...room.gameState.strikers.player2 };

    const loop = setInterval(() => {
      if (!this.rooms[roomCode] || this.rooms[roomCode].status !== "playing") {
        this.stopGameLoop(roomCode);
        return;
      }

      const gameState = this.rooms[roomCode].gameState;
      if (!gameState || !gameState.strikers || !gameState.strikers.player1 || !gameState.strikers.player2) {
        return;
      }

      const currP1 = gameState.strikers.player1;
      const currP2 = gameState.strikers.player2;

      // Server calculates velocity
      const p1Vel = {
        x: (currP1.x - lastP1Pos.x) / SUB_STEPS,
        y: (currP1.y - lastP1Pos.y) / SUB_STEPS,
      };
      const p2Vel = {
        x: (currP2.x - lastP2Pos.x) / SUB_STEPS,
        y: (currP2.y - lastP2Pos.y) / SUB_STEPS,
      };

      lastP1Pos = { ...currP1 };
      lastP2Pos = { ...currP2 };

      for (let step = 0; step < SUB_STEPS; step++) {
        if (!gameState.puck) continue;

        let { x, y, vx, vy } = gameState.puck;

        x += vx / SUB_STEPS;
        y += vy / SUB_STEPS;

        // Wall collisions - Assuming TABLE_WIDTH = 1.0 (normalized)
        // Client uses PUCK_RADIUS / TABLE_WIDTH. Let's approximate based on typical screen
        // Say aspect ratio is roughly 0.6 / 0.9.
        // We'll just use the exact math from the client.
        // But server doesn't know TABLE_WIDTH. We assume TABLE_WIDTH = 1.0, TABLE_HEIGHT = 1.0 in normalized coordinates.
        // Actually, client sends normalized (0 to 1). So radius in normalized is roughly:
        const TABLE_WIDTH = 400; // arbitrary reference for radius scaling
        const TABLE_HEIGHT = 600;
        const minX = PUCK_RADIUS / TABLE_WIDTH;
        const maxX = 1 - minX;
        const minY = PUCK_RADIUS / TABLE_HEIGHT;
        const maxY = 1 - minY;

        if (x <= minX || x >= maxX) {
          vx = -vx * 0.9;
          x = Math.max(minX, Math.min(maxX, x));
          gameState.hits.wall++;
        }

        if (y <= minY || y >= maxY) {
          const goalRange = GOAL_WIDTH_NORMALIZED / 2;
          const isInGoalRange = x > 0.5 - goalRange && x < 0.5 + goalRange;

          if (isInGoalRange) {
            if (y <= 0 || y >= 1) {
              // Goal
              this.handleGoal(roomCode, y <= 0 ? "player1" : "player2");
              return;
            }
          } else {
            vy = -vy * 0.9;
            y = Math.max(minY, Math.min(maxY, y));
            gameState.hits.wall++;
          }
        }

        // Paddle collisions
        const p1Result = this.checkPaddleCollision(gameState.strikers.player1, { x, y, vx, vy }, p1Vel, 1.5, TABLE_WIDTH, TABLE_HEIGHT);
        if (p1Result.hit) {
          x = p1Result.x; y = p1Result.y; vx = p1Result.vx; vy = p1Result.vy;
          gameState.hits.p1++;
        }

        const p2Result = this.checkPaddleCollision(gameState.strikers.player2, { x, y, vx, vy }, p2Vel, 3.5, TABLE_WIDTH, TABLE_HEIGHT);
        if (p2Result.hit) {
          x = p2Result.x; y = p2Result.y; vx = p2Result.vx; vy = p2Result.vy;
          gameState.hits.p2++;
        }

        // Friction
        const subFriction = Math.pow(FRICTION, 1 / SUB_STEPS);
        vx *= subFriction;
        vy *= subFriction;

        gameState.puck = { x, y, vx, vy };
      }

      // Broadcast game state to room
      this.io.to(roomCode).emit("game_state_update", gameState);

    }, INTERVAL_MS);

    this.gameLoops[roomCode] = loop;
  }

  stopGameLoop(roomCode) {
    if (this.gameLoops[roomCode]) {
      clearInterval(this.gameLoops[roomCode]);
      delete this.gameLoops[roomCode];
    }
  }

  checkPaddleCollision(paddle, puck, paddleVel, powerMultiplier, TABLE_WIDTH, TABLE_HEIGHT) {
    // Math matching client side
    // Both paddle and puck are in normalized coordinates (0 to 1)
    const dx = (puck.x - paddle.x) * TABLE_WIDTH;
    const dy = (puck.y - paddle.y) * TABLE_HEIGHT;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    const minDistance = PADDLE_RADIUS + PUCK_RADIUS;

    if (distance < minDistance && distance > 0) {
      const nx = dx / distance;
      const ny = dy / distance;

      const relVx = puck.vx - (paddleVel.x * powerMultiplier);
      const relVy = puck.vy - (paddleVel.y * powerMultiplier);

      const velAlongNormal = relVx * nx + relVy * ny;

      if (velAlongNormal < 0) {
        const restitution = 0.8; // Bounciness
        const impulse = -(1 + restitution) * velAlongNormal;

        const pushFactor = (minDistance - distance) / minDistance;
        const baseHitVelocity = 0.015;

        return {
          hit: true,
          x: paddle.x + nx * (minDistance / TABLE_WIDTH),
          y: paddle.y + ny * (minDistance / TABLE_HEIGHT),
          vx: puck.vx + nx * impulse + nx * pushFactor * baseHitVelocity,
          vy: puck.vy + ny * impulse + ny * pushFactor * baseHitVelocity
        };
      }
    }
    return { hit: false };
  }

  handleGoal(roomCode, scoringPlayer) {
    const room = this.rooms[roomCode];
    if (!room || !room.gameState) return;

    room.gameState.scores[scoringPlayer]++;
    
    // Reset puck to center, stationary
    room.gameState.puck = { x: 0.5, y: 0.5, vx: 0, vy: 0 };
    
    // Check win condition
    if (room.gameState.scores[scoringPlayer] >= 7) { // Example win score
      room.gameState.winner = scoringPlayer;
      room.gameState.status = "game_over";
      room.status = "game_over";
      this.stopGameLoop(roomCode);
    } else {
      room.gameState.status = "playing"; // Or "goal" briefly
    }
    
    this.io.to(roomCode).emit("game_state_update", room.gameState);
  }
}

module.exports = AirHockeyGameServer;
