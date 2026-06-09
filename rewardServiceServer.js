const admin = require('firebase-admin');
const { processUserXP } = require('./xpService');

const CLUB_POINTS_BY_BET = {
  100: 2,
  250: 3,
  500: 4,
  1000: 5,
  2500: 7,
  5000: 10,
};

const COIN_MULTIPLIER = 2.0;

class RewardServiceServer {
  static async awardGameWin(userId, gameType, betAmount = 100, position = 1, totalPlayers = 2) {
    try {
      if (!userId) return { success: false, error: 'No user ID' };
      
      const db = admin.firestore();
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();
      
      if (!userDoc.exists) return { success: false, error: 'User not found' };
      
      const userData = userDoc.data();
      const clubId = userData.clubId;
      
      let coinReward = 0;
      if (totalPlayers === 4) {
        if (position === 1) coinReward = betAmount * 3.0; // 1st place gets 3x (e.g. 300)
        else if (position === 2) coinReward = betAmount * 1.0; // 2nd place gets 1x (e.g. 100)
        else if (position === 3) coinReward = 0; // 3rd place gets 0
        else coinReward = 0;
      } else {
        coinReward = Math.floor(betAmount * COIN_MULTIPLIER); // Default 2.0
      }
      
      const clubPointReward = CLUB_POINTS_BY_BET[betAmount] || Math.max(1, Math.floor(betAmount / 100));
      
      // Award coins
      const batch = db.batch();
      
      const updateData = {
        gamesPlayed: admin.firestore.FieldValue.increment(1)
      };

      if (position === 1) {
        updateData.gamesWon = admin.firestore.FieldValue.increment(1);
      }

      if (coinReward > 0) {
        updateData.coins = admin.firestore.FieldValue.increment(coinReward);
        updateData.totalCoinsEarned = admin.firestore.FieldValue.increment(coinReward);
        updateData.weeklyCoins = admin.firestore.FieldValue.increment(coinReward);
        updateData.weeklyProfitCoins = admin.firestore.FieldValue.increment(coinReward);
      }
      
      batch.update(userRef, updateData);
      
      // Award club points if in a club
      let clubName = null;
      if (clubId) {
        const clubRef = db.collection('clubs').doc(clubId);
        const clubDoc = await clubRef.get();
        if (clubDoc.exists) {
          clubName = clubDoc.data().name;
          batch.update(clubRef, {
            totalPoints: admin.firestore.FieldValue.increment(clubPointReward),
            weeklyPoints: admin.firestore.FieldValue.increment(clubPointReward)
          });
          
          const memberRef = clubRef.collection('members').doc(userId);
          const memberDoc = await memberRef.get();
          if (memberDoc.exists) {
            batch.update(memberRef, {
              points: admin.firestore.FieldValue.increment(clubPointReward),
              weeklyPoints: admin.firestore.FieldValue.increment(clubPointReward)
            });
          }
        }
      }
      
      await batch.commit();
      
      // Award XP
      try {
        await processUserXP(userId, 'match_win');
      } catch (err) {
        console.error('XP Error:', err);
      }
      
      // SECURE LEADERBOARD UPDATE
      try {
        if (global.leaderboardServer) {
          const finalUserDoc = await userRef.get();
          if (finalUserDoc.exists) {
            const finalData = finalUserDoc.data();
            global.leaderboardServer.updatePlayerInternal({
              userId,
              username: finalData.username || 'Player',
              avatar: finalData.avatar || 'default',
              score: finalData.weeklyProfitCoins || 0,
              wins: finalData.gamesWon || 0,
              gamesPlayed: finalData.gamesPlayed || 0,
              clubId: finalData.clubId || null
            });
          }
          if (clubId) {
            const finalClubDoc = await db.collection('clubs').doc(clubId).get();
            if (finalClubDoc.exists) {
              const finalClubData = finalClubDoc.data();
              global.leaderboardServer.updateClubInternal({
                clubId: clubId,
                clubName: finalClubData.name || 'Club',
                badge: finalClubData.badge || 'default',
                points: finalClubData.totalPoints || 0,
                weeklyPoints: finalClubData.weeklyPoints || 0,
                memberCount: finalClubData.memberCount || finalClubData.members?.length || 0,
                gamesPlayed: finalClubData.totalGames || 0
              });
            }
          }
        }
      } catch (err) {
        console.error('Leaderboard Update Error:', err);
      }
      
      return {
        success: true,
        coins: coinReward,
        clubPoints: clubPointReward,
        clubName
      };
      
    } catch (error) {
      console.error('Error awarding win:', error);
      return { success: false, error: error.message };
    }
  }

