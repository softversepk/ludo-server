/**
 * Leaderboard Server with Socket.IO
 * Real-time ranking updates for players and clubs
 */
const admin = require('firebase-admin');

class LeaderboardServer {
  constructor(io) {
    this.io = io;
    this.playerLeaderboard = new Map(); // userId -> { rank, score, wins, etc }
    this.clubLeaderboard = new Map(); // clubId -> { rank, points, members, etc }
    this.subscribedUsers = new Map(); // socketId -> { userId, subscriptions }
    this.updateInterval = null;
    this.fetchInterval = null;
    this.isFetching = false;
  }

  /**
   * Fetch leaderboard from Firebase to keep in-memory cache updated
   * This ensures Firebase quota is not exceeded (only server reads it periodically)
   */
  async fetchFromFirebase() {
    if (this.isFetching) return;
    this.isFetching = true;
    try {
      if (!admin.apps.length) {
        console.warn('⚠️ [LEADERBOARD] Firebase Admin not initialized, cannot fetch leaderboard');
        this.isFetching = false;
        return;
      }
      
      const db = admin.firestore();
      
      // Fetch top 100 players by weeklyProfitCoins
      const playersSnapshot = await db.collection('users')
        .orderBy('weeklyProfitCoins', 'desc')
        .limit(100)
        .get();
        
      const newPlayers = new Map();
      playersSnapshot.docs.forEach((doc, index) => {
        const data = doc.data();
        newPlayers.set(doc.id, {
          userId: doc.id,
          username: data.username || 'Unknown',
          avatar: data.avatar || '',
          score: data.weeklyProfitCoins || 0,
          wins: data.gamesWon || 0,
          gamesPlayed: data.gamesPlayed || 0,
          clubId: data.clubId || null,
          rank: index + 1,
          lastUpdated: Date.now()
        });
      });
      
      this.playerLeaderboard = newPlayers;
      console.log(`✅ [LEADERBOARD SECURE] Fetched ${this.playerLeaderboard.size} players from Firebase`);
      
    } catch (error) {
      console.error('❌ [LEADERBOARD SECURE] Error fetching from Firebase:', error);
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Initialize Socket.IO event handlers
   */
  initialize() {
    this.io.on('connection', (socket) => {
      console.log(`✅ [LEADERBOARD] User connected: ${socket.id}`);

      // Subscribe to leaderboard updates
      socket.on('leaderboard:subscribe', (data) => this.handleSubscribe(socket, data));

      // Unsubscribe from leaderboard
      socket.on('leaderboard:unsubscribe', (data) => this.handleUnsubscribe(socket, data));

      // Request current leaderboard
      socket.on('leaderboard:request', (data) => this.handleRequest(socket, data));

      // Request player rank
      socket.on('leaderboard:get_player_rank', (data) => this.handleGetPlayerRank(socket, data));

      // Request club rank
      socket.on('leaderboard:get_club_rank', (data) => this.handleGetClubRank(socket, data));

      // Disconnection
      socket.on('disconnect', () => this.handleDisconnect(socket));
    });

    // Initial fetch from Firebase
    this.fetchFromFirebase();

    // Start periodic leaderboard recalculation and fetching
    this.startLeaderboardUpdates();
  }

  /**
   * Handle subscribe to leaderboard updates
   */
  handleSubscribe(socket, { userId, type = 'both' }) {
    try {
      console.log(`📊 [LEADERBOARD] User ${userId} subscribing to ${type}`);

      // Track subscription
      this.subscribedUsers.set(socket.id, {
        userId,
        subscriptions: type, // 'players', 'clubs', or 'both'
        subscribedAt: Date.now()
      });

      // Join appropriate rooms
      if (type === 'players' || type === 'both') {
        socket.join('leaderboard:players');
      }
      if (type === 'clubs' || type === 'both') {
        socket.join('leaderboard:clubs');
      }

      // Send current leaderboard immediately
      this.sendCurrentLeaderboard(socket, type);

      socket.emit('leaderboard:subscribe_success', {
        type,
        timestamp: Date.now()
      });

      console.log(`✅ [LEADERBOARD] User ${userId} subscribed to ${type}`);
    } catch (error) {
      console.error('❌ [LEADERBOARD SUBSCRIBE ERROR]', error);
      socket.emit('leaderboard:subscribe_error', { error: error.message });
    }
  }

  /**
   * Handle unsubscribe from leaderboard
   */
  handleUnsubscribe(socket, { type = 'both' }) {
    try {
      if (type === 'players' || type === 'both') {
        socket.leave('leaderboard:players');
      }
      if (type === 'clubs' || type === 'both') {
        socket.leave('leaderboard:clubs');
      }

      this.subscribedUsers.delete(socket.id);
      console.log(`👋 [LEADERBOARD] User unsubscribed from ${type}`);
    } catch (error) {
      console.error('❌ [LEADERBOARD UNSUBSCRIBE ERROR]', error);
    }
  }

  /**
   * Handle leaderboard request
   */
  handleRequest(socket, { type = 'players', limit = 100, offset = 0 }) {
    try {
      console.log(`📊 [LEADERBOARD] Request for ${type}, limit: ${limit}, offset: ${offset}`);

      if (type === 'players') {
        const leaderboard = this.getPlayerLeaderboard(limit, offset);
        socket.emit('leaderboard:players_data', {
          leaderboard,
          total: this.playerLeaderboard.size,
          timestamp: Date.now()
        });
      } else if (type === 'clubs') {
        const leaderboard = this.getClubLeaderboard(limit, offset);
        socket.emit('leaderboard:clubs_data', {
          leaderboard,
          total: this.clubLeaderboard.size,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('❌ [LEADERBOARD REQUEST ERROR]', error);
      socket.emit('leaderboard:request_error', { error: error.message });
    }
  }

  /**
   * Internal method to handle player score update (Secure, called from backend)
   */
  updatePlayerInternal({ userId, username, avatar, score, wins, gamesPlayed, clubId }) {
    try {
      console.log(`🎮 [PLAYER UPDATE SECURE] ${username}: Score ${score}, Wins ${wins}`);

      // Get current player data
      const currentData = this.playerLeaderboard.get(userId) || {};
      const oldRank = currentData.rank;

      // Update player data
      const playerData = {
        userId,
        username,
        avatar,
        score: score || 0,
        wins: wins || 0,
        gamesPlayed: gamesPlayed || 0,
        clubId: clubId || null,
        lastUpdated: Date.now()
      };

      this.playerLeaderboard.set(userId, playerData);

      // Recalculate ranks
      this.recalculatePlayerRanks();

      // Get new rank
      const newRank = this.playerLeaderboard.get(userId).rank;

      // Broadcast rank change if significant
      if (oldRank !== newRank) {
        this.broadcastRankChange('player', {
          userId,
          username,
          oldRank,
          newRank,
          score,
          wins
        });
      }

      console.log(`✅ [PLAYER UPDATE SECURE] ${username} now rank #${newRank}`);
      return { success: true, rank: newRank };
    } catch (error) {
      console.error('❌ [PLAYER UPDATE ERROR]', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Internal method to handle club points update (Secure, called from backend)
   */
  updateClubInternal({ clubId, clubName, badge, points, memberCount, gamesPlayed }) {
    try {
      console.log(`🏆 [CLUB UPDATE SECURE] ${clubName}: Points ${points}`);

      // Get current club data
      const currentData = this.clubLeaderboard.get(clubId) || {};
      const oldRank = currentData.rank;

      // Update club data
      const clubData = {
        clubId,
        clubName,
        badge,
        points: points || 0,
        memberCount: memberCount || 0,
        gamesPlayed: gamesPlayed || 0,
        lastUpdated: Date.now()
      };

      this.clubLeaderboard.set(clubId, clubData);

      // Recalculate ranks
      this.recalculateClubRanks();

      // Get new rank
      const newRank = this.clubLeaderboard.get(clubId).rank;

      // Broadcast rank change if significant
      if (oldRank !== newRank) {
        this.broadcastRankChange('club', {
          clubId,
          clubName,
          oldRank,
          newRank,
          points
        });
      }

      console.log(`✅ [CLUB UPDATE SECURE] ${clubName} now rank #${newRank}`);
      return { success: true, rank: newRank };
    } catch (error) {
      console.error('❌ [CLUB UPDATE ERROR]', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle get player rank request
   */
  handleGetPlayerRank(socket, { userId }) {
    try {
      const playerData = this.playerLeaderboard.get(userId);
      
      if (playerData) {
        socket.emit('leaderboard:player_rank', {
          userId,
          rank: playerData.rank,
          score: playerData.score,
          wins: playerData.wins,
          total: this.playerLeaderboard.size,
          timestamp: Date.now()
        });
      } else {
        socket.emit('leaderboard:player_rank', {
          userId,
          rank: null,
          message: 'Player not ranked yet',
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('❌ [GET PLAYER RANK ERROR]', error);
      socket.emit('leaderboard:rank_error', { error: error.message });
    }
  }

  /**
   * Handle get club rank request
   */
  handleGetClubRank(socket, { clubId }) {
    try {
      const clubData = this.clubLeaderboard.get(clubId);
      
      if (clubData) {
        socket.emit('leaderboard:club_rank', {
          clubId,
          rank: clubData.rank,
          points: clubData.points,
          memberCount: clubData.memberCount,
          total: this.clubLeaderboard.size,
          timestamp: Date.now()
        });
      } else {
        socket.emit('leaderboard:club_rank', {
          clubId,
          rank: null,
          message: 'Club not ranked yet',
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('❌ [GET CLUB RANK ERROR]', error);
      socket.emit('leaderboard:rank_error', { error: error.message });
    }
  }

  /**
   * Handle disconnection
   */
  handleDisconnect(socket) {
    try {
      const userInfo = this.subscribedUsers.get(socket.id);
      if (userInfo) {
        console.log(`❌ [LEADERBOARD] User ${userInfo.userId} disconnected`);
        this.subscribedUsers.delete(socket.id);
      }
    } catch (error) {
      console.error('❌ [DISCONNECT ERROR]', error);
    }
  }

  /**
   * Recalculate player ranks
   */
  recalculatePlayerRanks() {
    // Convert to array and sort by score (descending), then by wins
    const players = Array.from(this.playerLeaderboard.values())
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.wins - a.wins;
      });

    // Assign ranks
    players.forEach((player, index) => {
      player.rank = index + 1;
      this.playerLeaderboard.set(player.userId, player);
    });
  }

  /**
   * Recalculate club ranks
   */
  recalculateClubRanks() {
    // Convert to array and sort by points (descending)
    const clubs = Array.from(this.clubLeaderboard.values())
      .sort((a, b) => b.points - a.points);

    // Assign ranks
    clubs.forEach((club, index) => {
      club.rank = index + 1;
      this.clubLeaderboard.set(club.clubId, club);
    });
  }

  /**
   * Get player leaderboard
   */
  getPlayerLeaderboard(limit = 100, offset = 0) {
    const players = Array.from(this.playerLeaderboard.values())
      .sort((a, b) => a.rank - b.rank)
      .slice(offset, offset + limit);

    return players.map(player => ({
      userId: player.userId,
      username: player.username,
      avatar: player.avatar,
      rank: player.rank,
      score: player.score,
      wins: player.wins,
      gamesPlayed: player.gamesPlayed,
      clubId: player.clubId
    }));
  }

  /**
   * Get club leaderboard
   */
  getClubLeaderboard(limit = 100, offset = 0) {
    const clubs = Array.from(this.clubLeaderboard.values())
      .sort((a, b) => a.rank - b.rank)
      .slice(offset, offset + limit);

    return clubs.map(club => ({
      clubId: club.clubId,
      clubName: club.clubName,
      badge: club.badge,
      rank: club.rank,
      points: club.points,
      memberCount: club.memberCount,
      gamesPlayed: club.gamesPlayed
    }));
  }

  /**
   * Send current leaderboard to socket
   */
  sendCurrentLeaderboard(socket, type) {
    if (type === 'players' || type === 'both') {
      const playerLeaderboard = this.getPlayerLeaderboard(100, 0);
      socket.emit('leaderboard:players_data', {
        leaderboard: playerLeaderboard,
        total: this.playerLeaderboard.size,
        timestamp: Date.now()
      });
    }

    if (type === 'clubs' || type === 'both') {
      const clubLeaderboard = this.getClubLeaderboard(100, 0);
      socket.emit('leaderboard:clubs_data', {
        leaderboard: clubLeaderboard,
        total: this.clubLeaderboard.size,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Broadcast rank change to all subscribers
   */
  broadcastRankChange(type, data) {
    const room = type === 'player' ? 'leaderboard:players' : 'leaderboard:clubs';
    
    this.io.to(room).emit('leaderboard:rank_changed', {
      type,
      ...data,
      timestamp: Date.now()
    });

    console.log(`📢 [RANK CHANGE] ${type}: ${data.username || data.clubName} ${data.oldRank || 'unranked'} → #${data.newRank}`);
  }

  /**
   * Start periodic leaderboard updates
   */
  startLeaderboardUpdates() {
    // Fetch from Firebase every 5 minutes to keep things in sync (saves quota)
    this.fetchInterval = setInterval(() => {
      this.fetchFromFirebase();
    }, 5 * 60 * 1000);

    // Broadcast full leaderboard every 30 seconds
    this.updateInterval = setInterval(() => {
      // Broadcast to players room
      const playerLeaderboard = this.getPlayerLeaderboard(100, 0);
      this.io.to('leaderboard:players').emit('leaderboard:players_update', {
        leaderboard: playerLeaderboard,
        total: this.playerLeaderboard.size,
        timestamp: Date.now()
      });

      // Broadcast to clubs room
      const clubLeaderboard = this.getClubLeaderboard(100, 0);
      this.io.to('leaderboard:clubs').emit('leaderboard:clubs_update', {
        leaderboard: clubLeaderboard,
        total: this.clubLeaderboard.size,
        timestamp: Date.now()
      });

      console.log(`📊 [LEADERBOARD] Periodic update sent. Players: ${this.playerLeaderboard.size}, Clubs: ${this.clubLeaderboard.size}`);
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop periodic updates
   */
  stopLeaderboardUpdates() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    if (this.fetchInterval) {
      clearInterval(this.fetchInterval);
      this.fetchInterval = null;
    }
  }

  /**
   * Get server stats
   */
  getStats() {
    return {
      totalPlayers: this.playerLeaderboard.size,
      totalClubs: this.clubLeaderboard.size,
      subscribedUsers: this.subscribedUsers.size,
      topPlayer: this.getPlayerLeaderboard(1, 0)[0] || null,
      topClub: this.getClubLeaderboard(1, 0)[0] || null
    };
  }
}

module.exports = LeaderboardServer;
