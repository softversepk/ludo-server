const { AI_DIFFICULTY } = require('./utils/gameConstants');
const RewardServiceServer = require('./rewardServiceServer');

const TABLE_WIDTH = 300;
const TABLE_HEIGHT = 500;
const PUCK_RADIUS = 15;
const PADDLE_RADIUS = 25;
const GOAL_WIDTH = 120;
const MAX_SPEED = 0.05;

class AirHockeyServer {
  constructor(io, admin) {
    this.io = io;
    this.admin = admin;
    this.rooms = new Map(); // Room state
    this.activeLoops = new Map(); // Intervals for physics loops
  }

  initialize() {
    this.io.on('connection', (socket) => {
      socket.on('join_air_hockey', (data) => {
        this.handleJoinRoom(socket, data);
      });

      socket.on('paddle_move', (data) => {
        this.handlePaddleMove(socket, data);
      });

      socket.on('leave_air_hockey', (data) => {
        this.handleLeaveRoom(socket, data);
      });

      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });
    });
  }

  handleJoinRoom(socket, data) {
    const { roomId, userId, role, isBot, botData, betAmount } = data;
    if (!roomId) return;

    socket.join(roomId);

    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        roomId,
        players: { player1: null, player2: null },
        sockets: { player1: null, player2: null },
        state: {
          puck: { x: 0.5, y: 0.5, vx: 0, vy: 0 },
          strikers: {
            player1: { x: 0.5, y: 0.75 },
            player2: { x: 0.5, y: 0.25 },
          },
          scores: { player1: 0, player2: 0 },
          timeLeft: 180,
          status: 'playing',
          winner: null,
          betAmount: betAmount || 0,
        },
        physics: {
          lastP1Pos: { x: 0.5, y: 0.75 },
          lastP2Pos: { x: 0.5, y: 0.25 },
          p1Vel: { x: 0, y: 0 },
          p2Vel: { x: 0, y: 0 },
          puckHistory: [],
          puckStationaryStartRef: 0
        },
        isBotMatch: false,
        botData: null
      };
      this.rooms.set(roomId, room);
    }

    if (role === 'player1') {
      room.players.player1 = userId;
      room.sockets.player1 = socket.id;
      if (isBot) {
        room.isBotMatch = true;
        room.botData = botData;
        room.players.player2 = 'bot'; // Mock player2 for bot
      }
    } else if (role === 'player2') {
      room.players.player2 = userId;
      room.sockets.player2 = socket.id;
      if (isBot) {
        room.isBotMatch = true;
        room.botData = botData;
      }
    }

    // Start loop if both players are present, or if player1 and player2 is a bot
    if ((room.players.player1 && room.players.player2) || (room.players.player1 && room.isBotMatch)) {
      if (!this.activeLoops.has(roomId)) {
        this.startPhysicsLoop(roomId);
      }
    }
  }

  handlePaddleMove(socket, data) {
    const { roomId, role, x, y } = data;
    const room = this.rooms.get(roomId);
    if (!room || room.state.status !== 'playing') return;

    // Secure validation: Reject invalid types
    if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) return;

    // Security check: Rate Limiting to prevent DoS attacks / packet flooding
    const now = Date.now();
    if (!room.lastMoveTimes) room.lastMoveTimes = {};
    const lastTime = room.lastMoveTimes[socket.id] || 0;
    if (now - lastTime < 10) return; // Max 100 updates per second per client
    room.lastMoveTimes[socket.id] = now;

    // Secure validation: Clamp coordinates to prevent hacking
    const PADDLE_RAD_X = PADDLE_RADIUS / TABLE_WIDTH;
    const PADDLE_RAD_Y = PADDLE_RADIUS / TABLE_HEIGHT;

    let clampedX = Math.max(PADDLE_RAD_X, Math.min(1 - PADDLE_RAD_X, x));
    let clampedY = y;

    // Additionally check if socket matches the role
    if (role === 'player1' && room.sockets.player1 === socket.id) {
      // Player 1 can only move in the bottom half (y: 0.5 to 1.0)
      clampedY = Math.max(0.5 + PADDLE_RAD_Y, Math.min(1 - PADDLE_RAD_Y, y));
      room.state.strikers.player1 = { x: clampedX, y: clampedY };
    } else if (role === 'player2' && !room.isBotMatch && room.sockets.player2 === socket.id) {
      // Player 2 can only move in the top half (y: 0.0 to 0.5)
      clampedY = Math.max(PADDLE_RAD_Y, Math.min(0.5 - PADDLE_RAD_Y, y));
      room.state.strikers.player2 = { x: clampedX, y: clampedY };
    } else {
      return; // Ignore unauthorized moves
    }
    
    // Broadcast opponent move instantly for smooth paddle rendering on client
    socket.to(roomId).emit('opponent_paddle_move', { playerKey: role, x: clampedX, y: clampedY });
  }

  handleLeaveRoom(socket, data) {
    const { roomId, userId } = data;
    const room = this.rooms.get(roomId);
    if (!room) return;

    // Security check: Only allow the correct socket to forfeit
    if (room.sockets.player1 === socket.id && room.players.player1 === userId) {
      this.endGame(roomId, userId, 'forfeit');
    } else if (room.sockets.player2 === socket.id && room.players.player2 === userId) {
      this.endGame(roomId, userId, 'forfeit');
    }
  }

  handleDisconnect(socket) {
    // Find room the socket was in
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.sockets.player1 === socket.id) {
        this.endGame(roomId, room.players.player1, 'disconnect');
      } else if (room.sockets.player2 === socket.id) {
        this.endGame(roomId, room.players.player2, 'disconnect');
      }
    }
  }

  startPhysicsLoop(roomId) {
    const PHYSICS_FPS = 60;
    const INTERVAL_MS = 1000 / PHYSICS_FPS;
    const BROADCAST_INTERVAL = 16; // ~60 FPS broadcast for ultra-smooth and immediate updates
    let lastBroadcast = Date.now();
    let lastTick = Date.now();
    let lastCountdownTick = Date.now();

    const loop = setInterval(() => {
      const room = this.rooms.get(roomId);
      if (!room || room.state.status !== 'playing') {
        clearInterval(loop);
        this.activeLoops.delete(roomId);
        return;
      }

      const now = Date.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;

      // Handle 1-second countdown
      if (now - lastCountdownTick >= 1000) {
         room.state.timeLeft -= 1;
         lastCountdownTick += 1000;
         if (room.state.timeLeft <= 0) {
            this.endGameByTime(roomId);
            return;
         }
      }

      this.updatePhysics(roomId);

      if (now - lastBroadcast > BROADCAST_INTERVAL) {
        this.io.to(roomId).emit('air_hockey_state_update', room.state);
        lastBroadcast = now;
      }

    }, INTERVAL_MS);

    this.activeLoops.set(roomId, loop);
  }

  updatePhysics(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const SUB_STEPS = 6;
    const state = room.state;
    const phys = room.physics;

    const currP1 = state.strikers.player1;
    const currP2 = state.strikers.player2;

    phys.p1Vel = {
      x: (currP1.x - phys.lastP1Pos.x),
      y: (currP1.y - phys.lastP1Pos.y),
    };
    phys.p2Vel = {
      x: (currP2.x - phys.lastP2Pos.x),
      y: (currP2.y - phys.lastP2Pos.y),
    };

    // Bot Logic (Run once per frame before sub-steps)
    if (room.isBotMatch) {
      const REACTION_DELAY_MS = 150;
      const LERP_SPEED = 0.25; // Increased bot speed so it can actually hit the ball
      
      phys.puckHistory.push({ x: state.puck.x, y: state.puck.y, time: Date.now() });
      if (phys.puckHistory.length > 20) phys.puckHistory.shift();

      const delayedPuck = phys.puckHistory.find(
        (p) => p.time >= Date.now() - REACTION_DELAY_MS,
      ) || { x: state.puck.x, y: state.puck.y };

      let targetX = 0.5;
      let targetY = 0.15;

      const isPuckStationaryInReach = Math.abs(state.puck.vx) < 0.001 && Math.abs(state.puck.vy) < 0.001 && state.puck.y <= 0.55;
      if (isPuckStationaryInReach) {
        if (phys.puckStationaryStartRef === 0) {
          phys.puckStationaryStartRef = Date.now();
        }
      } else {
        phys.puckStationaryStartRef = 0;
      }

      const shouldBotStartHit = isPuckStationaryInReach && phys.puckStationaryStartRef > 0 && (Date.now() - phys.puckStationaryStartRef > 1000);

      if (state.puck.y < 0.60 || shouldBotStartHit) { // Bot reacts slightly sooner
        targetX = delayedPuck.x;
        targetY = delayedPuck.y;
      }

      const currentAiX = state.strikers.player2.x;
      const currentAiY = state.strikers.player2.y;

      let nextAiX = currentAiX + (targetX - currentAiX) * LERP_SPEED;
      let nextAiY = currentAiY + (targetY - currentAiY) * LERP_SPEED;

      nextAiY = Math.max(
        PADDLE_RADIUS / TABLE_HEIGHT,
        Math.min(0.48, nextAiY),
      );

      state.strikers.player2 = { x: nextAiX, y: nextAiY };
      
      // Update bot velocity for this frame based on the new target
      phys.p2Vel = {
        x: (state.strikers.player2.x - phys.lastP2Pos.x),
        y: (state.strikers.player2.y - phys.lastP2Pos.y),
      };
    }

    // Interpolate positions across sub-steps to prevent tunneling
    let p1SubPos = { x: phys.lastP1Pos.x, y: phys.lastP1Pos.y };
    let p2SubPos = { x: phys.lastP2Pos.x, y: phys.lastP2Pos.y };

    for (let step = 0; step < SUB_STEPS; step++) {
      let { x, y, vx, vy } = state.puck;

      x += vx / SUB_STEPS;
      y += vy / SUB_STEPS;

      p1SubPos.x += phys.p1Vel.x / SUB_STEPS;
      p1SubPos.y += phys.p1Vel.y / SUB_STEPS;
      p2SubPos.x += phys.p2Vel.x / SUB_STEPS;
      p2SubPos.y += phys.p2Vel.y / SUB_STEPS;

      // Wall Collisions
      const minX = PUCK_RADIUS / TABLE_WIDTH;
      const maxX = 1 - minX;
      const minY = PUCK_RADIUS / TABLE_HEIGHT;
      const maxY = 1 - minY;

      if (x <= minX || x >= maxX) {
        vx = -vx * 0.9;
        x = Math.max(minX, Math.min(maxX, x));
        this.io.to(roomId).emit('air_hockey_hit_wall');
      }

      if (y <= minY || y >= maxY) {
        const goalRange = GOAL_WIDTH / 2 / TABLE_WIDTH;
        const isInGoalRange = x > 0.5 - goalRange && x < 0.5 + goalRange;

        if (isInGoalRange) {
          if (y <= 0 || y >= 1) {
            this.handleGoal(roomId, y <= 0 ? "player1" : "player2");
            return;
          }
        } else {
          vy = -vy * 0.9;
          y = Math.max(minY, Math.min(maxY, y));
          this.io.to(roomId).emit('air_hockey_hit_wall');
        }
      }

      // Paddle Collisions (using interpolated sub-step positions to prevent tunneling)
      const p1Result = this.checkPaddleCollision(
        p1SubPos,
        { x, y, vx, vy },
        phys.p1Vel,
        1.2
      );
      if (p1Result.hit || (p1Result.x !== x || p1Result.y !== y)) {
        x = p1Result.x;
        y = p1Result.y;
        vx = p1Result.vx;
        vy = p1Result.vy;
        
        if (p1Result.hit) {
          this.io.to(roomId).emit('air_hockey_hit_paddle', { player: 'player1' });
        }
      }

      const p2Result = this.checkPaddleCollision(
        p2SubPos,
        { x, y, vx, vy },
        phys.p2Vel,
        1.2
      );
      if (p2Result.hit || (p2Result.x !== x || p2Result.y !== y)) {
        x = p2Result.x;
        y = p2Result.y;
        vx = p2Result.vx;
        vy = p2Result.vy;

        if (p2Result.hit) {
          this.io.to(roomId).emit('air_hockey_hit_paddle', { player: 'player2' });
        }
      }

      // Friction
      vx *= 0.999;
      vy *= 0.999;

      // Max Speed limit
      const speed = Math.sqrt(vx * vx + vy * vy);
      if (speed > MAX_SPEED) {
        vx = (vx / speed) * MAX_SPEED;
        vy = (vy / speed) * MAX_SPEED;
      }
      
      // Stop completely if very slow
      if (Math.abs(vx) < 0.0001) vx = 0;
      if (Math.abs(vy) < 0.0001) vy = 0;

      state.puck = { x, y, vx, vy };
    }

    phys.lastP1Pos = { ...state.strikers.player1 };
    phys.lastP2Pos = { ...state.strikers.player2 };
  }

  checkPaddleCollision(paddle, puck, paddleVel = { x: 0, y: 0 }, customHitPower = 1.2) {
    const dx = (puck.x - paddle.x) * TABLE_WIDTH;
    const dy = (puck.y - paddle.y) * TABLE_HEIGHT;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Add an extra buffer to the minimum distance so the collision box is completely solid
    const minDist = PUCK_RADIUS + PADDLE_RADIUS + 5; 

    if (dist < minDist) {
      const nx = dx / dist;
      const ny = dy / dist;

      // Force puck completely out of paddle radius (using 1.05 multiplier to absolutely guarantee separation)
      const separationDist = minDist * 1.05;
      const newX = paddle.x + (nx * separationDist) / TABLE_WIDTH;
      const newY = paddle.y + (ny * separationDist) / TABLE_HEIGHT;

      // Calculate relative velocity (puck velocity - paddle velocity)
      const relVx = puck.vx - paddleVel.x;
      const relVy = puck.vy - paddleVel.y;
      const dot = relVx * nx + relVy * ny;

      if (dot > 0) {
        // If moving away relatively, STILL push it out to prevent sticking, but don't add hit power
        // This is the CRITICAL fix for the ball passing through: always apply the newX/newY position resolution
        return { ...puck, x: newX, y: newY, hit: false }; 
      }

      // Reflect velocity based on normal
      let newVx = puck.vx - 2 * (puck.vx * nx + puck.vy * ny) * nx;
      let newVy = puck.vy - 2 * (puck.vx * nx + puck.vy * ny) * ny;

      const BASE_BOUNCE = 0.005;
      newVx += nx * BASE_BOUNCE;
      newVy += ny * BASE_BOUNCE;

      // Transfer momentum from paddle (now paddleVel is correctly per-frame)
      const transferPower = 0.8 * customHitPower;
      newVx += paddleVel.x * transferPower;
      newVy += paddleVel.y * transferPower;

      return { x: newX, y: newY, vx: newVx, vy: newVy, hit: true };
    }
    return { hit: false };
  }

  handleGoal(roomId, playerKey) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (playerKey === 'player1') {
      room.state.scores.player2 += 1;
    } else {
      room.state.scores.player1 += 1;
    }

    this.io.to(roomId).emit('air_hockey_goal', { 
      scoredBy: playerKey === 'player1' ? 'player2' : 'player1',
      scores: room.state.scores
    });

    if (room.state.scores.player1 >= 7 || room.state.scores.player2 >= 7) {
      this.endGame(roomId, null, 'score');
    } else {
      // Reset puck
      room.state.puck = { x: 0.5, y: 0.5, vx: 0, vy: 0 };
      room.physics.puckHistory = [];
    }
  }

  endGameByTime(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    if (room.state.scores.player1 > room.state.scores.player2) {
      this.endGame(roomId, null, 'time', 'player1');
    } else if (room.state.scores.player2 > room.state.scores.player1) {
      this.endGame(roomId, null, 'time', 'player2');
    } else {
      this.endGame(roomId, null, 'time', 'draw');
    }
  }

  async endGame(roomId, disconnectedUserId, reason, specificWinner = null) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    let winnerRole = 'draw';
    
    if (reason === 'forfeit' || reason === 'disconnect') {
      if (disconnectedUserId === room.players.player1) {
        winnerRole = 'player2';
      } else if (disconnectedUserId === room.players.player2) {
        winnerRole = 'player1';
      }
    } else if (reason === 'score') {
      winnerRole = room.state.scores.player1 > room.state.scores.player2 ? 'player1' : 'player2';
    } else if (reason === 'time') {
      winnerRole = specificWinner;
    }

    room.state.status = 'game_over';
    room.state.winner = winnerRole;

    this.io.to(roomId).emit('air_hockey_game_over', {
      winner: winnerRole,
      scores: room.state.scores,
      reason
    });

    clearInterval(this.activeLoops.get(roomId));
    this.activeLoops.delete(roomId);

    // Give rewards
    if (winnerRole !== 'draw' && !room.isBotMatch) {
      const winnerUserId = winnerRole === 'player1' ? room.players.player1 : room.players.player2;
      const loserUserId = winnerRole === 'player1' ? room.players.player2 : room.players.player1;
      
      try {
        await RewardServiceServer.processGameWin(this.admin, {
          userId: winnerUserId,
          gameType: 'AIR_HOCKEY',
          betAmount: room.state.betAmount
        });
      } catch (err) {
        console.error('Error awarding game win for Air Hockey:', err);
      }
    }

    // Clean up room
    setTimeout(() => {
      this.rooms.delete(roomId);
    }, 10000); // Keep room state around for a bit for clients to read
  }
}

module.exports = AirHockeyServer;
