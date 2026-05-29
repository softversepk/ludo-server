/**
 * Secure Leaderboard Service - Backend Only
 * All leaderboard logic runs on the server to prevent client-side manipulation
 * Implements comprehensive security measures against hacking attempts
 */

const admin = require('firebase-admin');

class SecureLeaderboardService {
  constructor() {
    this.db = admin.firestore();
    this.auth = admin.auth();
    
    // Rate limiting: Track requests per user
    this.requestTracker = new Map(); // userId -> { count, resetTime }
    this.MAX_REQUESTS_PER_MINUTE = 30;
    
    // Anomaly detection: Track suspicious patterns
    this.anomalyTracker = new Map(); // userId -> { lastUpdate, updateCount, flagged }
    
    console.log('🔒 [SECURE LEADERBOARD] Service initialized with security measures');
  }

  /**
   * Verify Firebase ID token and extract user ID
   */
  async verifyToken(token) {
    try {
      if (!token || token === 'development-key') {
        throw new Error('Invalid or missing authentication token');
      }

      const decodedToken = await this.auth.verifyIdToken(token);
      return { success: true, userId: decodedToken.uid, email: decodedToken.email };
    } catch (error) {
      console.error('❌ [AUTH] Token verification failed:', error.message);
      return { success: false, error: 'Authentication failed' };
    }
  }

  /**
   * Rate limiting check
   */
  checkRateLimit(userId) {
    const now = Date.now();
    const userTracker = this.requestTracker.get(userId);

    if (!userTracker || now > userTracker.resetTime) {
      // Reset or initialize tracker
      this.requestTracker.set(userId, {
        count: 1,
        resetTime: now + 60000 // 1 minute
      });
      return { allowed: true };
    }

    if (userTracker.count >= this.MAX_REQUESTS_PER_MINUTE) {
      console.warn(`⚠️ [RATE LIMIT] User ${userId} exceeded rate limit`);
      return { allowed: false, error: 'Rate limit exceeded. Please try again later.' };
    }

    userTracker.count++;
    return { allowed: true };
  }

  /**
   * Anomaly detection for suspicious update patterns
   */
  detectAnomaly(userId, updateType) {
    const now = Date.now();
    const tracker = this.anomalyTracker.get(userId) || {
      lastUpdate: 0,
      updateCount: 0,
      flagged: false
    };

    // Check for rapid updates (potential bot)
    const timeSinceLastUpdate = now - tracker.lastUpdate;
    if (timeSinceLastUpdate < 1000) { // Less than 1 second
      tracker.updateCount++;
      if (tracker.updateCount > 5) {
        tracker.flagged = true;
        console.error(`🚨 [ANOMALY] User ${userId} flagged for suspicious activity: ${updateType}`);
        return { suspicious: true, reason: 'Rapid update pattern detected' };
      }
    } else {
      tracker.updateCount = 0;
    }

    tracker.lastUpdate = now;
    this.anomalyTracker.set(userId, tracker);
    return { suspicious: false };
  }

  /**
   * Get current league configuration
   */
  async getLeagueConfig() {
    try {
      const configDoc = await this.db.collection('systemSettings').doc('leagueConfig').get();
      if (configDoc.exists) {
        return configDoc.data();
      }
      // Default configuration
      return {
        type: 'day_to_day',
        startDay: 1, // Monday
        durationDays: 7
      };
    } catch (error) {
      console.error('❌ [CONFIG] Error fetching league config:', error);
      return {
        type: 'day_to_day',
        startDay: 1,
        durationDays: 7
      };
    }
  }

  /**
   * Calculate current week dates based on configuration
   */
  async getCurrentWeekDates() {
    const config = await this.getLeagueConfig();
    const now = new Date();
    const weekStart = new Date(now);

    if (config.type === '1_minute') {
      const seconds = now.getSeconds();
      const milliseconds = now.getMilliseconds();
      const timeToNextMinute = (60 - seconds) * 1000 - milliseconds;
      
      const weekEnd = new Date(now.getTime() + timeToNextMinute);
      const weekStart = new Date(weekEnd.getTime() - 60 * 1000);
      return { weekStart, weekEnd };
    }

    if (config.type === 'days' && config.lastResetAt) {
      const start = new Date(config.lastResetAt);
      const cycleDuration = config.durationDays * 24 * 60 * 60 * 1000;
      const timeSinceStart = now.getTime() - start.getTime();
      const cyclesPassed = Math.floor(timeSinceStart / cycleDuration);
      
      const currentStart = new Date(start.getTime() + cyclesPassed * cycleDuration);
      const currentEnd = new Date(currentStart.getTime() + cycleDuration);
      return { weekStart: currentStart, weekEnd: currentEnd };
    }

    // Default: Day to Day
    const startDay = config.startDay !== undefined ? config.startDay : 1;
    const currentDay = weekStart.getDay();
    const daysToSubtract = currentDay === startDay ? 0 : 
      (currentDay < startDay ? 7 - startDay + currentDay : currentDay - startDay);
    
    weekStart.setDate(weekStart.getDate() - daysToSubtract);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    return { weekStart, weekEnd };
  }

