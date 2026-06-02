/**
 * Game Chat Server with Socket.IO
 * Real-time chat and emoji reactions for in-game communication
 * Completely secure with backend validation
 */

// Allowed emojis list - Only these can be sent
const ALLOWED_EMOJIS = [
  '😊', '😂', '❤️', '👍', '🎉', 
  '😎', '🔥', '💯', '😢', '😡', 
  '🤔', '👏', '🙏', '💪', '⭐', 
  '✨'
];

class GameChatServer {
  constructor(io, roomsMap, userSockets) {
    this.io = io;
    this.rooms = roomsMap || {};
    this.userSockets = userSockets || {};
    
    // Rate limiting trackers
    this.messageRateLimit = new Map(); // userId -> { count, lastTime }
    this.emojiRateLimit = new Map(); // userId -> { count, lastTime }
  }

  /**
   * Initialize Socket.IO event handlers for game chat
   */
  initialize() {
    this.io.on('connection', (socket) => {
      // Send message
      socket.on('game_chat:send_message', (data) => this.handleSendMessage(socket, data));

      // Send emoji
      socket.on('game_chat:send_emoji', (data) => this.handleSendEmoji(socket, data));
    });
  }

  /**
   * Validate emoji - Only allowed emojis can be sent
   */
  _validateEmoji(emoji) {
    if (!emoji || typeof emoji !== 'string') {
      return false;
    }
    return ALLOWED_EMOJIS.includes(emoji);
  }

  /**
   * Remove emojis from text message
   */
  _removeEmojisFromText(text) {
    if (!text) return '';
    // Regex to match all emojis and emoji-like characters
    const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F018}-\u{1F270}]|[\u{238C}-\u{2454}]|[\u{20D0}-\u{20FF}]|[\u{FE00}-\u{FE0F}]|[\u{1F004}]|[\u{1F0CF}]|[\u{1F170}-\u{1F251}]/gu;
    return text.replace(emojiRegex, '');
  }

  /**
   * Handle incoming chat message
   */
  handleSendMessage(socket, { roomId, userId, username, message }) {
    try {
      if (!roomId || !userId || !message) return;

      // RATE LIMITING
      const now = Date.now();
      const userRate = this.messageRateLimit.get(userId) || { count: 0, lastTime: now };
      if (now - userRate.lastTime > 5000) {
        userRate.count = 0; // Reset every 5 seconds
        userRate.lastTime = now;
      }
      userRate.count++;
      this.messageRateLimit.set(userId, userRate);
      
      if (userRate.count > 5) {
        console.warn(`[GAME CHAT] Rate limit exceeded for user ${userId} in messages`);
        return; // Drop message if more than 5 per 5 seconds
      }

      // SECURITY: Validate that the socket sending the message actually belongs to userId
      const expectedSocketId = this.userSockets[userId];
      if (!expectedSocketId || socket.id !== expectedSocketId) {
        console.warn(`[GAME CHAT] Security Alert: Socket ${socket.id} attempted to send message as ${userId}`);
        return;
      }

      // SECURITY: Validate that the user is actually in the room
      const room = this.rooms[roomId];
      if (!room) {
        console.warn(`[GAME CHAT] Security Alert: Room ${roomId} not found for chat`);
        return;
      }
      
      if (!room.players || !room.players[userId]) {
        console.warn(`[GAME CHAT] Security Alert: User ${userId} attempted to chat in room ${roomId} without being a member`);
        return;
      }

      // Enforce message length limit (e.g., max 200 chars)
      if (message.length > 200) {
        message = message.substring(0, 200);
      }

      // Clean message (remove emojis) and trim
      const cleanedMessage = this._removeEmojisFromText(message).trim();
      
      // Prevent XSS / HTML tags by escaping basic characters
      const sanitizedMessage = cleanedMessage
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
      
      if (!sanitizedMessage) {
        return; // Empty message after cleaning
      }

      const messageData = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        userId,
        username: username || 'Player',
        message: sanitizedMessage,
        timestamp: Date.now()
      };

      // Broadcast to all players in the room
      this.io.to(roomId).emit('game_chat:new_message', {
        roomId,
        message: messageData
      });
      
      console.log(`💬 [GAME CHAT] Message sent in room ${roomId} by ${userId}`);
    } catch (error) {
      console.error('❌ [GAME CHAT] Error sending message:', error);
    }
  }

  /**
   * Handle incoming emoji reaction
   */
  handleSendEmoji(socket, { roomId, userId, emoji }) {
    try {
      if (!roomId || !userId || !emoji) return;

      // RATE LIMITING
      const now = Date.now();
      const emojiRate = this.emojiRateLimit.get(userId) || { count: 0, lastTime: now };
      if (now - emojiRate.lastTime > 5000) {
        emojiRate.count = 0; // Reset every 5 seconds
        emojiRate.lastTime = now;
      }
      emojiRate.count++;
      this.emojiRateLimit.set(userId, emojiRate);
      
      if (emojiRate.count > 10) {
        console.warn(`[GAME CHAT] Rate limit exceeded for user ${userId} in emojis`);
        return; // Drop emoji if more than 10 per 5 seconds
      }

      // SECURITY: Validate that the socket sending the emoji actually belongs to userId
      const expectedSocketId = this.userSockets[userId];
      if (!expectedSocketId || socket.id !== expectedSocketId) {
        console.warn(`[GAME CHAT] Security Alert: Socket ${socket.id} attempted to send emoji as ${userId}`);
        return;
      }

      // SECURITY: Validate that the user is actually in the room
      const room = this.rooms[roomId];
      if (!room) {
        console.warn(`[GAME CHAT] Security Alert: Room ${roomId} not found for emoji`);
        return;
      }
      
      if (!room.players || !room.players[userId]) {
        console.warn(`[GAME CHAT] Security Alert: User ${userId} attempted to send emoji in room ${roomId} without being a member`);
        return;
      }

      // Validate emoji securely on backend
      if (!this._validateEmoji(emoji)) {
        console.error(`❌ [GAME CHAT] Invalid emoji attempt by ${userId}: ${emoji}`);
        return;
      }

      const emojiData = {
        userId,
        emoji,
        timestamp: Date.now()
      };

      // Broadcast to all players in the room
      this.io.to(roomId).emit('game_chat:new_emoji', {
        roomId,
        emojiData
      });
      
      console.log(`😊 [GAME CHAT] Emoji sent in room ${roomId} by ${userId}: ${emoji}`);
    } catch (error) {
      console.error('❌ [GAME CHAT] Error sending emoji:', error);
    }
  }
}

module.exports = GameChatServer;
