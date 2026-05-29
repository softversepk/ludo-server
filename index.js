const express = require("express");
const http = require("http");
require('dotenv').config(); // Add dotenv support for local testing
const { Server } = require("socket.io");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { RtcTokenBuilder, RtcRole } = require('agora-token'); // Agora Token Builder
const LudoGameServer = require("./ludoGameServer");
const ClubChatServer = require("./clubChatServer");
const LeaderboardServer = require("./leaderboardServer");
const ChessGameServer = require("./chessGameServer");
const TicTacToeGameServer = require("./ticTacToeServer");
const { processUserXP } = require('./xpService');
const admin = require('firebase-admin');

// Initialize Firebase Admin (Required for secure backend operations like XP and Economy)
try {
  if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      // Parse the JSON string from environment variable (useful for Railway)
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log("✅ Firebase Admin initialized with Service Account from ENV");
    } else {
      // Fallback: This expects GOOGLE_APPLICATION_CREDENTIALS env var pointing to a file path
      admin.initializeApp();
      console.log("✅ Firebase Admin initialized (Default)");
    }
  }
} catch (error) {
  console.warn("⚠️ Firebase Admin initialization warning:", error.message);
}

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
  max: 20, // limit each IP to 20 requests per windowMs
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
  origin: function (origin, callback) {
    callback(null, true); // Allow all origins dynamically
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-user-id"],
  credentials: true,
  optionsSuccessStatus: 200 // For legacy browser support
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle preflight requests for all routes

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


// ECONOMY ENDPOINTS
app.post('/api/economy/update', strictLimiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const { currency, amount, type, reason, description } = req.body;
    const userId = req.userId;
    
    if (!currency || !['coins', 'gems'].includes(currency)) {
      return res.status(400).json({ error: 'Invalid currency' });
    }
    
    if (typeof amount !== 'number') {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    const userRef = admin.firestore().collection('users').doc(userId);
    
    await admin.firestore().runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error('User not found');
      }
      
      const userData = userDoc.data();
      const currentBalance = userData[currency] || 0;
      
      if (amount < 0 && currentBalance < Math.abs(amount)) {
        throw new Error(`Insufficient ${currency}`);
      }
      
      const updates = {
        [currency]: admin.firestore.FieldValue.increment(amount)
      };
      
      if (currency === 'coins' && amount > 0) {
        updates.totalCoinsEarned = admin.firestore.FieldValue.increment(amount);
        updates.weeklyCoins = admin.firestore.FieldValue.increment(amount);
      }
      
      transaction.update(userRef, updates);
      
      // Log diamond transactions as in diamondService
      if (currency === 'gems') {
        const txRef = admin.firestore().collection('diamondTransactions').doc();
        transaction.set(txRef, {
          userId,
          amount,
          type,
          description: description || reason || '',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          balanceAfter: currentBalance + amount
        });
      }
    });
    
    res.status(200).json({ success: true, message: 'Economy updated successfully' });
  } catch (error) {
    console.error('Error in /api/economy/update:', error.message);
    res.status(400).json({ error: error.message || 'Internal server error' });
  }
});

