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
  static async awardGameWin(userId, gameType, betAmount = 100) {
    try {
      if (!userId) return { success: false, error: 'No user ID' };
      
      const db = admin.firestore();
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();
      
      if (!userDoc.exists) return { success: false, error: 'User not found' };
      
      const userData = userDoc.data();
      const clubId = userData.clubId;
      
      const coinReward = Math.floor(betAmount * COIN_MULTIPLIER);
      const clubPointReward = CLUB_POINTS_BY_BET[betAmount] || Math.max(1, Math.floor(betAmount / 100));
      
      // Award coins
      const batch = db.batch();
      
      batch.update(userRef, {
        coins: admin.firestore.FieldValue.increment(coinReward),
        totalCoinsEarned: admin.firestore.FieldValue.increment(coinReward),
        weeklyCoins: admin.firestore.FieldValue.increment(coinReward),
        weeklyProfitCoins: admin.firestore.FieldValue.increment(coinReward),
        gamesWon: admin.firestore.FieldValue.increment(1),
        gamesPlayed: admin.firestore.FieldValue.increment(1)
      });
      
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
      
      return { success: true };
    } catch (error) {
      console.error('Error awarding draw:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = RewardServiceServer;
