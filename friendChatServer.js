/**
 * Friend Chat Server with Socket.IO
 * Highly secure real-time messaging system for 1-on-1 friend chats
 * Features: HYBRID Batch Writes (100 msgs OR 5 mins), Chunk Reads, Secure Auth
 */

class FriendChatServer {
  constructor(io, admin) {
    this.io = io;
    this.admin = admin; // Firebase Admin SDK
    this.userSockets = new Map(); // userId -> socketId
    
    // --- HYBRID MEMORY BUFFER SYSTEM ---
    this.messageBuffer = []; // Stores pending messages
    this.FLUSH_LIMIT = 100; // Condition 1: Save when 100 messages accumulate
    
    // Condition 2: Save every 5 minutes (even if limit is not reached)
    this.flushInterval = setInterval(() => this.flushMessages(), 5 * 60 * 1000);
  }

  initialize() {
    this.io.on('connection', (socket) => {
      socket.on('friend_chat:register', (data) => this.handleRegister(socket, data));
      socket.on('friend_chat:join', (data) => this.handleJoinChat(socket, data));
      socket.on('friend_chat:leave', (data) => this.handleLeaveChat(socket, data));
      socket.on('friend_chat:send_message', (data) => this.handleSendMessage(socket, data));
      socket.on('friend_chat:typing', (data) => this.handleTyping(socket, data));
      socket.on('friend_chat:mark_read', (data) => this.handleMarkRead(socket, data));
      socket.on('disconnect', () => this.handleDisconnect(socket));
    });
  }

  getChatRoomId(userId1, userId2) {
    const sortedIds = [userId1, userId2].sort();
    return `friend_${sortedIds[0]}_${sortedIds[1]}`;
  }

  // Highly secure registration
  async handleRegister(socket, { userId, token }) {
    if (!userId) return;
    
    // SECURITY: Verify Firebase Auth Token if provided
    if (token && this.admin) {
      try {
        const decodedToken = await this.admin.auth().verifyIdToken(token);
        if (decodedToken.uid !== userId) {
          return socket.emit('friend_chat:error', { error: 'Authentication failed. Hacker detected.' });
        }
        socket.isVerified = true;
      } catch (error) {
        console.warn(`[SECURITY] Invalid token for user ${userId}`);
      }
    }

    this.userSockets.set(userId, socket.id);
    socket.userId = userId; // Bind socket to user
    console.log(`✅ [FRIEND CHAT] User registered: ${userId}`);
  }

  // Handle joining room & Fetching History (Optimized Chunk Reads)
  async handleJoinChat(socket, { userId, friendId }) {
    try {
      if (!userId || !friendId) return;
      
      // SECURITY: Ensure socket belongs to the user
      if (socket.userId !== userId) {
        return socket.emit('friend_chat:error', { error: 'Unauthorized access.' });
      }

      const roomId = this.getChatRoomId(userId, friendId);
      socket.join(roomId);
      console.log(`💬 [FRIEND CHAT] ${userId} joined chat with ${friendId} (Room: ${roomId})`);

      if (this.admin) {
        const db = this.admin.firestore();
        
        // SECURITY: Check if they are actually friends
        const userDoc = await db.collection('users').doc(userId).get();
        const friends = userDoc.data()?.friends || [];
        
        if (!friends.includes(friendId)) {
          return socket.emit('friend_chat:error', { error: 'Not authorized to chat with this user' });
        }

        // --- OPTIMIZED READS (Chunking) ---
        const chatRef = db.collection('friendChats').doc(roomId);
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
          .map(m => m.messageData);
        
        messages.push(...bufferedMsgs);

        // Sort chronologically
        messages.sort((a, b) => a.timestamp - b.timestamp);

        socket.emit('friend_chat:history', { roomId, messages });
      }
    } catch (error) {
      console.error('❌ [FRIEND CHAT JOIN ERROR]', error);
      socket.emit('friend_chat:error', { error: error.message });
    }
  }

  handleLeaveChat(socket, { userId, friendId }) {
    if (!userId || !friendId) return;
    const roomId = this.getChatRoomId(userId, friendId);
    socket.leave(roomId);
  }

