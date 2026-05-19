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
      // Client sends paddle move here
      socket.on("paddle_move", ({ roomCode, playerKey, x, y }) => {
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
    
    // Initialize strikers if not present
    if (!room.gameState.strikers) {
      room.gameState.strikers = {
        player1: { x: 0.5, y: 0.75 },
        player2: { x: 0.5, y: 0.25 },
      };
    }
    
    if (!room.gameState.hits) {
      room.gameState.hits = { p1: 0, p2: 0, wall: 0 };
    }

    let lastP1Pos = { ...room.gameState.strikers.player1 };
    let lastP2Pos = { ...room.gameState.strikers.player2 };
    let broadcastCounter = 0;

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

      // Check for continuous collision processing to prevent puck getting stuck inside paddle
      let collisionProcessed = false;
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
        // Let's use generic width and height matching typical phone to calculate distance
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
          if (!collisionProcessed) {
            gameState.hits.p1++;
            collisionProcessed = true;
          }
        }

        const p2Result = this.checkPaddleCollision(gameState.strikers.player2, { x, y, vx, vy }, p2Vel, 3.5, TABLE_WIDTH, TABLE_HEIGHT);
        if (p2Result.hit) {
          x = p2Result.x; y = p2Result.y; vx = p2Result.vx; vy = p2Result.vy;
          if (!collisionProcessed) {
            gameState.hits.p2++;
            collisionProcessed = true;
          }
        }

        // Friction
        const subFriction = Math.pow(FRICTION, 1 / SUB_STEPS);
        vx *= subFriction;
        vy *= subFriction;

        gameState.puck = { x, y, vx, vy };
      }

      // Timer logic (Server managed)
      if (!room.gameState.lastTimerUpdate) {
        room.gameState.lastTimerUpdate = Date.now();
      }
      
      const now = Date.now();
      if (now - room.gameState.lastTimerUpdate >= 1000) {
        if (room.gameState.timeLeft > 0) {
          room.gameState.timeLeft -= 1;
        } else if (room.gameState.timeLeft === 0 && room.gameState.status === "playing") {
          // Time up! Decide winner based on score
          const p1Score = room.gameState.scores.player1;
          const p2Score = room.gameState.scores.player2;
          let winner = "draw";
          if (p1Score > p2Score) winner = "player1";
          else if (p2Score > p1Score) winner = "player2";
          
          room.gameState.winner = winner;
          room.gameState.status = "game_over";
          room.status = "game_over";
          this.stopGameLoop(roomCode);
        }
        room.gameState.lastTimerUpdate = now;
      }

      // Broadcast game state to room at 30 FPS instead of 60 FPS to prevent polling network overflow
      broadcastCounter++;
      if (broadcastCounter % 2 === 0) {
        this.io.to(roomCode).emit("game_state_update", gameState);
      }

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
    // Both paddle and puck are in normalized coordinates (0 to 1)
    const dx = (puck.x - paddle.x) * TABLE_WIDTH;
    const dy = (puck.y - paddle.y) * TABLE_HEIGHT;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // Increased collision radius by 15% to prevent tunneling/passing through
    const minDistance = (PADDLE_RADIUS + PUCK_RADIUS) * 1.15;

    if (distance < minDistance && distance > 0) {
      const nx = dx / distance;
      const ny = dy / distance;

      // Position Resolution: ALWAYS push puck out of paddle to resolve overlap immediately
      const newX = paddle.x + nx * ((minDistance + 2) / TABLE_WIDTH);
      const newY = paddle.y + ny * ((minDistance + 2) / TABLE_HEIGHT);

      const relVx = puck.vx - (paddleVel.x * powerMultiplier);
      const relVy = puck.vy - (paddleVel.y * powerMultiplier);

      const velAlongNormal = relVx * nx + relVy * ny;

      // If puck is already moving away from paddle center and safely outside inner overlap, don't reflect back into it
      if (velAlongNormal > 0 && distance > minDistance * 0.9) {
        return {
          hit: true,
          x: newX,
          y: newY,
          vx: puck.vx,
          vy: puck.vy
        };
      }

      // Restitution (bounciness) and impulse
      const restitution = 0.8;
      const impulse = -(1 + restitution) * velAlongNormal;

      // Add momentum from the paddle hit
      const pushFactor = (minDistance - distance) / minDistance;
      const baseHitVelocity = 0.015;

      let newVx = puck.vx + nx * impulse + nx * pushFactor * baseHitVelocity;
      let newVy = puck.vy + ny * impulse + ny * pushFactor * baseHitVelocity;

      // Clamp speed to prevent extreme velocities (matching client MAX_SPEED_NORMALIZED = 0.06)
      const speed = Math.sqrt(newVx * newVx + newVy * newVy);
      const MAX_SPEED_NORMALIZED = 0.06;
      if (speed > MAX_SPEED_NORMALIZED) {
        newVx = (newVx / speed) * MAX_SPEED_NORMALIZED;
        newVy = (newVy / speed) * MAX_SPEED_NORMALIZED;
      }

      return {
        hit: true,
        x: newX,
        y: newY,
        vx: newVx,
        vy: newVy
      };
    }
    return { hit: false };
  }

  handleGoal(roomCode, scoringPlayer) {
    const room = this.rooms[roomCode];
    if (!room || !room.gameState) return;

    room.gameState.scores[scoringPlayer]++;
    
    // Reset puck to center, stationary
    room.gameState.puck = { x: 0.5, y: 0.5, vx: 0, vy: 0 };
    
    // Server doesn't check win condition, it just emits a score.
    // Client timer or score logic handles the game over?
    // Actually, client has a timer. We should let client decide game over or server?
    // Let's just update score and let clients decide, or we broadcast score update.
    
    this.io.to(roomCode).emit("game_state_update", room.gameState);
  }
}

module.exports = AirHockeyGameServer;