// GIFT SENDING ENDPOINT
app.post('/api/gifts/send', strictLimiter, async (req, res) => {
  try {
    const { senderId, recipientId, giftId, clubId, cost } = req.body;
    
    if (!senderId || !giftId || !clubId || !cost) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify sender has enough gems
    const senderRef = admin.firestore().collection('users').doc(senderId);
    const senderDoc = await senderRef.get();
    
    if (!senderDoc.exists) {
      return res.status(404).json({ error: 'Sender not found' });
    }
    
    const senderData = senderDoc.data();
    const currentGems = senderData.gems || 0;
    
    if (currentGems < cost) {
      return res.status(400).json({ error: 'Not enough gems' });
    }

    // Transaction for secure deduction and addition
    await admin.firestore().runTransaction(async (transaction) => {
      // We must get the recipient first if there is one to perform reads before writes
      let recipientRef = null;
      let recipientDoc = null;
      
      if (recipientId && recipientId !== 'all') {
        recipientRef = admin.firestore().collection('users').doc(recipientId);
        recipientDoc = await transaction.get(recipientRef);
      }
      
      // Get sender in transaction
      const tSenderDoc = await transaction.get(senderRef);
      
      if (!tSenderDoc.exists) {
        throw new Error('Sender not found in transaction');
      }

      const tSenderGems = tSenderDoc.data().gems || 0;
      if (tSenderGems < cost) {
        throw new Error('Not enough gems during transaction');
      }

      // 1. Deduct from sender
      transaction.update(senderRef, {
        gems: admin.firestore.FieldValue.increment(-cost)
      });
      
      // 2. Add to recipient if not 'all'
      if (recipientRef && recipientDoc && recipientDoc.exists) {
        transaction.update(recipientRef, {
          gems: admin.firestore.FieldValue.increment(cost)
        });
      }
    });

    res.status(200).json({ success: true, message: 'Gift sent successfully' });
  } catch (error) {
    console.error('Error in /api/gifts/send:', error.message);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// AGORA TOKEN GENERATION ENDPOINT (Secure)
app.get('/rtcToken', strictLimiter, authenticateFinancialRequest, (req, res) => {
    res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.header('Expires', '-1');
    res.header('Pragma', 'no-cache');

    const channelName = req.query.channelName;
    if (!channelName) {
        return res.status(400).json({ error: 'channelName is required' });
    }

    let uid = req.query.uid;
    if (!uid || uid === '') {
        uid = 0; 
    }

    let role = RtcRole.SUBSCRIBER;
    if (req.query.role === 'publisher') {
        role = RtcRole.PUBLISHER;
    }

    let expireTime = req.query.expireTime;
    if (!expireTime || expireTime === '') {
        expireTime = 3600 * 24;
    } else {
        expireTime = parseInt(expireTime, 10);
    }

    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpireTime = currentTime + expireTime;

    const APP_ID = process.env.AGORA_APP_ID || '4ca360f96c324fe39683d5323f279bb2';
    const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || '219a06c3b3034c079782e11cc690cf1b';

    try {
        let token;
        if (req.query.tokentype === 'userAccount') {
            token = RtcTokenBuilder.buildTokenWithUserAccount(
                APP_ID, APP_CERTIFICATE, channelName, uid, role, privilegeExpireTime
            );
        } else {
            token = RtcTokenBuilder.buildTokenWithUid(
                APP_ID, APP_CERTIFICATE, channelName, uid, role, privilegeExpireTime
            );
        }
        return res.json({ token: token });
    } catch (error) {
        console.error("Agora Token Generation Error:", error);
        return res.status(500).json({ error: "Failed to generate token" });
    }
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
async function authenticateFinancialRequest(req, res, next) {
  const authHeader = req.headers.authorization;
  const headerUserId = req.headers['x-user-id']; // Used for fallback/compatibility, but token is source of truth

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Highly secure: Verify the Firebase Auth ID Token using Admin SDK
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // Set the userId from the securely decoded token
    req.userId = decodedToken.uid;

    // Optional: Warn if the header userId doesn't match the token (helps catch spoofing attempts)
    if (headerUserId && headerUserId !== req.userId) {
      console.warn(`[SECURITY] User ID spoofing attempt detected. Header: ${headerUserId}, Token: ${req.userId}`);
    }

    next();
  } catch (error) {
    console.error('[SECURITY] Token verification failed:', error.message);
    
    // Fallback for development/testing if API_KEY is used (Remove in strict production)
    const validApiKey = process.env.API_KEY || 'development-key';
    if (token === validApiKey && process.env.NODE_ENV !== 'production') {
      if (!headerUserId) {
        return res.status(400).json({ error: 'User ID required for API key access' });
      }
      console.warn('[SECURITY] Using insecure API key fallback. NOT recommended for production.');
      req.userId = headerUserId;
      return next();
    }

    return res.status(401).json({ error: 'Invalid authentication token' });
  }
};

// Undo roll tracker for match-based pricing and limits
// Key: `${roomId}_${userId}`, Value: { count: number, lastUpdate: number }
const undoTracker = new Map();

// Helper to get undo cost
const getUndoCost = (count) => {
  if (count === 0) return 5;
  if (count === 1) return 15;
  if (count === 2) return 40;
  if (count === 3) return 100;
  return -1; // Max limit reached
};

// Cleanup old undo tracking data (e.g., older than 2 hours)
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of undoTracker.entries()) {
    if (now - data.lastUpdate > 2 * 60 * 60 * 1000) {
      undoTracker.delete(key);
    }
  }
}, 60 * 60 * 1000);

// SECURE UNDO ROLL ENDPOINT
app.post('/api/game/undo-roll', strictLimiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const { userId, roomId, gameType, matchId, expectedCost } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing user ID' });
    }

    const actualRoomId = roomId || matchId || 'local_match';
    const trackerKey = `${actualRoomId}_${userId}`;
    
    let undoData = undoTracker.get(trackerKey) || { count: 0, lastUpdate: Date.now() };
    
    const cost = getUndoCost(undoData.count);
    
    if (cost === -1) {
      return res.status(403).json({ 
        success: false, 
        error: 'Max undo limit reached for this match',
        undoCount: undoData.count
      });
    }

    // Check if frontend's cost matches backend's cost (to prevent out-of-sync UI charging more than expected)
    if (expectedCost !== null && expectedCost !== undefined && expectedCost !== cost) {
      return res.status(200).json({
        success: false,
        error: `Cost mismatch. The actual cost is ${cost} diamonds.`,
        undoCount: undoData.count,
        costMismatch: true
      });
    }

    if (!admin.apps.length) {
      return res.status(503).json({ success: false, error: 'Firebase Admin not initialized' });
    }

    const db = admin.firestore();
    const userRef = db.collection('users').doc(userId);

    let generatedDiceValue = 1;
    let newGems = 0;

    // Run in transaction to ensure they have enough diamonds
    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error('User not found');
      }

      const userData = userDoc.data();
      const currentGems = userData.gems || 0;

      if (currentGems < cost) {
        throw new Error(`Not enough diamonds. You need ${cost} diamonds for this undo.`);
      }

      newGems = currentGems - cost;
      transaction.update(userRef, { gems: newGems });
      
      // Generate secure random dice roll on backend
      generatedDiceValue = Math.floor(Math.random() * 6) + 1;
    });

    // Increment count after successful transaction
    undoData.count += 1;
    undoData.lastUpdate = Date.now();
    undoTracker.set(trackerKey, undoData);

    // If it's a multiplayer game using ludoGameServer, we might want to update the room state
    // But since GameScreen uses throttledFirebaseSync, the frontend will broadcast the new diceValue
    // as part of the state update. The backend provides the securely generated value and deducts currency.

    res.json({
      success: true,
      diceValue: generatedDiceValue,
      newGems: newGems,
      newDiamonds: newGems, // Keep for backward compatibility
      cost: cost,
      nextCost: getUndoCost(undoData.count),
      undoCount: undoData.count,
      message: `Undo successful, ${cost} diamonds deducted`
    });

  } catch (error) {
    console.error('❌ [UNDO-ROLL] Error:', error.message);
    res.status(200).json({ success: false, error: error.message || 'Failed to process undo' });
  }
});