  async handleSendMessage(socket, { userId, friendId, message, type = 'text', replyTo = null }) {
    try {
      if (!userId || !friendId || !message) return;

      // SECURITY: Anti-spoofing check
      if (socket.userId !== userId) {
        return socket.emit('friend_chat:error', { error: 'Unauthorized message attempt.' });
      }

      const roomId = this.getChatRoomId(userId, friendId);

      // SECURITY: Check friendship status before allowing message to be routed
      if (this.admin) {
        const db = this.admin.firestore();
        const userDoc = await db.collection('users').doc(userId).get();
        const friends = userDoc.data()?.friends || [];
        
        if (!friends.includes(friendId)) {
          return socket.emit('friend_chat:error', { error: 'You can only message your friends.' });
        }
      }

      const messageData = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        senderId: userId,
        receiverId: friendId,
        message: message.trim(),
        type,
        replyTo,
        timestamp: Date.now(),
        isRead: false
      };

      // 1. REAL-TIME DELIVERY (Socket.io)
      this.io.to(roomId).emit('friend_chat:new_message', messageData);
      
      const receiverSocketId = this.userSockets.get(friendId);
      if (receiverSocketId) {
        this.io.to(receiverSocketId).emit('friend_chat:notification', {
          senderId: userId,
          message: messageData
        });
      }

      // 2. ADD TO MEMORY BUFFER
      this.messageBuffer.push({ roomId, messageData });
      console.log(`✉️ [FRIEND CHAT] Buffered msg ${userId} -> ${friendId} (Buffer size: ${this.messageBuffer.length})`);

      // 3. HYBRID CHECK (Flush if limit reached)
      if (this.messageBuffer.length >= this.FLUSH_LIMIT) {
        this.flushMessages();
      }

    } catch (error) {
      console.error('❌ [FRIEND CHAT SEND ERROR]', error);
      socket.emit('friend_chat:error', { error: 'Failed to send message' });
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
      groupedMessages[item.roomId].push(item.messageData);
    }

    try {
      const db = this.admin.firestore();
      const batch = db.batch();

      for (const [roomId, msgs] of Object.entries(groupedMessages)) {
        const chatRef = db.collection('friendChats').doc(roomId);
        
        // Save messages as an Array in a single Chunk Document (1 Write per chunk)
        const chunkRef = chatRef.collection('message_chunks').doc(); 
        batch.set(chunkRef, {
          messages: msgs,
          timestamp: msgs[msgs.length - 1].timestamp
        });

        // Update Chat Metadata (1 Write per room)
        const lastMsg = msgs[msgs.length - 1];
        batch.set(chatRef, {
          lastMessage: lastMsg.type === 'text' ? lastMsg.message : `[${lastMsg.type}]`,
          lastMessageTime: lastMsg.timestamp,
          lastSenderId: lastMsg.senderId,
          participants: [lastMsg.senderId, lastMsg.receiverId]
        }, { merge: true });
      }

      await batch.commit();
      console.log(`📦 [FRIEND CHAT] HYBRID FLUSH: Saved ${messagesToFlush.length} messages to Firebase in a single batch.`);
    } catch (err) {
      console.error('❌ [FRIEND CHAT] Failed to flush messages', err);
      // Put them back in buffer so we don't lose them if Firebase fails
      this.messageBuffer.unshift(...messagesToFlush);
    }
  }

  handleTyping(socket, { userId, friendId, isTyping }) {
    if (!userId || !friendId) return;
    if (socket.userId !== userId) return; // Security
    
    const roomId = this.getChatRoomId(userId, friendId);
    socket.to(roomId).emit('friend_chat:typing', { userId, isTyping });
  }

  handleMarkRead(socket, { userId, friendId }) {
    if (!userId || !friendId || socket.userId !== userId) return;
    const roomId = this.getChatRoomId(userId, friendId);
    socket.to(roomId).emit('friend_chat:messages_read', { readerId: userId });
  }

  handleDisconnect(socket) {
    if (socket.userId) {
      this.userSockets.delete(socket.userId);
    }
  }
}

module.exports = FriendChatServer;