  /**
   * Get current league ID
   */
  async getCurrentLeagueId() {
    const { weekStart } = await this.getCurrentWeekDates();
    const config = await this.getLeagueConfig();

    if (config.type === '1_minute') {
      return `league_${weekStart.getFullYear()}_${weekStart.getMonth() + 1}_${weekStart.getDate()}_${weekStart.getHours()}_${weekStart.getMinutes()}`;
    }

    return `league_${weekStart.getFullYear()}_${weekStart.getMonth() + 1}_${weekStart.getDate()}`;
  }

  /**
   * Get weekly leaderboard securely from Firestore
   * Only returns sanitized data, no sensitive information
   */
  async getWeeklyLeaderboard(limit = 100) {
    try {
      console.log('📊 [SECURE LEADERBOARD] Fetching weekly leaderboard from database');

      const usersSnapshot = await this.db.collection('users')
        .where('weeklyProfitCoins', '>', 0)
        .orderBy('weeklyProfitCoins', 'desc')
        .limit(limit)
        .get();

      const leaderboard = [];
      let rank = 1;

      usersSnapshot.forEach(doc => {
        const data = doc.data();
        
        // Only return safe, public data
        leaderboard.push({
          id: doc.id,
          rank: rank++,
          username: data.username || 'Player',
          avatar: data.avatar || 'default',
          weeklyProfitCoins: data.weeklyProfitCoins || 0,
          coins: data.coins || 0,
          gems: data.gems || 0,
          wins: data.wins || 0,
          gamesWon: data.gamesWon || 0,
          played: data.played || 0,
          gamesPlayed: data.gamesPlayed || 0,
          streak: data.streak || 0,
          clubId: data.clubId || null,
          createdAt: data.createdAt || null
        });
      });

      console.log(`✅ [SECURE LEADERBOARD] Fetched ${leaderboard.length} players`);
      return { success: true, leaderboard, timestamp: Date.now() };
    } catch (error) {
      console.error('❌ [SECURE LEADERBOARD] Error fetching leaderboard:', error);
      return { success: false, error: 'Failed to fetch leaderboard', leaderboard: [] };
    }
  }