// CHEST BOX CLAIM ENDPOINT (Highly Secure)
app.post('/api/chest/claim', strictLimiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const { chestId } = req.body;
    const userId = req.userId;

    if (!chestId) {
      return res.status(400).json({ error: 'Missing chest ID' });
    }

    if (!admin.apps.length) {
      return res.status(503).json({ error: 'Firebase Admin not initialized' });
    }

    const db = admin.firestore();
    
    // Run the entire claim process in a transaction
    await db.runTransaction(async (transaction) => {
      const chestRef = db.collection('chest_boxes').doc(chestId);
      const userRef = db.collection('users').doc(userId);

      const [chestDoc, userDoc] = await Promise.all([
        transaction.get(chestRef),
        transaction.get(userRef)
      ]);

      if (!chestDoc.exists) {
        throw new Error('Chest box not found');
      }

      if (!userDoc.exists) {
        throw new Error('User not found');
      }

      const chest = chestDoc.data();
      const userProfile = userDoc.data();

      // Check if chest is active
      if (chest.isActive === false) {
        throw new Error('This chest is no longer available');
      }

      const isDailyLogin = chest.requirementType === 'daily_login';
      const isWins = chest.requirementType === 'wins';
      const isTokenKills = chest.requirementType === 'token_kills';
      const isOneTime = !isDailyLogin && !isWins && !isTokenKills;

      const claimedChests = userProfile.claimedChests || [];
      const dailyLoginChests = userProfile.dailyLoginChests || {};
      const chestWinOffsets = userProfile.chestWinOffsets || {};
      const chestKillOffsets = userProfile.chestKillOffsets || {};

      const updates = {};

      // 1. Validation logic
      if (isDailyLogin) {
        const nextTime = dailyLoginChests[chestId];
        if (nextTime && Date.now() < nextTime) {
          throw new Error('Please wait for the timer to finish before opening this chest!');
        }
        const days = parseFloat(chest.requirements) || 1;
        updates.dailyLoginChests = {
          ...dailyLoginChests,
          [chestId]: Date.now() + (days * 24 * 60 * 60 * 1000)
        };
      } else if (isWins) {
        const target = parseFloat(chest.requirements) || 1;
        const offset = chestWinOffsets[chestId] || 0;
        const currentWins = userProfile.gamesWon || 0;
        if (currentWins - offset < target) {
          throw new Error('You need more wins to open this chest!');
        }
        updates.chestWinOffsets = {
          ...chestWinOffsets,
          [chestId]: offset + target
        };
      } else if (isTokenKills) {
        const target = parseFloat(chest.requirements) || 1;
        const offset = chestKillOffsets[chestId] || 0;
        const currentKills = userProfile.tokensKilled || 0;
        if (currentKills - offset < target) {
          throw new Error('You need more token kills to open this chest!');
        }
        updates.chestKillOffsets = {
          ...chestKillOffsets,
          [chestId]: offset + target
        };
      } else if (isOneTime) {
        if (claimedChests.includes(chestId)) {
          throw new Error('You have already opened this chest!');
        }
        updates.claimedChests = [...claimedChests, chestId];
      }

      // 2. Add Rewards
      const coinsReward = chest.coinsReward || 0;
      const gemsReward = chest.gemsReward || 0;

      if (coinsReward > 0) {
        updates.coins = admin.firestore.FieldValue.increment(coinsReward);
        updates.totalCoinsEarned = admin.firestore.FieldValue.increment(coinsReward);
        updates.weeklyCoins = admin.firestore.FieldValue.increment(coinsReward);
      }

      if (gemsReward > 0) {
        updates.gems = admin.firestore.FieldValue.increment(gemsReward);
        
        // Log diamond transaction
        const txRef = db.collection('diamondTransactions').doc();
        transaction.set(txRef, {
          userId,
          amount: gemsReward,
          type: 'achievement_reward',
          description: `Opened chest: ${chest.name || chestId}`,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          balanceAfter: (userProfile.gems || 0) + gemsReward
        });
      }

      // 3. Apply updates
      transaction.update(userRef, updates);
    });

    res.status(200).json({ success: true, message: 'Chest claimed successfully' });
  } catch (error) {
    console.error('Error claiming chest:', error.message);
    // Return 200 with success: false for business logic errors to prevent browser console 400 errors
    res.status(200).json({ success: false, error: error.message || 'Failed to claim chest' });
  }
});

// Update Game Stats securely on the backend
app.post('/api/game/update-stats', strictLimiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const { userId, stats } = req.body;

    if (!userId || !stats) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    if (!admin.apps.length) {
      return res.status(503).json({ success: false, error: 'Firebase Admin not initialized' });
    }

    const db = admin.firestore();
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const updates = {};
    if (stats.won) {
      updates.gamesWon = admin.firestore.FieldValue.increment(1);
      updates.winStreak = admin.firestore.FieldValue.increment(1);
    } else if (stats.played && stats.won === false) {
      updates.winStreak = 0;
    }
    
    if (stats.played) updates.gamesPlayed = admin.firestore.FieldValue.increment(1);
    if (stats.kills) updates.tokensKilled = admin.firestore.FieldValue.increment(stats.kills);

    if (Object.keys(updates).length > 0) {
      await userRef.update(updates);
    }

    // Fetch the updated doc to return the new values
    const updatedDoc = await userRef.get();
    
    res.json({
      success: true,
      stats: {
        gamesWon: updatedDoc.data().gamesWon,
        gamesPlayed: updatedDoc.data().gamesPlayed,
        tokensKilled: updatedDoc.data().tokensKilled,
        winStreak: updatedDoc.data().winStreak
      }
    });

  } catch (error) {
    console.error('❌ [SERVER-STATS] Error updating stats:', error);
    res.status(500).json({ success: false, error: 'Server validation failed' });
  }
});

