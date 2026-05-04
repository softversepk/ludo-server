const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const LudoGameServer = require("./ludoGameServer");
const ClubChatServer = require("./clubChatServer");
const LeaderboardServer = require("./leaderboardServer");
const ChessGameServer = require("./chessGameServer");

const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: 15 * 60 // 15 minutes in seconds
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// Stricter rate limiting for sensitive endpoints
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: {
    error: 'Too many requests to this endpoint, please try again later.',
    retryAfter: 15 * 60
  }
});

// Body parsing with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Production CORS configuration with security
const corsOptions = {
  origin: "*", // Allow all origins for easier connection during development and testing
  methods: ["GET", "POST"],
  credentials: true,
  optionsSuccessStatus: 200 // For legacy browser support
};

app.use(cors(corsOptions));

// Health check endpoint for monitoring
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: Math.floor(process.uptime()),
    version: '1.0.0'
  });
});

// Server stats endpoint with authentication
app.get('/stats', strictLimiter, (req, res) => {
  // In production, you should add authentication here
  if (process.env.NODE_ENV === 'production' && !req.headers.authorization) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  res.json({
    uptime: Math.floor(process.uptime()),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    },
    connections: io ? io.engine.clientsCount : 0,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version
  });
});

// SECURE FINANCIAL VALIDATION ENDPOINTS
// Authentication middleware for financial operations
const authenticateFinancialRequest = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const userId = req.headers['x-user-id'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!userId) {
    return res.status(400).json({ error: 'User ID required' });
  }

  // In production, validate the JWT token here
  // For now, we'll use a simple API key validation
  const token = authHeader.split(' ')[1];
  const validApiKey = process.env.API_KEY || 'development-key';

  if (token !== validApiKey) {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  req.userId = userId;
  next();
};

// Validate game win and award rewards
app.post('/api/game/validate-win', strictLimiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const { userId, gameType, betAmount, gameData } = req.body;

    // Validate input
    if (!userId || !gameType || !betAmount || !gameData) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Validate bet amount is reasonable
    if (betAmount < 0 || betAmount > 10000) {
      return res.status(400).json({
        success: false,
        error: 'Invalid bet amount'
      });
    }

    // TODO: Add game-specific validation logic here
    // For now, we'll calculate rewards based on bet amount
    const coinReward = Math.floor(betAmount * 2.0); // 2x multiplier
    const clubPointReward = Math.max(1, Math.floor(betAmount / 100));

    console.log('🎁 [SERVER-VALIDATION] Game win validated:', {
      userId,
      gameType,
      betAmount,
      coinReward,
      clubPointReward
    });

    // TODO: Update Firebase database with server admin credentials
    // For now, return calculated rewards for client to display
    res.json({
      success: true,
      rewards: {
        coins: coinReward,
        clubPoints: clubPointReward
      },
      validated: true,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ [SERVER-VALIDATION] Game win validation error:', error);
    res.status(500).json({
      success: false,
      error: 'Server validation failed'
    });
  }
});

// Validate gift transaction
app.post('/api/gift/send', strictLimiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const { fromUserId, toUserId, gift } = req.body;

    // Validate input
    if (!fromUserId || !toUserId || !gift) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Validate gift cost is reasonable
    if (!gift.cost || gift.cost < 0 || gift.cost > 10000) {
      return res.status(400).json({
        success: false,
        error: 'Invalid gift cost'
      });
    }

    console.log('🎁 [SERVER-VALIDATION] Gift transaction validated:', {
      fromUserId,
      toUserId,
      giftId: gift.id,
      cost: gift.cost
    });

    // TODO: Validate sender has enough coins and process transaction
    // For now, return success for client to handle
    res.json({
      success: true,
      transaction: {
        fromUserId,
        toUserId,
        gift,
        cost: gift.cost
      },
      validated: true,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ [SERVER-VALIDATION] Gift validation error:', error);
    res.status(500).json({
      success: false,
      error: 'Server validation failed'
    });
  }
});

