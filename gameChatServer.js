/**
 * Game Chat Server with Socket.IO
 * Real-time chat and emoji reactions for in-game communication (Ludo, TicTacToe, Chess, etc.)
 * Completely secure with backend validation & Hybrid Batch Writes (Zero Quota impact)
 */

// Allowed emojis list - Only these can be sent
const ALLOWED_EMOJIS = [
  '😊', '😂', '❤️', '👍', '🎉', 
  '😎', '🔥', '💯', '😢', '😡', 
  '🤔', '👏', '🙏', '💪', '⭐', 
  '✨'
];

class GameChatServer {
  constructor(io, admin, rooms, userSockets) {
    this.io = io;
    this.admin = admin; // Firebase Admin SDK for hybrid writes
    this.rooms = rooms; // In-memory rooms from index.js
    this.userSockets = userSockets; // Global socket map for anti-spoofing

    // --- HYBRID MEMORY BUFFER SYSTEM ---
    this.messageBuffer = []; // Stores pending chat messages and emojis
    this.FLUSH_LIMIT = 100; // Save when 100 items accumulate
    
    // Save every 5 minutes (even if limit is not reached)
    this.flushInterval = setInterval(() => this.flushMessages(), 5 * 60 * 1000);
  }

  /**
   * Initialize Socket.IO event handlers for game chat
   */
  initialize() {
    this.io.on('connection', (socket) => {
      // Fetch History
      socket.on('game_chat:fetch_history', (data) => this.handleFetchHistory(socket, data));
      
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
   * Fetch chat history for a game room (Optimized Chunk Read)
   */
  async handleFetchHistory(socket, { roomId, userId }) {
    try {
      if (!roomId || !userId) return;

      // SECURITY: Anti-spoofing check
      if (this.userSockets[userId] !== socket.id) {
        return socket.emit('game_chat:error', { error: 'Unauthorized access.' });
      }

      // SECURITY: Check if user is actually in the room
      const room = this.rooms[roomId];
      if (!room || !room.players[userId]) {
        return socket.emit('game_chat:error', { error: 'You are not in this game room.' });
      }

      if (this.admin) {
        const db = this.admin.firestore();
        
        // --- OPTIMIZED READS (Chunking) ---
        const chatRef = db.collection('gameChats').doc(roomId);
        const chunksSnapshot = await chatRef.collection('message_chunks')
          .orderBy('timestamp', 'desc')
          .limit(1) // Load only the latest chunk (up to 100 messages) = 1 Read operation
          .get();

        let messages = [];
        chunksSnapshot.forEach(doc => {
          const chunkMsgs = doc.data().messages || [];
          messages.push(...chunkMsgs);
        });

        // Add any fresh messages currently in the Node.js Memory Buffer
        const bufferedMsgs = this.messageBuffer
          .filter(m => m.roomId === roomId)
          .map(m => m.data);
        
        messages.push(...bufferedMsgs);

        // Sort chronologically
        messages.sort((a, b) => a.timestamp - b.timestamp);

        socket.emit('game_chat:history', { roomId, messages });
      }
    } catch (error) {
      console.error('❌ [GAME CHAT] Error fetching history:', error);
    }
  }

  /**
   * Handle incoming chat message
   */
  handleSendMessage(socket, { roomId, userId, username, message }) {
    try {
      if (!roomId || !userId || !message) return;

      // SECURITY: Anti-spoofing check
      if (this.userSockets[userId] !== socket.id) {
        return socket.emit('game_chat:error', { error: 'Unauthorized message attempt.' });
      }

      // SECURITY: Check if user is actually in the room
      const room = this.rooms[roomId];
      if (!room || !room.players[userId]) {
        return socket.emit('game_chat:error', { error: 'You are not in this game room.' });
      }

      // Clean message (remove emojis) and trim
      const cleanedMessage = this._removeEmojisFromText(message).trim();
      
      if (!cleanedMessage) {
        return; // Empty message after cleaning
      }

      const messageData = {
        id: `gmsg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        type: 'text',
        userId,
        username: username || room.players[userId].username || 'Player',
        message: cleanedMessage,
        timestamp: Date.now()
      };

      // 1. Broadcast to all players in the room
      this.io.to(roomId).emit('game_chat:new_message', {
        roomId,
        message: messageData
      });
      
      // 2. ADD TO MEMORY BUFFER
      this.messageBuffer.push({ roomId, data: messageData });
      
      // 3. HYBRID CHECK (Flush if limit reached)
      if (this.messageBuffer.length >= this.FLUSH_LIMIT) {
        this.flushMessages();
      }

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

      // SECURITY: Anti-spoofing check
      if (this.userSockets[userId] !== socket.id) {
        return socket.emit('game_chat:error', { error: 'Unauthorized emoji attempt.' });
      }

      // SECURITY: Check if user is actually in the room
      const room = this.rooms[roomId];
      if (!room || !room.players[userId]) {
        return socket.emit('game_chat:error', { error: 'You are not in this game room.' });
      }

      // Validate emoji securely on backend
      if (!this._validateEmoji(emoji)) {
        console.error(`❌ [GAME CHAT] Invalid emoji attempt by ${userId}: ${emoji}`);
        return;
      }

      const emojiData = {
        id: `gemj_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        type: 'emoji',
        userId,
        username: room.players[userId].username || 'Player',
        emoji,
        timestamp: Date.now()
      };

      // 1. Broadcast to all players in the room
      this.io.to(roomId).emit('game_chat:new_emoji', {
        roomId,
        emojiData
      });

      // 2. ADD TO MEMORY BUFFER
      this.messageBuffer.push({ roomId, data: emojiData });
      
      // 3. HYBRID CHECK (Flush if limit reached)
      if (this.messageBuffer.length >= this.FLUSH_LIMIT) {
        this.flushMessages();
      }
      
    } catch (error) {
      console.error('❌ [GAME CHAT] Error sending emoji:', error);
    }
  }

  // --- HYBRID BATCH WRITE SYSTEM (Saves Quota drastically) ---
  async flushMessages() {
    if (this.messageBuffer.length === 0 || !this.admin) return;
    
    // Copy and clear buffer safely
    const messagesToFlush = [...this.messageBuffer];
    this.messageBuffer = []; 
    
    // Group messages by Room ID
    const groupedMessages = {};
    for (const item of messagesToFlush) {
      if (!groupedMessages[item.roomId]) groupedMessages[item.roomId] = [];
      groupedMessages[item.roomId].push(item.data);
    }

    try {
      const db = this.admin.firestore();
      const batch = db.batch();

      for (const [roomId, msgs] of Object.entries(groupedMessages)) {
        const chatRef = db.collection('gameChats').doc(roomId);
        
        // Save messages as an Array in a single Chunk Document (1 Write per chunk)
        const chunkRef = chatRef.collection('message_chunks').doc(); 
        batch.set(chunkRef, {
          messages: msgs,
          timestamp: msgs[msgs.length - 1].timestamp
        });

        // Update Chat Metadata (1 Write per room)
        const lastMsg = msgs[msgs.length - 1];
        batch.set(chatRef, {
          lastMessageTime: lastMsg.timestamp,
          lastSenderId: lastMsg.userId,
          messageCount: this.admin.firestore.FieldValue.increment(msgs.length)
        }, { merge: true });
      }

      await batch.commit();
      console.log(`📦 [GAME CHAT] HYBRID FLUSH: Saved ${messagesToFlush.length} items to Firebase in a single batch.`);
    } catch (err) {
      console.error('❌ [GAME CHAT] Failed to flush messages', err);
      // Put them back in buffer so we don't lose them if Firebase fails
      this.messageBuffer.unshift(...messagesToFlush);
    }
  }
}

module.exports = GameChatServer;