  static async awardGameLoss(userId, gameType, betAmount = 100) {
    try {
      if (!userId) return { success: false, error: 'No user ID' };
      const db = admin.firestore();
      const userRef = db.collection('users').doc(userId);
      
      await userRef.update({
        gamesPlayed: admin.firestore.FieldValue.increment(1),
        gamesLost: admin.firestore.FieldValue.increment(1)
      });
      
      try {
        await processUserXP(userId, 'match_join');
      } catch (err) {
        console.error('XP Error:', err);
      }
      
      // SECURE LEADERBOARD UPDATE
      try {
        if (global.leaderboardServer) {
          const finalUserDoc = await userRef.get();
          if (finalUserDoc.exists) {
            const finalData = finalUserDoc.data();
            global.leaderboardServer.updatePlayerInternal({
              userId,
              username: finalData.username || 'Player',
              avatar: finalData.avatar || 'default',
              score: finalData.weeklyProfitCoins || 0,
              wins: finalData.gamesWon || 0,
              gamesPlayed: finalData.gamesPlayed || 0,
              clubId: finalData.clubId || null
            });
            if (finalData.clubId) {
              const finalClubDoc = await db.collection('clubs').doc(finalData.clubId).get();
              if (finalClubDoc.exists) {
                const finalClubData = finalClubDoc.data();
                global.leaderboardServer.updateClubInternal({
                  clubId: finalData.clubId,
                  clubName: finalClubData.name || 'Club',
                  badge: finalClubData.badge || 'default',
                  points: finalClubData.totalPoints || 0,
                  weeklyPoints: finalClubData.weeklyPoints || 0,
                  memberCount: finalClubData.memberCount || finalClubData.members?.length || 0,
                  gamesPlayed: finalClubData.totalGames || 0
                });
              }
            }
          }
        }
      } catch (err) {
        console.error('Leaderboard Update Error:', err);
      }
      
      return { success: true };
    } catch (error) {
      console.error('Error awarding loss:', error);
      return { success: false, error: error.message };
    }
  }

  static async awardGameDraw(userId, gameType, betAmount = 100) {
    try {
      if (!userId) return { success: false, error: 'No user ID' };
      const db = admin.firestore();
      const userRef = db.collection('users').doc(userId);
      
      // Refund the bet amount
      await userRef.update({
        coins: admin.firestore.FieldValue.increment(betAmount),
        gamesPlayed: admin.firestore.FieldValue.increment(1),
        gamesDrawn: admin.firestore.FieldValue.increment(1)
      });
      
      try {
        await processUserXP(userId, 'match_join');
      } catch (err) {
        console.error('XP Error:', err);
      }

      // SECURE LEADERBOARD UPDATE
      try {
        if (global.leaderboardServer) {
          const finalUserDoc = await userRef.get();
          if (finalUserDoc.exists) {
            const finalData = finalUserDoc.data();
            global.leaderboardServer.updatePlayerInternal({
              userId,
              username: finalData.username || 'Player',
              avatar: finalData.avatar || 'default',
              score: finalData.weeklyProfitCoins || 0,
              wins: finalData.gamesWon || 0,
              gamesPlayed: finalData.gamesPlayed || 0,
              clubId: finalData.clubId || null
            });
            if (finalData.clubId) {
              const finalClubDoc = await db.collection('clubs').doc(finalData.clubId).get();
              if (finalClubDoc.exists) {
                const finalClubData = finalClubDoc.data();
                global.leaderboardServer.updateClubInternal({
                  clubId: finalData.clubId,
                  clubName: finalClubData.name || 'Club',
                  badge: finalClubData.badge || 'default',
                  points: finalClubData.totalPoints || 0,
                  weeklyPoints: finalClubData.weeklyPoints || 0,
                  memberCount: finalClubData.memberCount || finalClubData.members?.length || 0,
                  gamesPlayed: finalClubData.totalGames || 0
                });
              }
            }
          }
        }
      } catch (err) {
        console.error('Leaderboard Update Error:', err);
      }
      
      return { success: true };
    } catch (error) {
      console.error('Error awarding draw:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = RewardServiceServer;