// Validate coin transaction
app.post('/api/coins/transaction', strictLimiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const { userId, operation, amount, reason } = req.body;

    // Validate input
    if (!userId || !operation || !amount || !reason) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Validate operation type
    if (!['add', 'deduct'].includes(operation)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid operation type'
      });
    }

    // Validate amount is reasonable
    if (amount < 0 || amount > 100000) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount'
      });
    }

    console.log('💰 [SERVER-VALIDATION] Coin transaction validated:', {
      userId,
      operation,
      amount,
      reason
    });

    // TODO: Process the actual coin transaction with Firebase Admin SDK
    // For now, return success for client to handle
    res.json({
      success: true,
      transaction: {
        userId,
        operation,
        amount,
        reason
      },
      validated: true,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ [SERVER-VALIDATION] Coin transaction error:', error);
    res.status(500).json({
      success: false,
      error: 'Server validation failed'
    });
  }
});

// Server status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    available: true,
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    features: {
      gameValidation: true,
      giftValidation: true,
      coinValidation: true,
      securityEnabled: true
    }
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6, // 1MB limit for socket messages
  allowEIO3: true // For compatibility
});

// Security: Track connections per IP
const connectionTracker = new Map();
const MAX_CONNECTIONS_PER_IP = 100; // Increased limit for local development testing