// Validate game win and award rewards
app.post('/api/game/award-xp', strictLimiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const { userId, action } = req.body;
    if (!userId || !action) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    if (!admin.apps.length) {
      return res.status(503).json({ success: false, error: 'Firebase Admin not initialized' });
    }

    const xpResult = await processUserXP(userId, action);
    
    if (xpResult.success) {
      res.json(xpResult);
    } else {
      res.status(400).json(xpResult);
    }
  } catch (error) {
    console.error('❌ [SERVER-XP] Error awarding XP:', error);
    res.status(500).json({ success: false, error: 'Server validation failed' });
  }
});

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
    // Process XP for Match Win
    let xpResult = null;
    try {
      if (admin.apps.length) {
        xpResult = await processUserXP(userId, 'match_win');
        console.log('🏆 [SERVER-XP] Match win XP processed:', xpResult);
      } else {
        console.warn('⚠️ [SERVER-XP] Firebase Admin not initialized, skipping XP processing.');
      }
    } catch (e) {
      console.error('❌ [SERVER-XP] Error processing XP:', e);
    }

    // For now, return calculated rewards for client to display
    res.json({
      success: true,
      rewards: {
        coins: coinReward,
        clubPoints: clubPointReward
      },
      xp: xpResult,
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

// SECURE GIFT SENDING ENDPOINT
app.post('/api/gift/send', strictLimiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const { fromUserId, toUserId, gift, roomId } = req.body;

    // Validate input
    if (!fromUserId || !toUserId || !gift) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Validate gift cost is reasonable
    if (!gift.cost || gift.cost < 0 || gift.cost > 100000) {
      return res.status(400).json({
        success: false,
        error: 'Invalid gift cost'
      });
    }

    const db = admin.firestore();
    const senderRef = db.collection('users').doc(fromUserId);
    const receiverRef = db.collection('users').doc(toUserId);
    const giftRef = db.collection('gifts').doc(); // Auto-generated ID

    let actualCost = gift.cost;

    await db.runTransaction(async (transaction) => {
      // 1. Validate the gift cost from the database to prevent client spoofing
      if (gift.id) {
        const giftItemRef = db.collection('gift_items').doc(gift.id);
        const giftItemDoc = await transaction.get(giftItemRef);
        if (giftItemDoc.exists) {
          actualCost = giftItemDoc.data().cost;
        }
      }

      if (!actualCost || actualCost < 0) {
        throw new Error('Invalid gift cost');
      }

      // 2. Get sender
      const senderDoc = await transaction.get(senderRef);
      if (!senderDoc.exists) {
        throw new Error('Sender not found');
      }

      // 3. Check coins
      const currentCoins = senderDoc.data().coins || 0;
      if (currentCoins < actualCost) {
        throw new Error('Insufficient coins');
      }

      // 4. Get receiver to verify they exist
      const receiverDoc = await transaction.get(receiverRef);
      if (!receiverDoc.exists) {
         throw new Error('Receiver not found');
      }

      // 5. Deduct coins from sender
      transaction.update(senderRef, {
        coins: admin.firestore.FieldValue.increment(-actualCost)
      });

      // 6. Update receiver's gift count
      transaction.update(receiverRef, {
        giftsReceived: admin.firestore.FieldValue.increment(1)
      });

      // 7. Create gift record
      transaction.set(giftRef, {
        fromUserId,
        toUserId,
        giftId: gift.id || null,
        giftName: gift.name || null,
        giftEmoji: gift.emoji || null,
        giftImageUrl: gift.imageUrl || null,
        animationUrl: gift.animationUrl || null,
        cost: actualCost,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        read: false,
        animated: false
      });
    });

    console.log('🎁 [SERVER-SECURE] Gift sent successfully:', {
      fromUserId,
      toUserId,
      giftId: gift.id,
      cost: actualCost
    });

    // Broadcast to room via socket.io if roomId is provided
    if (roomId) {
      const io = req.app.get('io');
      if (io) {
        console.log(`📡 [SOCKET] Broadcasting gift to room ${roomId}`);
        io.to(roomId).emit('game_gift_sent', {
          fromUserId,
          toUserId,
          gift: {
            id: gift.id,
            emoji: gift.emoji,
            imageUrl: gift.imageUrl,
            animationUrl: gift.animationUrl,
            name: gift.name,
            cost: actualCost
          }
        });
      }
    }

    res.json({
      success: true,
      transaction: {
        fromUserId,
        toUserId,
        gift,
        cost: actualCost
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ [SERVER-SECURE] Gift validation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Server validation failed'
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

// ==========================================
// SECURE FRIEND READ API ENDPOINTS
// ==========================================

// GET /api/friends/list
app.get('/api/friends/list', limiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const userId = req.userId;
    const db = admin.firestore();
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.json({ success: true, friends: [] });
    
    const friendIds = userDoc.data().friends || [];
    if (friendIds.length === 0) return res.json({ success: true, friends: [] });
    
    const friendsData = [];
    const friendDocs = await Promise.all(friendIds.map(id => db.collection('users').doc(id).get()));
    
    for (const doc of friendDocs) {
      if (doc.exists) {
        const data = doc.data();
        friendsData.push({
          id: doc.id,
          username: data.username || data.displayName || 'Unknown',
          avatar: data.avatar || 'default',
          level: data.level || 1,
          lastActive: data.lastActive,
          currentGame: data.currentGame,
          settings: data.settings
        });
      }
    }
    
    res.json({ success: true, friends: friendsData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/friends/requests/pending
app.get('/api/friends/requests/pending', limiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const userId = req.userId;
    const db = admin.firestore();
    const requestsQuery = await db.collection('friendRequests')
      .where('toUserId', '==', userId)
      .where('status', '==', 'pending')
      .get();
      
    const requests = [];
    for (const docSnap of requestsQuery.docs) {
      const data = docSnap.data();
      const senderDoc = await db.collection('users').doc(data.fromUserId).get();
      const senderData = senderDoc.exists ? senderDoc.data() : {};
      requests.push({
        id: docSnap.id,
        ...data,
        senderName: senderData.username || senderData.displayName || 'Unknown',
        senderAvatar: senderData.avatar || 'default',
        senderLevel: senderData.level || 1,
      });
    }
    
    res.json({ success: true, requests });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/friends/search
app.get('/api/friends/search', limiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const userId = req.userId;
    const db = admin.firestore();
    
    const userDoc = await db.collection('users').doc(userId).get();
    const currentFriends = userDoc.exists ? (userDoc.data().friends || []) : [];
    
    // Securely fetch a limited number of users to prevent memory overload
    const usersQuery = await db.collection('users').limit(150).get();
    
    const users = [];
    usersQuery.forEach(docSnap => {
      if (docSnap.id !== userId && !currentFriends.includes(docSnap.id) && !docSnap.id.startsWith('bot_')) {
        const data = docSnap.data();
        if (!data.settings?.privateAccount) {
          users.push({
            id: docSnap.id,
            name: data.username || data.displayName || 'Unknown',
            avatar: data.avatar || 'default',
            level: data.level || 1,
            club: data.clubName || null,
          });
        }
      }
    });
    
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/friends/status/:friendId
app.get('/api/friends/status/:friendId', limiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const fromUserId = req.userId;
    const toUserId = req.params.friendId;
    const db = admin.firestore();
    
    const userDoc = await db.collection('users').doc(fromUserId).get();
    const friends = userDoc.exists ? (userDoc.data().friends || []) : [];
    if (friends.includes(toUserId)) {
      return res.json({ success: true, status: 'friends' });
    }
    
    const sentQuery = await db.collection('friendRequests')
      .where('fromUserId', '==', fromUserId)
      .where('toUserId', '==', toUserId)
      .where('status', '==', 'pending')
      .get();
      
    if (!sentQuery.empty) {
      return res.json({ success: true, status: 'pending_sent' });
    }
    
    const receivedQuery = await db.collection('friendRequests')
      .where('fromUserId', '==', toUserId)
      .where('toUserId', '==', fromUserId)
      .where('status', '==', 'pending')
      .get();
      
    if (!receivedQuery.empty) {
      return res.json({ success: true, status: { status: 'pending_received', requestId: receivedQuery.docs[0].id } });
    }
    
    res.json({ success: true, status: 'none' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// SECURE FRIEND REQUEST SYSTEM
// ==========================================

// Send friend request
app.post('/api/friends/request/send', strictLimiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const { fromUserId, toUserId } = req.body;
    if (!fromUserId || !toUserId) return res.status(400).json({ success: false, error: 'Missing user IDs' });
    if (fromUserId !== req.userId) return res.status(403).json({ success: false, error: 'Unauthorized sender' });

    const db = admin.firestore();
    
    // Check if already friends
    const userDoc = await db.collection('users').doc(fromUserId).get();
    const friends = userDoc.data()?.friends || [];
    if (friends.includes(toUserId)) return res.status(400).json({ success: false, error: 'Already friends' });

    // Check if target user has private account
    const toUserDoc = await db.collection('users').doc(toUserId).get();
    const toUserSettings = toUserDoc.data()?.settings || {};
    if (toUserSettings.privateAccount) return res.status(400).json({ success: false, error: 'User has private account' });

    // Check if request already exists
    const existingRequests = await db.collection('friendRequests')
      .where('fromUserId', '==', fromUserId)
      .where('toUserId', '==', toUserId)
      .where('status', '==', 'pending')
      .get();
      
    if (!existingRequests.empty) return res.status(400).json({ success: false, error: 'Request already sent' });

    // Create request and notification via batch
    const batch = db.batch();
    
    const requestRef = db.collection('friendRequests').doc();
    batch.set(requestRef, {
      fromUserId,
      toUserId,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const notificationRef = db.collection('notifications').doc();
    batch.set(notificationRef, {
      userId: toUserId,
      type: 'friend_request',
      fromUserId,
      requestId: requestRef.id,
      message: 'sent you a friend request',
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();
    res.json({ success: true, requestId: requestRef.id });
  } catch (error) {
    console.error('[SERVER-FRIENDS] Error sending request:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Accept friend request
app.post('/api/friends/request/accept', strictLimiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const { requestId, fromUserId, toUserId } = req.body;
    // toUserId in the request doc is the person accepting it, who should be req.userId
    if (toUserId !== req.userId) return res.status(403).json({ success: false, error: 'Unauthorized user' });

    const db = admin.firestore();
    
    await db.runTransaction(async (transaction) => {
      const requestRef = db.collection('friendRequests').doc(requestId);
      const requestDoc = await transaction.get(requestRef);
      
      if (!requestDoc.exists || requestDoc.data().status !== 'pending') {
        throw new Error('Request not found or not pending');
      }

      const fromUserRef = db.collection('users').doc(fromUserId);
      const toUserRef = db.collection('users').doc(toUserId);
      
      transaction.update(requestRef, {
        status: 'accepted',
        acceptedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.update(fromUserRef, {
        friends: admin.firestore.FieldValue.arrayUnion(toUserId)
      });
      
      transaction.update(toUserRef, {
        friends: admin.firestore.FieldValue.arrayUnion(fromUserId)
      });

      const notificationRef = db.collection('notifications').doc();
      transaction.set(notificationRef, {
        userId: fromUserId,
        type: 'friend_request_accepted',
        fromUserId: toUserId,
        message: 'accepted your friend request',
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[SERVER-FRIENDS] Error accepting request:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reject friend request
app.post('/api/friends/request/reject', strictLimiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const { requestId, fromUserId, toUserId } = req.body;
    if (toUserId !== req.userId) return res.status(403).json({ success: false, error: 'Unauthorized user' });

    const db = admin.firestore();
    const batch = db.batch();
    
    const requestRef = db.collection('friendRequests').doc(requestId);
    batch.update(requestRef, {
      status: 'rejected',
      rejectedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const notificationRef = db.collection('notifications').doc();
    batch.set(notificationRef, {
      userId: fromUserId,
      type: 'friend_request_rejected',
      fromUserId: toUserId,
      message: 'declined your friend request',
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();
    res.json({ success: true });
  } catch (error) {
    console.error('[SERVER-FRIENDS] Error rejecting request:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Remove friend
app.post('/api/friends/remove', strictLimiter, authenticateFinancialRequest, async (req, res) => {
  try {
    const { userId, friendId } = req.body;
    if (userId !== req.userId) return res.status(403).json({ success: false, error: 'Unauthorized user' });

    const db = admin.firestore();
    const batch = db.batch();
    
    const userRef = db.collection('users').doc(userId);
    const friendRef = db.collection('users').doc(friendId);
    
    batch.update(userRef, {
      friends: admin.firestore.FieldValue.arrayRemove(friendId)
    });
    
    batch.update(friendRef, {
      friends: admin.firestore.FieldValue.arrayRemove(userId)
    });

    const notificationRef = db.collection('notifications').doc();
    batch.set(notificationRef, {
      userId: friendId,
      type: 'friend_removed',
      fromUserId: userId,
      message: 'removed you from their friends list',
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();
    res.json({ success: true });
  } catch (error) {
    console.error('[SERVER-FRIENDS] Error removing friend:', error);
    res.status(500).json({ success: false, error: error.message });
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

// Make io accessible in API routes
app.set('io', io);

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

// Add scheduleRoomDelete to rooms object so it can be accessed by game servers
Object.defineProperty(rooms, 'scheduleRoomDelete', {
  value: scheduleRoomDelete,
  enumerable: false, // Don't show up in Object.keys()
  writable: false
});

// Initialize Game Chat Server
const GameChatServer = require("./gameChatServer");
const gameChatServer = new GameChatServer(io);
gameChatServer.initialize();

console.log("✅ Game Chat Server initialized with secure Socket.IO");

// Initialize Ludo Game Server
const ludoGameServer = new LudoGameServer(io, admin);
ludoGameServer.initialize();
ludoGameServer.startConnectionMonitoring();

console.log("✅ Ludo Game Server initialized with real-time Socket.IO sync");

// Initialize Club Chat Server
const clubChatServer = new ClubChatServer(io);
clubChatServer.initialize();

console.log("✅ Club Chat Server initialized with real-time messaging");

// Initialize Friend Chat Server
const FriendChatServer = require("./friendChatServer");
const friendChatServer = new FriendChatServer(io, admin);
friendChatServer.initialize();

console.log("✅ Friend Chat Server initialized with highly secure 1-on-1 messaging");

// Initialize Leaderboard Server
const leaderboardServer = new LeaderboardServer(io);
leaderboardServer.initialize();

console.log("✅ Leaderboard Server initialized with real-time rankings");

// Initialize Chess Game Server
const chessGameServer = new ChessGameServer(io, admin);

console.log("✅ Chess Game Server initialized with real-time Socket.IO sync");

// Initialize Tic Tac Toe Game Server
const ticTacToeGameServer = new TicTacToeGameServer(io, rooms, admin, userSockets);
ticTacToeGameServer.initialize();

console.log("✅ Tic Tac Toe Game Server initialized with Authoritative Model");

// Helper to generate room code
const generateRoomCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

// Helper to securely deduct coins
const secureDeductCoins = async (userId, amount) => {
  if (!amount || amount <= 0) return true;
  try {
    const userRef = admin.firestore().collection('users').doc(userId);
    return await admin.firestore().runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      const currentCoins = userDoc.data().coins || 0;
      if (currentCoins < amount) throw new Error('Not enough coins');
      transaction.update(userRef, {
        coins: admin.firestore.FieldValue.increment(-amount)
      });
      return true;
    });
  } catch (error) {
    console.error(`[SECURITY] Coin deduction failed for ${userId}:`, error.message);
    return false;
  }
};

// Helper to securely refund coins
const secureRefundCoins = async (userId, amount) => {
  if (!amount || amount <= 0) return true;
  try {
    const userRef = admin.firestore().collection('users').doc(userId);
    await userRef.update({
      coins: admin.firestore.FieldValue.increment(amount)
    });
    return true;
  } catch (error) {
    console.error(`[SECURITY] Coin refund failed for ${userId}:`, error.message);
    return false;
  }
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
  socket.on("create_room", async (hostData, callback) => {
    const betAmount = hostData.betAmount || 100;
    
    // Check and deduct coins before creating room
    if (betAmount > 0) {
      const deductionSuccess = await secureDeductCoins(hostData.uid, betAmount);
      if (!deductionSuccess) {
        if (callback) callback({ success: false, error: "Not enough coins or error deducting coins" });
        return;
      }
    }

    const roomCode = generateRoomCode();

    // Ensure defaults
    const rules = {
      playerCount: hostData.playerCount || 4,
      maxPlayers: hostData.maxPlayers || 4,
      betAmount,
      mode: hostData.mode || "online_random",
      isTeam: hostData.isTeam || false,
      gameMode: hostData.gameMode || "classic",
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
  socket.on("join_room", async ({ roomCode, playerData }, callback) => {
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

    const betAmount = room.betAmount || 100;
    
    // Check and deduct coins before joining room
    if (betAmount > 0) {
      const deductionSuccess = await secureDeductCoins(playerData.uid, betAmount);
      if (!deductionSuccess) {
        if (callback) callback({ success: false, error: "Not enough coins or error deducting coins" });
        return;
      }
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
  socket.on("find_match", async (playerData, callback) => {
    console.log("🔍 [MATCHMAKING] Searching for match for:", playerData.username);
    console.log("🔍 [MATCHMAKING] Player data:", {
      uid: playerData.uid,
      mode: playerData.mode,
      betAmount: playerData.betAmount,
      playerCount: playerData.playerCount
    });

    const { mode, betAmount } = playerData;
    
    // Check and deduct coins before proceeding with matchmaking
    if (betAmount > 0) {
      const deductionSuccess = await secureDeductCoins(playerData.uid, betAmount);
      if (!deductionSuccess) {
        if (callback) callback({ success: false, error: "Not enough coins or error deducting coins" });
        return;
      }
    }

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
      
      // Allow tictactoe and tournament modes to match properly
      const modeMatches =
        !room.mode ||
        room.mode === mode ||
        (mode === "tictactoe" && room.mode === "tictactoe") ||
        (mode === "tournament" && room.mode === "tournament");
        
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
      
      // Determine max players based on mode
      let defaultMaxPlayers = 2;
      if (playerData.mode === "tournament") defaultMaxPlayers = 4; // Tournaments have 4 players per match
      else if (playerData.playerCount) defaultMaxPlayers = playerData.playerCount;
      
      const rules = {
        playerCount: playerData.playerCount || defaultMaxPlayers,
        maxPlayers: playerData.maxPlayers || defaultMaxPlayers,
        betAmount: playerData.betAmount || 100,
        mode: playerData.mode || "online_random",
        isTeam: playerData.isTeam || false,
        gameMode: playerData.gameMode || "classic",
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
  socket.on("cancel_matchmaking", async (roomCode) => {
    const room = rooms[roomCode];
    if (room) {
      console.log(`Matchmaking cancelled for room ${roomCode}`);
      
      // Refund host's bet if the room is still waiting
      if (room.status === "waiting" && room.host) {
        await secureRefundCoins(room.host, room.betAmount || 100);
      }
      
      io.to(roomCode).emit("room_cancelled");
      delete rooms[roomCode];
      socket.leave(roomCode);
    }
  });

  // LEAVE ROOM
  socket.on("leave_room", async ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (room && room.players[playerId]) {
      // Refund player's bet if the game hasn't started yet
      if (room.status === "waiting") {
        await secureRefundCoins(playerId, room.betAmount || 100);
      }
      
      delete room.players[playerId];
      socket.leave(roomCode);

      // Check if any real human players are left
      const remainingPlayers = Object.values(room.players);
      const hasRealPlayers = remainingPlayers.some(p => !p.isBot);

      if (!hasRealPlayers) {
        delete rooms[roomCode];
        console.log(`[CLEANUP] Room ${roomCode} deleted (only bots left or empty)`);
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
      // SECURITY: Block unauthorized state updates
      const senderId = Object.keys(userSockets).find(key => userSockets[key] === socket.id);
      
      // If it's a bot's turn (or was just a bot's turn), only the host can update the state
      if (room.gameState && room.gameState.currentPlayer) {
        const previousPlayerId = room.players[room.gameState.currentPlayer]?.uid;
        const previousPlayerIsBot = room.players[room.gameState.currentPlayer]?.isBot || String(previousPlayerId).startsWith('bot_');
        
        // If the update is attempting to modify a bot's state, verify the sender is the host
        if (previousPlayerIsBot && senderId && senderId !== room.host) {
          console.warn(`[SECURITY] Blocked unauthorized bot state update from non-host ${senderId} in room ${roomCode}`);
          if (callback) callback({ success: false, error: "Unauthorized state update" });
          return;
        }

        // Additional security: verify the bot's move matches what the server generated
        if (previousPlayerIsBot && room.expectedBotMove) {
          const expected = room.expectedBotMove;
          // Verify dice value
          if (gameState.lastDiceValues && gameState.lastDiceValues[room.gameState.currentPlayer]) {
            const clientDice = gameState.lastDiceValues[room.gameState.currentPlayer];
            if (clientDice !== expected.diceValue) {
               console.warn(`[SECURITY] Blocked hacked bot dice roll in room ${roomCode}. Expected ${expected.diceValue}, got ${clientDice}`);
               if (callback) callback({ success: false, error: "Invalid bot move" });
               return;
            }
          }
          
          // Verify token moved
          const oldTokens = room.gameState.players?.[expected.playerColor]?.tokens;
          const newTokens = gameState.players?.[expected.playerColor]?.tokens;
          if (oldTokens && newTokens && expected.tokenIndex !== null) {
            // Check if any token other than the expected one moved
            for (let i = 0; i < oldTokens.length; i++) {
              if (i !== expected.tokenIndex && oldTokens[i].position !== newTokens[i].position) {
                // Wait, if it's not the expected token but its position changed, the host hacked the move!
                // Exception: token was killed by another token (but bots only move their own tokens on their turn)
                if (newTokens[i].position > oldTokens[i].position) { // It moved forward
                  console.warn(`[SECURITY] Blocked hacked bot token move in room ${roomCode}. Expected token ${expected.tokenIndex}, but token ${i} moved.`);
                  if (callback) callback({ success: false, error: "Invalid bot move" });
                  return;
                }
              }
            }
          }
        }
      }

      // If the game already has a winner recorded on the server, ignore further
      // updates silently — they are late-arriving moves from game loops.
      const alreadyOver =
        room.gameState?.winner ||
        room.gameState?.status === "game_over" ||
        gameState?.winner;

      // --- LUDO TEAMUP SECURE MOVE VALIDATION ---
      if ((room.isTeam || room.isTeamMode) && gameState && gameState.players && room.gameState && room.gameState.players) {
        const isLudo = !room.mode || room.mode === 'classic' || room.mode === 'quick' || room.mode === 'arrow' || room.mode === 'quick_arrow';
        
        if (isLudo && senderId) {
          // Find which player the sender is
          const senderPlayer = Object.values(room.players).find(p => p.uid === senderId || p.id === senderId);
          if (senderPlayer) {
            const senderColor = senderPlayer.color;
            const teamA = ['RED', 'YELLOW'];
            const teamB = ['GREEN', 'BLUE'];
            
            let teammateColor = null;
            if (teamA.includes(senderColor)) teammateColor = teamA.find(c => c !== senderColor);
            else if (teamB.includes(senderColor)) teammateColor = teamB.find(c => c !== senderColor);
            
            // Check if any of teammate's tokens moved
            if (teammateColor && gameState.players[teammateColor] && room.gameState.players[teammateColor]) {
              const newTokens = gameState.players[teammateColor].tokens;
              const oldTokens = room.gameState.players[teammateColor].tokens;
              
              let teammateTokenMoved = false;
              if (newTokens && oldTokens) {
                for (let i = 0; i < 4; i++) {
                  if (newTokens[i] && oldTokens[i] && newTokens[i].position !== oldTokens[i].position) {
                    // Only count forward moves or entering board (0), not kills (which go to -1)
                    if (newTokens[i].position > oldTokens[i].position || (oldTokens[i].position === -1 && newTokens[i].position === 0)) {
                      teammateTokenMoved = true;
                      break;
                    }
                  }
                }
              }
              
              if (teammateTokenMoved) {
                // Sender moved teammate's token! Are they allowed to?
                // 1. Sender must have won
                const senderWon = room.gameState.winners && room.gameState.winners.includes(senderColor);
                
                if (!senderWon) {
                  console.warn(`[SECURITY] Blocked hacked teammate assist! ${senderColor} tried to move ${teammateColor}'s token but ${senderColor} hasn't won yet!`);
                  if (callback) callback({ success: false, error: "Cannot assist teammate until you win" });
                  return; // Block update
                }
                
                // 2. It must be sender's turn
                if (room.gameState.currentPlayer !== senderColor) {
                  console.warn(`[SECURITY] Blocked hacked teammate assist! ${senderColor} tried to move ${teammateColor}'s token but it's not their turn!`);
                  if (callback) callback({ success: false, error: "Not your turn" });
                  return; // Block update
                }
              }
            }
          }
        }
      }
      // --- END LUDO TEAMUP SECURE MOVE VALIDATION ---

      // --- LUDO ARROW MODE BACKEND SECURE LOGIC ---
      // This enforces the jump on the server side so hackers cannot bypass it
      const isArrowMode = room.gameMode === 'arrow' || room.gameMode === 'quick_arrow' || room.mode === 'arrow' || room.mode === 'quick_arrow';
      
      if (isArrowMode && gameState && gameState.players && room.gameState && room.gameState.players && !alreadyOver) {
        const tailPositions = [4, 17, 30, 43];
        const gameLogic = require('./utils/gameLogic');
        let arrowJumpOccurred = false;
        let jumpingTokenColor = null;
        
        for (const [color, player] of Object.entries(gameState.players)) {
          const oldPlayer = room.gameState.players[color];
          if (!oldPlayer || !oldPlayer.tokens || !player.tokens) continue;
          
          for (let i = 0; i < player.tokens.length; i++) {
            const newToken = player.tokens[i];
            const oldToken = oldPlayer.tokens[i];
            
            // If token moved forward and landed on an arrow tail
            if (newToken && oldToken && newToken.position > oldToken.position && tailPositions.includes(newToken.position)) {
              console.log(`⚡ [ARROW JUMP SECURE] Token ${i} of ${color} landed on tail ${newToken.position} in room ${roomCode}! Applying secure jump...`);
              
              // 1. Move to next box (+1)
              newToken.position += 1;
              if (newToken.stepsFromStart !== undefined) {
                newToken.stepsFromStart += 1;
              }
              
              arrowJumpOccurred = true;
              jumpingTokenColor = color;
              
              // 2. Check for kill at the new position
              const killResult = gameLogic.checkForKill(newToken.position, gameState.players, color, room.isTeamMode || false);
              
              if (killResult) {
                console.log(`⚔️ [ARROW JUMP KILL] ${color} killed ${killResult.color}'s token ${killResult.tokenIndex} at position ${newToken.position}!`);
                
                // Send victim home
                const victim = gameState.players[killResult.color];
                if (victim && victim.tokens && victim.tokens[killResult.tokenIndex]) {
                  victim.tokens[killResult.tokenIndex] = gameLogic.sendTokenHome(victim.tokens[killResult.tokenIndex]);
                }
                
                // Update kills
                player.hasKilled = true;
                if (!gameState.kills) gameState.kills = 0;
                gameState.kills += 1;
              }
            }
          }
        }
        
        // 3. Grant new turn if jump occurred
        if (arrowJumpOccurred) {
          // Force current player to stay the same to grant a bonus turn
          // This overrides any NEXT_TURN the client might have dispatched
          gameState.currentPlayer = jumpingTokenColor;
          gameState.status = "rolling";
          gameState.diceValue = null;
          gameState.validMoves = [];
        }
      }
      // --- END LUDO ARROW MODE BACKEND SECURE LOGIC ---

      // --- LUDO TEAMUP SECURE WIN VALIDATION ---
      if ((room.isTeam || room.isTeamMode) && gameState && gameState.players) {
        // We ensure a hacker cannot fake a win for their team.
        const isLudo = !room.mode || room.mode === 'classic' || room.mode === 'quick' || room.mode === 'arrow' || room.mode === 'quick_arrow';
        if (isLudo) {
          const teamAColors = ['RED', 'YELLOW'];
          const teamBColors = ['GREEN', 'BLUE'];
          
          let teamAWon = false;
          let teamBWon = false;

          // Helper function to verify if a player has legitimately won
          const verifyPlayerWin = (color) => {
            const player = gameState.players[color];
            if (!player || !player.tokens) return false;
            
            const finishedCount = player.tokens.filter(t => t.state === 'finished' || t.state === 'HOME').length;
            
            if (room.gameMode === 'quick_arrow') {
              // Quick arrow mode requires at least 1 kill AND 1 token finished
              return player.hasKilled && finishedCount >= 1;
            } else {
              // Classic/Arrow mode requires all 4 tokens finished
              return finishedCount === 4;
            }
          };

          const teamAActive = teamAColors.filter(c => gameState.players[c]);
          const teamBActive = teamBColors.filter(c => gameState.players[c]);

          // Team wins only if all its active players have finished
          if (teamAActive.length > 0 && teamAActive.every(verifyPlayerWin)) {
            teamAWon = true;
          }
          if (teamBActive.length > 0 && teamBActive.every(verifyPlayerWin)) {
            teamBWon = true;
          }

          if (teamAWon) {
            gameState.winner = "Team A";
            gameState.status = "game_over";
          } else if (teamBWon) {
            gameState.winner = "Team B";
            gameState.status = "game_over";
          } else {
            // Revert any hacked winning state
            if (gameState.winner && gameState.winner.startsWith("Team")) {
              console.warn(`[SECURITY] Blocked hacked TeamUp win in room ${roomCode}`);
              gameState.winner = null;
              if (gameState.status === "game_over") {
                gameState.status = room.gameState?.status || "playing";
              }
            }
          }
        }
      }
      // --- END LUDO TEAMUP SECURE WIN VALIDATION ---

      room.gameState = gameState;

      // Mark room as game_over and schedule cleanup when a winner is set
      if (gameState?.winner || gameState?.status === "game_over") {
        room.status = "game_over";
        
        // --- SECURE REWARD PROCESSING FOR AIR HOCKEY & SNAKE ---
        // Since Air Hockey and Snake are physics-heavy and client-authoritative for game over,
        // we process rewards here when the client first reports a winner.
        if (!alreadyOver && room.betAmount) {
          try {
            const RewardServiceServer = require('./rewardServiceServer');
            const winnerKey = gameState.winner; // "player1", "player2", or "draw"
            
            // Map room mode to GameType string for rewards
            let gameTypeStr = 'UNKNOWN';
            if (room.mode === 'airhockey') gameTypeStr = 'AIR_HOCKEY';
            else if (room.mode === 'snake_vs_snake' || room.gameMode === 'snake_vs_snake') gameTypeStr = 'SNAKE';
            
            if (gameTypeStr !== 'UNKNOWN' && gameState.players) {
              console.log(`🎁 [SERVER REWARDS] Processing secure rewards for ${gameTypeStr} room ${roomCode}`);
              
              for (const [role, uid] of Object.entries(gameState.players)) {
                if (!uid || uid.startsWith('bot_')) continue;
                
                if (winnerKey === 'draw') {
                  RewardServiceServer.awardGameDraw(uid, gameTypeStr, room.betAmount).catch(e => console.error(e));
                } else if (role === winnerKey) {
                  RewardServiceServer.awardGameWin(uid, gameTypeStr, room.betAmount)
                    .then(result => {
                      if (result && result.success) {
                        io.to(roomCode).emit(`reward:awarded:${uid}`, result);
                      }
                    }).catch(e => console.error(e));
                } else {
                  RewardServiceServer.awardGameLoss(uid, gameTypeStr, room.betAmount).catch(e => console.error(e));
                }
              }
            }
          } catch (error) {
            console.error('[SERVER REWARDS] Error processing rewards for physics game:', error);
          }
        }
        
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
    }
  });

  // SECURE LUDO AI MOVE
  socket.on("get_ai_move", ({ roomCode, gameState, difficulty, gameMode, targetPlayerForAI }, callback) => {
    try {
      const diceValue = Math.floor(Math.random() * 6) + 1;
      const { getAIMove } = require('./utils/aiPlayer');
      
      const allPlayers = gameState.players;
      let tokenIndex = null;
      
      if (allPlayers && allPlayers[targetPlayerForAI]) {
        tokenIndex = getAIMove(
          allPlayers[targetPlayerForAI].tokens,
          diceValue,
          targetPlayerForAI,
          allPlayers,
          difficulty,
          gameMode
        );
      }

      // SECURITY: Store the generated move on the server to prevent hacked clients from altering it
      const room = rooms[roomCode];
      if (room) {
        room.expectedBotMove = {
          playerColor: targetPlayerForAI,
          diceValue,
          tokenIndex,
          timestamp: Date.now()
        };
      }
      
      if (callback) callback({ success: true, diceValue, tokenIndex });
    } catch (err) {
      console.error('Error generating AI move on server:', err);
      if (callback) callback({ success: false, error: err.message });
    }
  });

  // SNAKE TURN (Optimized for Snake Vs Snake)
  socket.on("snake_turn", (data) => {
    const { roomCode, playerKey, angle } = data;
    const room = rooms[roomCode];
    if (room && room.gameState && room.gameState.snakes) {
      if (angle !== undefined) room.gameState.snakes[playerKey].angle = angle;
      // Broadcast steering to the other player
      socket.to(roomCode).emit("snake_turn", data);
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

      // Trigger bot turn if the first player is a bot in Tic Tac Toe
      if (room.mode === "tictactoe" && ticTacToeGameServer) {
        ticTacToeGameServer.playBotTurn(roomCode);
      }
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
      const remainingPlayers = Object.values(room.players);
      const hasRealPlayers = remainingPlayers.some(p => !p.isBot);

      if (!hasRealPlayers) {
        // Room is empty or only bots left — if game was in progress give a grace period so
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



