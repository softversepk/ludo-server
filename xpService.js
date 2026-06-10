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

    // Determine XP to add based on action, ensuring numbers
    let xpToAdd = 0;
    switch(action) {
      case 'match_join': xpToAdd = Number(settings.matchJoinXp) || 5; break;
      case 'match_win': xpToAdd = Number(settings.matchWinXp) || 30; break;
      case 'match_second': xpToAdd = Number(settings.secondPositionXp) || 15; break;
      case 'daily_login': xpToAdd = Number(settings.dailyLoginXp) || 5; break;
      case 'win_streak': xpToAdd = Number(settings.winStreakXp) || 20; break;
      case 'friend_invite': xpToAdd = Number(settings.friendInviteXp) || 5; break;
      default: return { success: false, message: 'Invalid action.' };
    }

    const baseXpFormula = Number(settings.baseXpFormula) || 100;
    const levelMultiplier = Number(settings.levelMultiplier) || 1.5;

    // 2 & 3 & 4. Process XP in a Transaction to prevent Race Conditions
    const userRef = db.collection('users').doc(userId);
    
    const result = await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error('User not found.');
      }
      
      const userData = userDoc.data();
      let currentLevel = Number(userData.level) || 1;
      let currentXp = Number(userData.xp) || 0;
      let totalXp = Number(userData.totalXp) || 0;
      
      // Add XP and calculate level ups
      currentXp += xpToAdd;
      totalXp += xpToAdd;
      
      let leveledUp = false;
      let requiredXpForNextLevel = Math.floor(baseXpFormula * Math.pow(currentLevel, levelMultiplier));
      
      // XP Reset / Consume Logic
      while (currentXp >= requiredXpForNextLevel) {
        currentXp -= requiredXpForNextLevel; // Consume the required XP
        currentLevel += 1;
        leveledUp = true;
        requiredXpForNextLevel = Math.floor(baseXpFormula * Math.pow(currentLevel, levelMultiplier));
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