  /**
   * Get user's current rank and reward securely
   */
  async getUserReward(userId) {
    try {
      console.log(`🏆 [REWARD] Calculating reward for user: ${userId}`);

      // Get user's data
      const userDoc = await this.db.collection('users').doc(userId).get();
      if (!userDoc.exists) {
        return { success: false, error: 'User not found' };
      }

      const userData = userDoc.data();
      const userWeeklyCoins = userData.weeklyProfitCoins || 0;

      // Get all users with weekly coins to calculate rank
      const usersSnapshot = await this.db.collection('users')
        .where('weeklyProfitCoins', '>', 0)
        .orderBy('weeklyProfitCoins', 'desc')
        .get();

      let rank = 0;
      let found = false;

      usersSnapshot.forEach((doc, index) => {
        if (doc.id === userId) {
          rank = index + 1;
          found = true;
        }
      });

      if (!found || rank === 0) {
        return {
          success: false,
          reason: 'User not in leaderboard',
          rank: 'N/A',
          reward: { diamonds: 0, coins: 0 }
        };
      }

      // Calculate reward based on rank
      const reward = this.calculateReward(rank);

      return {
        success: true,
        rank,
        weeklyCoins: userWeeklyCoins,
        reward
      };
    } catch (error) {
      console.error('❌ [REWARD] Error calculating user reward:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Calculate reward based on rank
   */
  calculateReward(rank) {
    if (rank === 1) {
      return { diamonds: 100, coins: 100000 };
    } else if (rank === 2) {
      return { diamonds: 50, coins: 50000 };
    } else if (rank === 3) {
      return { diamonds: 30, coins: 30000 };
    } else if (rank <= 10) {
      return { diamonds: 10, coins: 5000 };
    } else {
      return { diamonds: 0, coins: 0 };
    }
  }

  /**
   * Distribute rewards securely - Backend only operation
   * This is the ONLY place where rewards are distributed
   */
  async distributeRewards(leagueId) {
    try {
      console.log(`🏆 [DISTRIBUTE] Starting secure reward distribution for league: ${leagueId}`);

      // Get leaderboard
      const { success, leaderboard } = await this.getWeeklyLeaderboard(100);
      if (!success || leaderboard.length === 0) {
        console.log('⚠️ [DISTRIBUTE] No players to reward');
        return { success: true, rewarded: 0, message: 'No players to reward' };
      }

      const batch = this.db.batch();
      let rewardedCount = 0;

      // Distribute rewards to top players
      for (const player of leaderboard) {
        const reward = this.calculateReward(player.rank);
        
        if (reward.diamonds > 0 || reward.coins > 0) {
          const userRef = this.db.collection('users').doc(player.id);
          
          // Use FieldValue.increment for atomic updates
          batch.update(userRef, {
            gems: admin.firestore.FieldValue.increment(reward.diamonds),
            coins: admin.firestore.FieldValue.increment(reward.coins),
            weeklyProfitCoins: 0, // Reset weekly coins
            lastRewardedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastRewardLeague: leagueId
          });

          // Log reward distribution
          const rewardLogRef = this.db.collection('rewardLogs').doc();
          batch.set(rewardLogRef, {
            userId: player.id,
            username: player.username,
            leagueId,
            rank: player.rank,
            weeklyCoins: player.weeklyProfitCoins,
            reward,
            distributedAt: admin.firestore.FieldValue.serverTimestamp()
          });

          rewardedCount++;
          console.log(`💰 [DISTRIBUTE] Rank ${player.rank}: ${player.username} → ${reward.diamonds} 💎, ${reward.coins} 🪙`);
        } else {
          // Reset weekly coins for players without rewards
          const userRef = this.db.collection('users').doc(player.id);
          batch.update(userRef, {
            weeklyProfitCoins: 0
          });
        }
      }

      // Commit all updates atomically
      await batch.commit();

      console.log(`✅ [DISTRIBUTE] Successfully rewarded ${rewardedCount} players for league ${leagueId}`);
      return {
        success: true,
        rewarded: rewardedCount,
        leagueId,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('❌ [DISTRIBUTE] Error distributing rewards:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update user's weekly coins securely
   * Validates the update and prevents manipulation
   */
  async updateWeeklyCoins(userId, coinsToAdd, gameType, gameId) {
    try {
      // Validate input
      if (!userId || typeof coinsToAdd !== 'number' || coinsToAdd <= 0) {
        return { success: false, error: 'Invalid input parameters' };
      }

      // Check for anomalies
      const anomalyCheck = this.detectAnomaly(userId, 'weeklyCoins');
      if (anomalyCheck.suspicious) {
        console.error(`🚨 [SECURITY] Blocked suspicious update from user ${userId}`);
        return { success: false, error: 'Suspicious activity detected' };
      }

      // Verify game exists and user participated
      if (gameId) {
        const gameDoc = await this.db.collection('games').doc(gameId).get();
        if (!gameDoc.exists) {
          console.warn(`⚠️ [VALIDATION] Game ${gameId} not found for user ${userId}`);
          return { success: false, error: 'Invalid game reference' };
        }

        const gameData = gameDoc.data();
        const playerIds = gameData.players?.map(p => p.id) || [];
        if (!playerIds.includes(userId)) {
          console.error(`🚨 [SECURITY] User ${userId} not in game ${gameId}`);
          return { success: false, error: 'User not in game' };
        }
      }

      // Update weekly coins atomically
      const userRef = this.db.collection('users').doc(userId);
      await userRef.update({
        weeklyProfitCoins: admin.firestore.FieldValue.increment(coinsToAdd),
        lastWeeklyUpdate: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`✅ [UPDATE] User ${userId} earned ${coinsToAdd} weekly coins from ${gameType}`);
      return { success: true, coinsAdded: coinsToAdd };
    } catch (error) {
      console.error('❌ [UPDATE] Error updating weekly coins:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get leaderboard statistics
   */
  async getLeaderboardStats() {
    try {
      const usersSnapshot = await this.db.collection('users')
        .where('weeklyProfitCoins', '>', 0)
        .get();

      const totalPlayers = usersSnapshot.size;
      let totalWeeklyCoins = 0;

      usersSnapshot.forEach(doc => {
        totalWeeklyCoins += doc.data().weeklyProfitCoins || 0;
      });

      return {
        success: true,
        stats: {
          totalPlayers,
          totalWeeklyCoins,
          averageCoins: totalPlayers > 0 ? Math.floor(totalWeeklyCoins / totalPlayers) : 0
        }
      };
    } catch (error) {
      console.error('❌ [STATS] Error fetching stats:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = SecureLeaderboardService;
