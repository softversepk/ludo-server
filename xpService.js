const admin = require('firebase-admin');

// Ensure firebase-admin is initialized in your main server file
// if (!admin.apps.length) {
//   admin.initializeApp({ ... });
// }

/**
 * Validates and processes XP for a user based on the action performed.
 * This is the secure backend implementation.
 */
async function processUserXP(userId, action) {
  try {
    const db = admin.firestore();
    
    // 1. Fetch XP Settings
    const settingsDoc = await db.collection('admin_settings').doc('xp_settings').get();
    let settings = {
      matchJoinXp: 5,
      matchWinXp: 30,
      secondPositionXp: 15,
      dailyLoginXp: 5,
      winStreakXp: 20,
      friendInviteXp: 5,
      baseXpFormula: 100,
      levelMultiplier: 1.5,
      xpRewardsEnabled: true
    };
    
    if (settingsDoc.exists) {
      settings = { ...settings, ...settingsDoc.data() };
    }
    
    if (!settings.xpRewardsEnabled) {
      return { success: false, message: 'XP Rewards are disabled by admin.' };
    }

    // Determine XP to add based on action
    let xpToAdd = 0;
    switch(action) {
      case 'match_join': xpToAdd = settings.matchJoinXp; break;
      case 'match_win': xpToAdd = settings.matchWinXp; break;
      case 'match_second': xpToAdd = settings.secondPositionXp; break;
      case 'daily_login': xpToAdd = settings.dailyLoginXp; break;
      case 'win_streak': xpToAdd = settings.winStreakXp; break;
      case 'friend_invite': xpToAdd = settings.friendInviteXp; break;
      default: return { success: false, message: 'Invalid action.' };
    }

    // 2 & 3 & 4. Process XP in a Transaction to prevent Race Conditions
    const userRef = db.collection('users').doc(userId);
    
    const result = await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error('User not found.');
      }
      
      const userData = userDoc.data();
      let currentLevel = userData.level || 1;
      let currentXp = userData.xp || 0;
      let totalXp = userData.totalXp || 0;
      
      // Add XP and calculate level ups
      currentXp += xpToAdd;
      totalXp += xpToAdd;
      
      let leveledUp = false;
      let requiredXpForNextLevel = Math.floor(settings.baseXpFormula * Math.pow(currentLevel, settings.levelMultiplier));
      
      // XP Reset / Consume Logic
      while (currentXp >= requiredXpForNextLevel) {
        currentXp -= requiredXpForNextLevel; // Consume the required XP
        currentLevel += 1;
        leveledUp = true;
        requiredXpForNextLevel = Math.floor(settings.baseXpFormula * Math.pow(currentLevel, settings.levelMultiplier));
      }
      
      // Update Database
      transaction.update(userRef, {
        level: currentLevel,
        xp: currentXp,
        totalXp: totalXp,
        lastXpUpdate: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        success: true,
        xpAdded,
        newLevel: currentLevel,
        newXp: currentXp,
        leveledUp,
        requiredXpForNextLevel
      };
    });
    
    // 5. Log Activity outside the transaction
    await db.collection('xp_logs').add({
      userId,
      action,
      xpAdded: xpToAdd,
      newLevel: result.newLevel,
      newXp: result.newXp,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return result;

  } catch (error) {
    console.error('Error processing XP:', error);
    return { success: false, error: error.message };
  }
}

module.exports = { processUserXP };
