const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const LudoGameServer = require("./ludoGameServer");
const ClubChatServer = require("./clubChatServer");
const LeaderboardServer = require("./leaderboardServer");

const app = express();

// Production CORS configuration
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? [
        "https://yourdomain.com", // APK domain add karo
        "https://multi-games-server.onrender.com" // Server domain
      ]
    : [
        "http://localhost:3000", 
        "http://192.168.2.109:3000",
        "http://192.168.2.103:3000"
      ],
  methods: ["GET", "POST"],
  credentials: true
};

app.use(cors(corsOptions));

// Health check endpoint for monitoring
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime()
  });
});

// Server stats endpoint
app.get('/stats', (req, res) => {
  res.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    connections: io ? io.engine.clientsCount : 0,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// In-memory store for rooms
const rooms = {};

// Global userId → socketId map (always up-to-date even after reconnects)
const userSockets = {};

// Global userId → roomCode map (to rejoin rooms after reconnect)
const userRooms = {};

// Grace-period timers: roomCode → setTimeout id
// Rooms in "game_over" state are kept alive briefly so late updates don't error
const roomDeleteTimers = {};

// Helper: schedule a room for deletion after a grace period
const scheduleRoomDelete = (roomCode, delayMs = 30000) => {
  if (roomDeleteTimers[roomCode]) clearTimeout(roomDeleteTimers[roomCode]);
  roomDeleteTimers[roomCode] = setTimeout(() => {
    delete rooms[roomCode];
    delete roomDeleteTimers[roomCode];
    console.log(`[CLEANUP] Room ${roomCode} deleted after grace period`);
  }, delayMs);
};

// Initialize Ludo Game Server
const ludoGameServer = new LudoGameServer(io);
ludoGameServer.initialize();
ludoGameServer.startConnectionMonitoring();

console.log("✅ Ludo Game Server initialized with real-time Socket.IO sync");

// Initialize Club Chat Server
const clubChatServer = new ClubChatServer(io);
clubChatServer.initialize();

console.log("✅ Club Chat Server initialized with real-time messaging");

// Initialize Leaderboard Server
const leaderboardServer = new LeaderboardServer(io);
leaderboardServer.initialize();

console.log("✅ Leaderboard Server initialized with real-time rankings");

// Helper to generate room code
const generateRoomCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Client registers its userId right after connecting so we always have
  // the latest socketId even after a reconnect
  socket.on("register_user", (userId) => {
    if (!userId) return;
    userSockets[userId] = socket.id;
    console.log(`[REGISTER] ${userId} → socket ${socket.id}`);

    // Auto-rejoin any room this user was in
    const roomCode = userRooms[userId];
    if (roomCode && rooms[roomCode]) {
      socket.join(roomCode);
      // Update socketId in room players
      if (rooms[roomCode].players[userId]) {
        rooms[roomCode].players[userId].socketId = socket.id;
      }
      console.log(
        `[AUTO-REJOIN] ${userId} rejoined room ${roomCode} on register`,
      );
    }
  });

  // Explicit rejoin_room event (called by client on reconnect)
  socket.on("rejoin_room", ({ roomCode, userId }) => {
    if (!roomCode || !userId) return;
    const room = rooms[roomCode];
    if (room) {
      socket.join(roomCode);
      userRooms[userId] = roomCode;
      userSockets[userId] = socket.id;
      if (room.players[userId]) {
        room.players[userId].socketId = socket.id;
      }
      console.log(
        `[REJOIN] ${userId} explicitly rejoined room ${roomCode}, socket ${socket.id}`,
      );
    } else {
      console.log(`[REJOIN] Room ${roomCode} not found for user ${userId}`);
    }
  });

  // CREATE ROOM
  socket.on("create_room", (hostData, callback) => {
    const roomCode = generateRoomCode();

    // Ensure defaults
    const rules = {
      playerCount: hostData.playerCount || 4,
      maxPlayers: hostData.maxPlayers || 4,
      betAmount: hostData.betAmount || 100,
      mode: hostData.mode || "online_random",
      isTeam: hostData.isTeam || false,
    };

    rooms[roomCode] = {
      roomCode,
      host: hostData.uid,
      status: "waiting",
      ...rules,
      createdAt: Date.now(),
      players: {
        [hostData.uid]: {
          uid: hostData.uid,
          username: hostData.username || "Host",
          avatar: hostData.avatar || "default",
          ready: false,
          joinedAt: Date.now(),
          socketId: socket.id,
        },
      },
      gameState: null,
    };

    socket.join(roomCode);
    if (hostData.uid) {
      userRooms[hostData.uid] = roomCode;
      userSockets[hostData.uid] = socket.id;
    }
    console.log(`Room ${roomCode} created by ${hostData.username}`);

    // Send back success
    if (callback) callback({ success: true, roomCode });

    // Broadcast update to room (only host for now)
    io.to(roomCode).emit("room_update", rooms[roomCode]);
  });

  // JOIN ROOM
  socket.on("join_room", ({ roomCode, playerData }, callback) => {
    const room = rooms[roomCode];
    if (!room) {
      if (callback) callback({ success: false, error: "Room not found" });
      return;
    }

    const currentCount = Object.keys(room.players).length;
    if (currentCount >= room.maxPlayers) {
      if (callback) callback({ success: false, error: "Room is full" });
      return;
    }

    if (room.status === "playing") {
      if (callback) callback({ success: false, error: "Game already started" });
      return;
    }

    // Add player
    room.players[playerData.uid] = {
      ...playerData,
      ready: false,
      joinedAt: Date.now(),
      socketId: socket.id,
    };

    socket.join(roomCode);
    if (playerData.uid) {
      userRooms[playerData.uid] = roomCode;
      userSockets[playerData.uid] = socket.id;
    }
    console.log(`Player ${playerData.username} joined room ${roomCode}`);

    if (callback) callback({ success: true });

    // Broadcast update to everyone in room
    io.to(roomCode).emit("room_update", room);
  });

  // GET ROOM
  socket.on("get_room", (roomCode, callback) => {
    const room = rooms[roomCode];
    if (callback) callback(room);
  });

  // SET READY
  socket.on("set_ready", ({ roomCode, playerId, ready }) => {
    const room = rooms[roomCode];
    if (room && room.players[playerId]) {
      room.players[playerId].ready = ready;
      io.to(roomCode).emit("room_update", room);
    }
  });

  // FIND MATCH
  socket.on("find_match", (playerData, callback) => {
    console.log("Searching for match for:", playerData.username);
    const { mode, betAmount } = playerData;

    let joinedRoomCode = null;

    // Iterate through rooms to find a match
    for (const [code, room] of Object.entries(rooms)) {
      if (!room) continue;

      const currentCount = Object.keys(room.players).length;
      const maxPlayers = room.maxPlayers;
      const hasSpace = currentCount < maxPlayers;
      const isWaiting = room.status === "waiting";
      const modeMatches =
        !room.mode ||
        room.mode === mode ||
        (mode === "tictactoe" && room.mode === "tictactoe");
      const betMatches = (room.betAmount || 100) === betAmount;
      const notOwnRoom = room.host !== playerData.uid;

      // Simple matching logic
      if (hasSpace && isWaiting && modeMatches && betMatches && notOwnRoom) {
        joinedRoomCode = code;
        break;
      }
    }

    if (joinedRoomCode) {
      console.log(`Found match in room ${joinedRoomCode}`);

      // Add player to room logic (duplicate of join_room logic for internal use)
      const room = rooms[joinedRoomCode];
      room.players[playerData.uid] = {
        ...playerData,
        ready: false,
        joinedAt: Date.now(),
        socketId: socket.id,
      };
      socket.join(joinedRoomCode);

      if (playerData.uid) {
        userRooms[playerData.uid] = joinedRoomCode;
        userSockets[playerData.uid] = socket.id;
      }
      if (callback)
        callback({ success: true, roomCode: joinedRoomCode, joined: true });
      io.to(joinedRoomCode).emit("room_update", room);
    } else {
      // Create a new room if no match found
      console.log("No match found, creating new room...");
      // Reuse create room logic logic
      const roomCode = generateRoomCode();
      const rules = {
        playerCount: playerData.playerCount || 2, // Default for matchmaking usually 2 or 4
        maxPlayers: playerData.playerCount || playerData.maxPlayers || 2,
        betAmount: playerData.betAmount || 100,
        mode: playerData.mode || "online_random",
        isTeam: playerData.isTeam || false,
      };

      rooms[roomCode] = {
        roomCode,
        host: playerData.uid,
        status: "waiting",
        ...rules,
        createdAt: Date.now(),
        players: {
          [playerData.uid]: {
            ...playerData,
            ready: false,
            joinedAt: Date.now(),
            socketId: socket.id,
          },
        },
        gameState: null,
      };

      socket.join(roomCode);
      if (playerData.uid) {
        userRooms[playerData.uid] = roomCode;
        userSockets[playerData.uid] = socket.id;
      }
      if (callback)
        callback({ success: true, roomCode, joined: false, created: true });
      io.to(roomCode).emit("room_update", rooms[roomCode]);
    }
  });

  // CANCEL MATCHMAKING
  socket.on("cancel_matchmaking", (roomCode) => {
    const room = rooms[roomCode];
    if (room) {
      console.log(`Matchmaking cancelled for room ${roomCode}`);
      io.to(roomCode).emit("room_cancelled");
      delete rooms[roomCode];
      socket.leave(roomCode);
    }
  });

  // LEAVE ROOM
  socket.on("leave_room", ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (room && room.players[playerId]) {
      delete room.players[playerId];
      socket.leave(roomCode);

      // If room is empty, delete it
      if (Object.keys(room.players).length === 0) {
        delete rooms[roomCode];
      } else {
        // If host left, assign new host? For now just remove player
        if (room.host === playerId) {
          const remaining = Object.keys(room.players);
          if (remaining.length > 0) room.host = remaining[0];
        }
        io.to(roomCode).emit("room_update", room);
      }
    }
  });

  // UPDATE GAME STATE (Full)
  socket.on("update_game_state", ({ roomCode, gameState }, callback) => {
    const room = rooms[roomCode];
    if (room) {
      // If the game already has a winner recorded on the server, ignore further
      // updates silently — they are late-arriving moves from game loops.
      const alreadyOver =
        room.gameState?.winner ||
        room.gameState?.status === "game_over" ||
        gameState?.winner;

      room.gameState = gameState;

      // Mark room as game_over and schedule cleanup when a winner is set
      if (gameState?.winner || gameState?.status === "game_over") {
        room.status = "game_over";
        scheduleRoomDelete(roomCode, 60000); // keep room 60 s for rematch
      }

      if (!alreadyOver) {
        // Only log and broadcast while the game is still live
        const oldCurrentPlayer = room.gameState?.currentPlayer;
        if (oldCurrentPlayer && oldCurrentPlayer !== gameState.currentPlayer) {
          console.log(
            `🔄 [TURN SHIFT] Room: ${roomCode}, ${oldCurrentPlayer} → ${gameState.currentPlayer}`,
          );
        }

        io.to(roomCode).emit("game_state_update", gameState);
      } else {
        // Game already over — still broadcast once so late-joiners get final state
        io.to(roomCode).emit("game_state_update", gameState);
      }

      if (callback) {
        callback({
          success: true,
          currentPlayer: gameState.currentPlayer,
        });
      }
    } else {
      // Room not found — this is an expected race condition after game ends.
      // Respond with success so client doesn't log errors.
      if (callback)
        callback({ success: true, warning: "Room not found, update ignored" });
    }
  });

  // PADDLE MOVE (Optimized for Air Hockey)
  socket.on("paddle_move", ({ roomCode, playerKey, x, y }) => {
    const room = rooms[roomCode];
    if (room && room.gameState && room.gameState.strikers) {
      room.gameState.strikers[playerKey] = { x, y };
      // Broadcast only the paddle move to others to save bandwidth
      socket.to(roomCode).emit("opponent_paddle_move", { playerKey, x, y });
    } else {
      // console.log('Paddle move ignored - Room/State not ready', roomCode);
    }
  });

  // SNAKE TURN (Optimized for Snake Vs Snake)
  socket.on("snake_turn", ({ roomCode, playerKey, angle }) => {
    const room = rooms[roomCode];
    if (room && room.gameState && room.gameState.snakes) {
      room.gameState.snakes[playerKey].angle = angle;
      // Broadcast steering to the other player
      socket.to(roomCode).emit("snake_turn", { playerKey, angle });
    }
  });

  // START GAME
  socket.on("start_game", ({ roomCode, gameState }) => {
    const room = rooms[roomCode];
    if (room) {
      console.log(`[SERVER] Starting game for room ${roomCode}`);
      room.status = "playing";
      room.gameState = gameState;
      room.startedAt = Date.now();
      io.to(roomCode).emit("room_update", room); // To update status
      io.to(roomCode).emit("game_state_update", gameState); // Initial state
    } else {
      console.log(`[SERVER] Start game failed - room ${roomCode} not found`);
    }
  });

  // REMATCH REQUEST
  socket.on("rematch_request", ({ roomCode, requesterId, opponentId }) => {
    // Always keep userSockets up-to-date for requester
    if (requesterId) {
      userSockets[requesterId] = socket.id;
      userRooms[requesterId] = roomCode;
      socket.join(roomCode); // ensure requester is in room
    }

    console.log(`\n========== REMATCH REQUEST ==========`);
    console.log(`  Room     : ${roomCode}`);
    console.log(`  Requester: ${requesterId}`);
    console.log(`  Opponent : ${opponentId}`);
    console.log(`  Room exists: ${!!rooms[roomCode]}`);
    console.log(`  userSockets keys: ${Object.keys(userSockets).join(", ")}`);
    console.log(`  Opponent in userSockets: ${!!userSockets[opponentId]}`);
    console.log(`=====================================\n`);

    const room = rooms[roomCode];

    // Build payload from room data if possible, else use basic info
    const payload = {
      roomCode,
      requesterId,
      requesterName: room?.players?.[requesterId]?.username || "Opponent",
      requesterAvatar: room?.players?.[requesterId]?.avatar || null,
      betAmount: room?.betAmount || 0,
    };

    let delivered = false;

    // Strategy 1: fresh userSockets map (most reliable)
    const freshSocketId = userSockets[opponentId];
    if (freshSocketId) {
      io.to(freshSocketId).emit("rematch_request_received", payload);
      console.log(`[REMATCH] ✅ Strategy 1 – sent to socket ${freshSocketId}`);
      delivered = true;
    }

    // Strategy 2: room broadcast (runs ALWAYS as extra guarantee)
    if (room) {
      socket.to(roomCode).emit("rematch_request_received", payload);
      console.log(`[REMATCH] ✅ Strategy 2 – broadcast to room ${roomCode}`);
      delivered = true;
    }

    // Strategy 3: stored socketId in room player object
    if (room?.players?.[opponentId]?.socketId) {
      const storedSocketId = room.players[opponentId].socketId;
      if (storedSocketId !== freshSocketId) {
        // avoid duplicate if same as Strategy 1
        io.to(storedSocketId).emit("rematch_request_received", payload);
        console.log(
          `[REMATCH] ✅ Strategy 3 – sent to stored socket ${storedSocketId}`,
        );
        delivered = true;
      }
    }

    if (!delivered) {
      console.log(
        `[REMATCH] ❌ Could not deliver to opponent ${opponentId} — no socket found`,
      );
    }

    // Always acknowledge sender so UI shows "Waiting..."
    socket.emit("rematch_request_sent", { success: true });

    // AI Bot Auto-Accept Logic
    if (room?.players?.[opponentId]?.isBot) {
      console.log(`[REMATCH] 🤖 Opponent ${opponentId} is AI bot - auto-accepting after delay`);
      
      setTimeout(() => {
        // Check if room still exists and rematch hasn't been handled yet
        const currentRoom = rooms[roomCode];
        if (currentRoom && currentRoom.players[opponentId]?.isBot) {
          console.log(`[REMATCH] 🤖 AI bot auto-accepting rematch request`);
          
          // Simulate AI bot accepting the rematch
          const botAcceptData = {
            oldRoomCode: roomCode,
            acceptorId: opponentId,
            requesterId: requesterId
          };
          
          // Create new room for rematch (same logic as manual accept)
          const newRoomCode = generateRoomCode();
          const requesterPlayer = currentRoom.players[requesterId];
          const botPlayer = currentRoom.players[opponentId];
          
          if (requesterPlayer && botPlayer) {
            rooms[newRoomCode] = {
              roomCode: newRoomCode,
              host: requesterId,
              status: "waiting",
              playerCount: 2,
              maxPlayers: 2,
              betAmount: currentRoom.betAmount,
              mode: currentRoom.mode,
              isTeam: false,
              createdAt: Date.now(),
              players: {
                [requesterId]: {
                  ...requesterPlayer,
                  ready: false,
                  joinedAt: Date.now(),
                },
                [opponentId]: {
                  ...botPlayer,
                  ready: false,
                  joinedAt: Date.now(),
                  isBot: true,
                },
              },
              gameState: null,
            };

            // Notify requester that rematch was accepted
            const requesterSocketId = userSockets[requesterId] || requesterPlayer.socketId;
            if (requesterSocketId) {
              io.to(requesterSocketId).emit("rematch_accepted", {
                newRoomCode,
                betAmount: currentRoom.betAmount,
                players: rooms[newRoomCode].players
              });
              console.log(`[REMATCH] 🤖 AI bot rematch accepted - notified requester`);
            }
          }
        }
      }, 1500); // 1.5 second delay to simulate thinking
    }
  });

  // REMATCH ACCEPTED
  socket.on("rematch_accepted", ({ oldRoomCode, acceptorId, requesterId }) => {
    // Keep userSockets fresh
    if (acceptorId) userSockets[acceptorId] = socket.id;

    const oldRoom = rooms[oldRoomCode];
    if (!oldRoom) {
      console.log(`[REMATCH ACCEPT] Old room ${oldRoomCode} not found`);
      socket.emit("rematch_error", { reason: "Original room not found" });
      return;
    }

    const requesterPlayer = oldRoom.players[requesterId];
    const acceptorPlayer = oldRoom.players[acceptorId];

    if (!requesterPlayer || !acceptorPlayer) {
      socket.emit("rematch_error", { reason: "Players not found" });
      return;
    }

    // Create a new room for the rematch
    const newRoomCode = generateRoomCode();
    rooms[newRoomCode] = {
      roomCode: newRoomCode,
      host: requesterId,
      status: "waiting",
      playerCount: 2,
      maxPlayers: 2,
      betAmount: oldRoom.betAmount,
      mode: oldRoom.mode,
      isTeam: false,
      createdAt: Date.now(),
      players: {
        [requesterId]: {
          ...requesterPlayer,
          ready: false,
          joinedAt: Date.now(),
        },
        [acceptorId]: {
          ...acceptorPlayer,
          ready: false,
          joinedAt: Date.now(),
          socketId: socket.id,
        },
      },
      gameState: null,
    };

    // Acceptor joins new room socket channel
    socket.join(newRoomCode);

    // Requester: try fresh socketId first, then fall back to stored
    const requesterSocketId =
      userSockets[requesterId] || requesterPlayer.socketId;
    const requesterSocket = requesterSocketId
      ? io.sockets.sockets.get(requesterSocketId)
      : null;
    if (requesterSocket) {
      requesterSocket.join(newRoomCode);
      console.log(
        `[REMATCH ACCEPT] Requester ${requesterId} joined new room via socket ${requesterSocketId}`,
      );
    } else {
      console.log(
        `[REMATCH ACCEPT] Could not find requester socket for ${requesterId}`,
      );
    }

    console.log(
      `[REMATCH] New room ${newRoomCode} created for rematch: ${requesterId} vs ${acceptorId}`,
    );

    const acceptedPayload = {
      newRoomCode,
      betAmount: oldRoom.betAmount,
      mode: oldRoom.mode,
      players: rooms[newRoomCode].players,
    };

    // Notify via room broadcast (covers everyone who joined)
    io.to(newRoomCode).emit("rematch_accepted", acceptedPayload);

    // Also notify requester directly via userSockets in case they missed the room broadcast
    if (requesterSocketId) {
      io.to(requesterSocketId).emit("rematch_accepted", acceptedPayload);
    }

    // Broadcast room update
    io.to(newRoomCode).emit("room_update", rooms[newRoomCode]);
  });

  // REMATCH REJECTED
  socket.on("rematch_rejected", ({ oldRoomCode, requesterId }) => {
    console.log(`[REMATCH REJECT] Notifying requester ${requesterId}`);

    const rejectedPayload = { reason: "Your rematch request was rejected." };

    // Strategy 1: fresh userSockets map
    const freshSocketId = userSockets[requesterId];
    if (freshSocketId) {
      io.to(freshSocketId).emit("rematch_rejected", rejectedPayload);
      console.log(
        `[REMATCH REJECT] ✅ Sent via userSockets to ${freshSocketId}`,
      );
    }

    // Strategy 2: stored socketId in room
    const room = rooms[oldRoomCode];
    if (room?.players?.[requesterId]?.socketId) {
      const storedId = room.players[requesterId].socketId;
      if (storedId !== freshSocketId) {
        io.to(storedId).emit("rematch_rejected", rejectedPayload);
        console.log(`[REMATCH REJECT] ✅ Sent via stored socketId ${storedId}`);
      }
    }

    // Strategy 3: room broadcast
    if (oldRoomCode) {
      socket.to(oldRoomCode).emit("rematch_rejected", rejectedPayload);
      console.log(`[REMATCH REJECT] ✅ Broadcast to room ${oldRoomCode}`);
    }
  });

  // ADD BOT (Simulate)
  socket.on("add_bot", ({ roomCode, botData }) => {
    const room = rooms[roomCode];
    if (room) {
      // Generate realistic stats for bot
      const botStats = {
        gamesWon: Math.floor(Math.random() * 500) + 50,
        gamesPlayed: Math.floor(Math.random() * 1000) + 100,
        winStreak: Math.floor(Math.random() * 15),
        level: Math.floor(Math.random() * 50) + 1,
        gems: Math.floor(Math.random() * 5000) + 100,
        coins: Math.floor(Math.random() * 50000) + 1000,
      };

      room.players[botData.uid] = {
        ...botData,
        isBot: true,
        country: botData.country || "PK",
        gender: botData.gender || "male",
        ready: true,
        joinedAt: Date.now(),
        ...botStats,
      };

      console.log(`Bot added to room ${roomCode}`);
      io.to(roomCode).emit("room_update", room);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    // Remove from userSockets map (but keep userRooms so they can rejoin)
    for (const [uid, sid] of Object.entries(userSockets)) {
      if (sid === socket.id) {
        delete userSockets[uid];
        break;
      }
    }

    for (const [code, room] of Object.entries(rooms)) {
      const player = Object.values(room.players).find(
        (p) => p.socketId === socket.id,
      );
      if (!player) continue;

      delete room.players[player.uid];
      const remaining = Object.keys(room.players).length;

      if (remaining === 0) {
        // Room is empty — if game was in progress give a grace period so
        // rematch / late reconnects still work; otherwise delete immediately.
        if (room.status === "playing" || room.status === "game_over") {
          scheduleRoomDelete(code, 60000);
        } else {
          delete rooms[code];
        }
      } else {
        // Reassign host if needed
        if (room.host === player.uid) {
          room.host = Object.keys(room.players)[0];
        }
        io.to(code).emit("room_update", room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📡 Socket.IO ready for real-time game synchronization`);
  console.log(`🎮 Optimized delta updates enabled`);
  console.log(`✅ Server-side validation active`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Stats endpoint: http://localhost:${PORT}/stats`);
  
  // Start league reward distribution checker
  startLeagueRewardChecker();
});

// League reward distribution system
function startLeagueRewardChecker() {
  console.log('🏆 Starting league reward checker...');
  
  // Check every minute for more precise timing
  setInterval(async () => {
    try {
      const now = new Date();
      const currentDay = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      
      // Check if it's Monday at 00:00 (league reset time)
      if (currentDay === 1 && currentHour === 0 && currentMinute === 0) {
        console.log('🏆 League week ended, triggering reward distribution...');
        
        // Emit event to all connected clients to trigger league reset
        io.emit('league_reset_trigger', {
          message: 'League week ended - distributing rewards',
          timestamp: new Date().toISOString(),
          action: 'distribute_rewards'
        });
        
        // Also emit general league reset event
        io.emit('league_reset', {
          message: 'New league week has started!',
          timestamp: new Date().toISOString()
        });
        
        console.log('🎁 League reset events sent to all clients');
      }
    } catch (error) {
      console.error('Error in league reward checker:', error);
    }
  }, 60 * 1000); // Check every minute for more precision
}