// Middleware for connection limiting
io.use((socket, next) => {
  const clientIP = socket.handshake.address;
  const currentConnections = connectionTracker.get(clientIP) || 0;

  if (currentConnections >= MAX_CONNECTIONS_PER_IP) {
    console.warn(`🔒 [SECURITY] Too many connections from IP: ${clientIP}`);
    return next(new Error('Too many connections from this IP'));
  }

  connectionTracker.set(clientIP, currentConnections + 1);

  // Clean up on disconnect
  socket.on('disconnect', () => {
    const connections = connectionTracker.get(clientIP) || 0;
    if (connections <= 1) {
      connectionTracker.delete(clientIP);
    } else {
      connectionTracker.set(clientIP, connections - 1);
    }
  });

  next();
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

// Initialize Chess Game Server
const chessGameServer = new ChessGameServer(io);

console.log("✅ Chess Game Server initialized with real-time Socket.IO sync");

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

  // GET ALL ROOMS (for debugging)
  socket.on("get_all_rooms", (callback) => {
    const roomList = Object.entries(rooms).map(([code, room]) => ({
      code,
      status: room.status,
      playerCount: Object.keys(room.players).length,
      maxPlayers: room.maxPlayers,
      mode: room.mode,
      betAmount: room.betAmount,
      host: room.host,
      players: Object.keys(room.players)
    }));

    console.log(`📋 [DEBUG] Listing ${roomList.length} rooms`);
    if (callback) callback(roomList);
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
    console.log("🔍 [MATCHMAKING] Searching for match for:", playerData.username);
    console.log("🔍 [MATCHMAKING] Player data:", {
      uid: playerData.uid,
      mode: playerData.mode,
      betAmount: playerData.betAmount,
      playerCount: playerData.playerCount
    });

    const { mode, betAmount } = playerData;
    let joinedRoomCode = null;

    // Log current rooms for debugging
    const roomCount = Object.keys(rooms).length;
    console.log(`🔍 [MATCHMAKING] Checking ${roomCount} existing rooms...`);

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

      console.log(`🔍 [MATCHMAKING] Room ${code}: players=${currentCount}/${maxPlayers}, status=${room.status}, mode=${room.mode}, bet=${room.betAmount}, host=${room.host}`);
      console.log(`🔍 [MATCHMAKING] Match criteria: hasSpace=${hasSpace}, isWaiting=${isWaiting}, modeMatches=${modeMatches}, betMatches=${betMatches}, notOwnRoom=${notOwnRoom}`);

      // Simple matching logic
      if (hasSpace && isWaiting && modeMatches && betMatches && notOwnRoom) {
        joinedRoomCode = code;
        console.log(`✅ [MATCHMAKING] Found match in room ${code}!`);
        break;
      }
    }

    if (joinedRoomCode) {
      console.log(`✅ [MATCHMAKING] Joining existing room ${joinedRoomCode}`);

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
      console.log("🆕 [MATCHMAKING] No match found, creating new room...");
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

      console.log(`🆕 [MATCHMAKING] Created new room ${roomCode} for ${playerData.username}`);

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

      // Smart color assignment for TeamUp mode
      let assignedColor = null;
      
      if (room.isTeam) {
        // TeamUp mode: Prioritize keeping real players together
        const existingPlayers = Object.values(room.players);
        const realPlayers = existingPlayers.filter(p => !p.isBot);
        const botPlayers = existingPlayers.filter(p => p.isBot);
        
        // Team A: RED + YELLOW, Team B: BLUE + GREEN
        const teamAColors = ['RED', 'YELLOW'];
        const teamBColors = ['BLUE', 'GREEN'];
        
        // Find which colors are used by real players
        const realPlayerColors = realPlayers.map(p => p.color).filter(Boolean);
        
        // Determine which team has real players
        const teamAHasRealPlayer = realPlayerColors.some(c => teamAColors.includes(c));
        const teamBHasRealPlayer = realPlayerColors.some(c => teamBColors.includes(c));
        
        // Get available colors
        const usedColors = existingPlayers.map(p => p.color).filter(Boolean);
        const availableColors = ['RED', 'GREEN', 'YELLOW', 'BLUE'].filter(c => !usedColors.includes(c));
        
        if (availableColors.length > 0) {
          if (teamAHasRealPlayer && !teamBHasRealPlayer) {
            // Real players in Team A, put bots in Team B
            assignedColor = availableColors.find(c => teamBColors.includes(c)) || availableColors[0];
          } else if (teamBHasRealPlayer && !teamAHasRealPlayer) {
            // Real players in Team B, put bots in Team A
            assignedColor = availableColors.find(c => teamAColors.includes(c)) || availableColors[0];
          } else if (realPlayerColors.length === 1) {
            // Only 1 real player - put second real player in same team
            const firstRealColor = realPlayerColors[0];
            if (teamAColors.includes(firstRealColor)) {
              // First real player in Team A, assign teammate color if available
              assignedColor = availableColors.find(c => teamAColors.includes(c) && c !== firstRealColor);
            } else {
              // First real player in Team B, assign teammate color if available
              assignedColor = availableColors.find(c => teamBColors.includes(c) && c !== firstRealColor);
            }
            // If no teammate color available, assign any available color
            if (!assignedColor) {
              assignedColor = availableColors[0];
            }
          } else {
            // Multiple real players or no real players yet - assign any available
            assignedColor = availableColors[0];
          }
        }
      } else {
        // Non-team mode: Simple color assignment
        const colors = ['RED', 'GREEN', 'YELLOW', 'BLUE'];
        const usedColors = Object.values(room.players).map(p => p.color).filter(Boolean);
        assignedColor = colors.find(c => !usedColors.includes(c));
      }

      room.players[botData.uid] = {
        ...botData,
        isBot: true,
        color: assignedColor,
        country: botData.country || "PK",
        gender: botData.gender || "male",
        ready: true,
        joinedAt: Date.now(),
        ...botStats,
      };

      console.log(`🤖 Bot added to room ${roomCode} with color: ${assignedColor}`);
      io.to(roomCode).emit("room_update", room);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    // Handle Chess disconnect
    chessGameServer.handleDisconnect(socket);

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

  // ============================================
  // CHESS GAME EVENT HANDLERS
  // ============================================

  // Register user socket
  socket.on('chess:register', (userId) => {
    socket.userId = userId;
    console.log(`♟️ [CHESS] User registered: ${userId} -> ${socket.id}`);
  });

  // Find match (using same logic as Ludo)
  socket.on('chess:findMatch', (playerData, callback) => {
    console.log(`♟️ [CHESS] Searching for match for: ${playerData.username}`);
    console.log(`♟️ [CHESS] Player data:`, {
      uid: playerData.uid,
      betAmount: playerData.betAmount,
      level: playerData.level
    });

    const { betAmount } = playerData;
    let joinedRoomCode = null;

    // Log current rooms for debugging
    const roomCount = Object.keys(rooms).length;
    console.log(`♟️ [CHESS] Checking ${roomCount} existing rooms...`);

    // Iterate through rooms to find a match
    for (const [code, room] of Object.entries(rooms)) {
      if (!room) continue;

      // Skip non-chess rooms
      if (room.mode && room.mode !== 'chess') continue;

      const currentCount = Object.keys(room.players).length;
      const maxPlayers = room.maxPlayers || 2;
      const hasSpace = currentCount < maxPlayers;
      const isWaiting = room.status === "waiting";
      const betMatches = (room.betAmount || 100) === betAmount;
      const notOwnRoom = room.host !== playerData.uid;

      console.log(`♟️ [CHESS] Room ${code}: players=${currentCount}/${maxPlayers}, status=${room.status}, bet=${room.betAmount}`);
      console.log(`♟️ [CHESS] Match criteria: hasSpace=${hasSpace}, isWaiting=${isWaiting}, betMatches=${betMatches}, notOwnRoom=${notOwnRoom}`);

      // Simple matching logic
      if (hasSpace && isWaiting && betMatches && notOwnRoom) {
        joinedRoomCode = code;
        console.log(`✅ [CHESS] Found match in room ${code}!`);
        break;
      }
    }

    if (joinedRoomCode) {
      console.log(`✅ [CHESS] Joining existing room ${joinedRoomCode}`);

      // Add player to room
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

      // Get opponent info
      const opponentId = Object.keys(room.players).find(id => id !== playerData.uid);
      const opponent = room.players[opponentId];

      // Determine player colors (first player is white, second is black)
      const playerIds = Object.keys(room.players);
      const joiningPlayerIndex = playerIds.indexOf(playerData.uid);
      const joiningPlayerColor = joiningPlayerIndex === 0 ? 'white' : 'black';
      const hostPlayerColor = joiningPlayerIndex === 0 ? 'black' : 'white';

      console.log(`✅ [CHESS] Match found! ${playerData.username} (${joiningPlayerColor}) vs ${opponent.username} (${hostPlayerColor})`);

      // Send callback to joining player
      if (callback) {
        callback({
          success: true,
          roomCode: joinedRoomCode,
          joined: true,
          playerColor: joiningPlayerColor,
          opponent: opponent,
          isAI: false
        });
      }

      // Emit event to joining player
      socket.emit('chess:matchFound', {
        status: 'matched',
        roomCode: joinedRoomCode,
        playerColor: joiningPlayerColor,
        opponent: opponent,
        isAI: false
      });

      // Emit event to host player (first player who created the room)
      const hostSocketId = userSockets[room.host];
      if (hostSocketId) {
        io.to(hostSocketId).emit('chess:matchFound', {
          status: 'matched',
          roomCode: joinedRoomCode,
          playerColor: hostPlayerColor,
          opponent: {
            uid: playerData.uid,
            username: playerData.username,
            avatar: playerData.avatar,
            level: playerData.level,
            gamesWon: playerData.gamesWon || 0,
            gamesPlayed: playerData.gamesPlayed || 0,
            winStreak: playerData.winStreak || 0,
            gems: playerData.gems || 0,
            coins: playerData.coins || 0,
          },
          isAI: false
        });
        console.log(`✅ [CHESS] Notified host player ${room.host} about match`);
      } else {
        console.warn(`⚠️ [CHESS] Could not find socket for host player ${room.host}`);
      }
    } else {
      // Create a new room if no match found
      console.log("🆕 [CHESS] No match found, creating new room...");

      const roomCode = generateRoomCode();
      const rules = {
        playerCount: 2,
        maxPlayers: 2,
        betAmount: playerData.betAmount || 100,
        mode: 'chess',
        isTeam: false,
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

      console.log(`🆕 [CHESS] Created new room ${roomCode} for ${playerData.username}`);

      if (callback) {
        callback({
          success: true,
          roomCode: roomCode,
          joined: false,
          created: true
        });
      }

      io.to(roomCode).emit("room_update", rooms[roomCode]);
    }
  });

  // Join room
  socket.on('chess:joinRoom', (data, callback) => {
    const { roomId } = data;
    socket.join(roomId);
    console.log(`♟️ [CHESS] Socket ${socket.id} joined room ${roomId}`);
    if (callback) callback({ success: true });
  });

  // Make move
  socket.on('chess:makeMove', (data, callback) => {
    chessGameServer.handleMakeMove(socket, data);
    if (callback) callback({ success: true });
  });

  // Resign game
  socket.on('chess:resign', (data, callback) => {
    chessGameServer.handleResign(socket, data);
    if (callback) callback({ success: true });
  });

  // Leave game
  socket.on('chess:leave', (data, callback) => {
    chessGameServer.handleLeaveGame(socket, data);
    if (callback) callback({ success: true });
  });

  // ============================================
  // GAME CHAT EVENT HANDLERS (Ludo, Chess, etc.)
  // ============================================

  // Join game chat room
  socket.on('game:joinChat', (data, callback) => {
    const { roomId, userId, username } = data;
    console.log(`💬 [GAME CHAT] joinChat event received:`, {
      roomId,
      userId,
      username,
      socketId: socket.id,
      hasCallback: !!callback
    });

    socket.join(`chat:${roomId}`);
    console.log(`💬 [GAME CHAT] ${username} (socket ${socket.id}) joined chat room chat:${roomId}`);
    console.log(`💬 [GAME CHAT] Socket rooms:`, socket.rooms);

    if (callback) callback({ success: true });
  });

  // Leave game chat room
  socket.on('game:leaveChat', (data, callback) => {
    const { roomId, userId } = data;
    socket.leave(`chat:${roomId}`);
    console.log(`💬 [GAME CHAT] User ${userId} left chat for room ${roomId}`);
    if (callback) callback({ success: true });
  });

  // Send chat message
  socket.on('game:sendChat', (data, callback) => {
    const { roomId, userId, username, message, timestamp } = data;

    console.log(`💬 [GAME CHAT] Received sendChat event:`, {
      roomId,
      userId,
      username,
      message,
      hasCallback: !!callback
    });

    if (!message || !message.trim()) {
      console.error('💬 [GAME CHAT] Empty message rejected');
      if (callback) callback({ error: 'Empty message' });
      return;
    }

    // Validate message length (max 200 chars)
    if (message.length > 200) {
      console.error('💬 [GAME CHAT] Message too long rejected');
      if (callback) callback({ error: 'Message too long' });
      return;
    }

    console.log(`💬 [GAME CHAT] Broadcasting message from ${username} in room ${roomId}: "${message}"`);

    // Broadcast to both chat room and game room to ensure all players receive it
    io.to(`chat:${roomId}`).emit('game:chatMessage', {
      userId,
      username,
      message,
      timestamp,
      roomId
    });

    io.to(roomId).emit('game:chatMessage', {
      userId,
      username,
      message,
      timestamp,
      roomId
    });

    console.log(`💬 [GAME CHAT] Message broadcasted to chat:${roomId} and ${roomId}`);
    if (callback) callback({ success: true });
  });

  // Send emoji reaction
  socket.on('game:sendEmoji', (data, callback) => {
    const { roomId, userId, username, emoji, timestamp } = data;

    console.log(`😊 [GAME EMOJI] Received sendEmoji event:`, {
      roomId,
      userId,
      username,
      emoji,
      hasCallback: !!callback
    });

    if (!emoji) {
      console.error('😊 [GAME EMOJI] No emoji provided');
      if (callback) callback({ error: 'No emoji provided' });
      return;
    }

    console.log(`😊 [GAME EMOJI] Broadcasting emoji from ${username} in room ${roomId}: ${emoji}`);

    // Broadcast to both chat room and game room to ensure all players receive it
    io.to(`chat:${roomId}`).emit('game:emojiReaction', {
      userId,
      username,
      emoji,
      timestamp,
      roomId
    });

    io.to(roomId).emit('game:emojiReaction', {
      userId,
      username,
      emoji,
      timestamp,
      roomId
    });

    console.log(`😊 [GAME EMOJI] Emoji broadcasted to chat:${roomId} and ${roomId}`);
    if (callback) callback({ success: true });
  });

  // ============================================
  // END GAME CHAT EVENT HANDLERS
  // ============================================
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
  console.log('🏆 League reward checker is now managed by Firebase config on the client side.');
  // Removed the 1-minute test cycle
}



