/**
 * Club Chat Server with Socket.IO
 * Real-time messaging system for club members
 */

class ClubChatServer {
  constructor(io, admin) {
    this.io = io;
    this.admin = admin;
    this.clubRooms = new Map(); // clubId -> { members: Set, messages: [] }
    this.userSockets = new Map(); // userId -> { socketId, clubId, username }
    // Server-side rate limiting: userId -> { count, windowStart }
    this._rateLimitMap = new Map();
    this._rateLimitMax = 2;       // max messages per window
    this._rateLimitWindowMs = 1000; // per 1 second
    this._maxMessageLength = 500;   // max chars per message
  }

  /**
   * Initialize Socket.IO event handlers for club chat
   */
  initialize() {
    this.io.on('connection', (socket) => {
      console.log(`✅ [CLUB CHAT] User connected: ${socket.id}`);

      // Join club chat room
      socket.on('club:join', (data) => this.handleJoinClub(socket, data));

      // Leave club chat room
      socket.on('club:leave', (data) => this.handleLeaveClub(socket, data));

      // Send message
      socket.on('club:send_message', (data) => this.handleSendMessage(socket, data));

      // Typing indicator
      socket.on('club:typing', (data) => this.handleTyping(socket, data));

      // Request message history
      socket.on('club:request_history', (data) => this.handleRequestHistory(socket, data));

      // Delete message (admin/owner only)
      socket.on('club:delete_message', (data) => this.handleDeleteMessage(socket, data));

      // Member online status
      socket.on('club:heartbeat', (data) => this.handleHeartbeat(socket, data));

      // Voice chat slots
      socket.on('club:join_voice_slot', (data) => this.handleJoinVoiceSlot(socket, data));
      socket.on('club:leave_voice_slot', (data) => this.handleLeaveVoiceSlot(socket, data));

      // Disconnection
      socket.on('disconnect', () => this.handleDisconnect(socket));
    });

    // Start cleanup interval
    this.startCleanupInterval();
  }

  /**
   * Handle user joining club chat
   */
  async handleJoinClub(socket, { clubId, userId, username, avatar, role, token }) {
    try {
      console.log(`🎮 [CLUB JOIN] ${username} joining club ${clubId}`);

      // Security verification
      if (!token) {
        throw new Error('Authentication token required');
      }

      if (this.admin) {
        try {
          const decodedToken = await this.admin.auth().verifyIdToken(token);
          if (decodedToken.uid !== userId) {
            console.warn(`🔒 [CLUB SEC] UID mismatch: token=${decodedToken.uid}, req=${userId}`);
            throw new Error('Unauthorized user ID mismatch');
          }
          // Mark socket as authenticated
          socket.userId = userId;
        } catch (authError) {
          console.error('🔒 [CLUB SEC] Token verification failed:', authError.message);
          throw new Error('Invalid or expired authentication token');
        }
      } else {
        // Fallback for local testing if admin not initialized
        socket.userId = userId;
      }

      // Get or create club room
      if (!this.clubRooms.has(clubId)) {
        this.clubRooms.set(clubId, {
          members: new Map(),
          messages: [],
          voiceSlots: Array(10).fill(null),
          createdAt: Date.now()
        });
      }

      const clubRoom = this.clubRooms.get(clubId);

      // Add member to club room
      clubRoom.members.set(userId, {
        userId,
        username,
        avatar,
        role,
        socketId: socket.id,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
        isOnline: true
      });

      // Track user socket
      this.userSockets.set(socket.id, { userId, clubId, username });

      // Join socket room
      socket.join(`club:${clubId}`);

      // Send success response with recent messages
      socket.emit('club:join_success', {
        clubId,
        members: Array.from(clubRoom.members.values()).map(m => ({
          userId: m.userId,
          username: m.username,
          avatar: m.avatar,
          role: m.role,
          isOnline: m.isOnline
        })),
        recentMessages: clubRoom.messages.slice(-50), // Last 50 messages
        voiceSlots: clubRoom.voiceSlots
      });

      // Notify other members
      socket.to(`club:${clubId}`).emit('club:member_joined', {
        userId,
        username,
        avatar,
        timestamp: Date.now()
      });

      // Broadcast updated online count
      this.broadcastOnlineCount(clubId);

      console.log(`✅ [CLUB JOIN] ${username} joined club ${clubId}. Online: ${clubRoom.members.size}`);
    } catch (error) {
      console.error('❌ [CLUB JOIN ERROR]', error);
      socket.emit('club:join_error', { error: error.message });
    }
  }

  /**
   * Handle user leaving club chat
   */
  handleLeaveClub(socket, { clubId, userId }) {
    try {
      if (socket.userId && socket.userId !== userId) {
        console.warn(`🔒 [CLUB SEC] Leave attempt by wrong user. socket=${socket.userId}, req=${userId}`);
        return;
      }

      console.log(`👋 [CLUB LEAVE] User ${userId} leaving club ${clubId}`);

      const clubRoom = this.clubRooms.get(clubId);
      if (!clubRoom) return;

      // Remove member
      const member = clubRoom.members.get(userId);
      if (member) {
        clubRoom.members.delete(userId);

        // Notify others
        socket.to(`club:${clubId}`).emit('club:member_left', {
          userId,
          username: member.username,
          timestamp: Date.now()
        });
      }

      // Remove from voice slots if present
      const slotIndex = clubRoom.voiceSlots.findIndex(slot => slot && slot.userId === userId);
      if (slotIndex !== -1) {
        clubRoom.voiceSlots[slotIndex] = null;
        this.io.to(`club:${clubId}`).emit('club:voice_slots_update', {
          voiceSlots: clubRoom.voiceSlots
        });
      }

      // Leave socket room
      socket.leave(`club:${clubId}`);
      this.userSockets.delete(socket.id);

      // Broadcast updated online count
      this.broadcastOnlineCount(clubId);

      // Cleanup empty rooms
      if (clubRoom.members.size === 0) {
        this.clubRooms.delete(clubId);
        console.log(`🗑️ [CLEANUP] Empty club room ${clubId} deleted`);
      }
    } catch (error) {
      console.error('❌ [CLUB LEAVE ERROR]', error);
    }
  }

  /**
   * Handle sending message
   */
  handleSendMessage(socket, { clubId, userId, username, avatar, message, messageType = 'text' }) {
    try {
      if (socket.userId && socket.userId !== userId) {
        console.warn(`🔒 [CLUB SEC] Send message attempt by wrong user. socket=${socket.userId}, req=${userId}`);
        socket.emit('club:send_error', { error: 'Unauthorized user' });
        return;
      }

      // Server-side rate limiting (cannot be bypassed by client)
      if (!this._checkRateLimit(userId)) {
        socket.emit('club:send_error', { error: 'Rate limit exceeded. Slow down.' });
        return;
      }

      // Server-side message length validation
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        socket.emit('club:send_error', { error: 'Invalid message' });
        return;
      }
      const sanitizedMessage = message.trim().substring(0, this._maxMessageLength);

      const clubRoom = this.clubRooms.get(clubId);
      if (!clubRoom) {
        socket.emit('club:send_error', { error: 'Club room not found' });
        return;
      }

      // Verify user is member
      if (!clubRoom.members.has(userId)) {
        socket.emit('club:send_error', { error: 'Not a club member' });
        return;
      }

      // Create message object
      const messageObj = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        clubId,
        userId,
        username,
        avatar,
        message: sanitizedMessage,
        messageType,
        timestamp: Date.now(),
        deleted: false
      };

      // Store message (keep last 200 messages in memory)
      clubRoom.messages.push(messageObj);
      if (clubRoom.messages.length > 200) {
        clubRoom.messages.shift();
      }

      // Broadcast to all members in club
      this.io.to(`club:${clubId}`).emit('club:new_message', messageObj);

      console.log(`💬 [MESSAGE] ${username} in club ${clubId}: ${sanitizedMessage.substring(0, 50)}`);
    } catch (error) {
      console.error('❌ [SEND MESSAGE ERROR]', error);
      socket.emit('club:send_error', { error: error.message });
    }
  }

  /**
   * Handle typing indicator
   */
  handleTyping(socket, { clubId, userId, username, isTyping }) {
    try {
      if (socket.userId && socket.userId !== userId) return;

      const clubRoom = this.clubRooms.get(clubId);
      if (!clubRoom || !clubRoom.members.has(userId)) return;

      // Broadcast to others (not sender)
      socket.to(`club:${clubId}`).emit('club:user_typing', {
        userId,
        username,
        isTyping,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('❌ [TYPING ERROR]', error);
    }
  }

  /**
   * Handle message history request
   */
  handleRequestHistory(socket, { clubId, userId, limit = 50, before = null }) {
    try {
      if (socket.userId && socket.userId !== userId) {
        socket.emit('club:history_error', { error: 'Unauthorized user' });
        return;
      }

      const clubRoom = this.clubRooms.get(clubId);
      if (!clubRoom) {
        socket.emit('club:history_error', { error: 'Club room not found' });
        return;
      }

      // Verify user is member
      if (!clubRoom.members.has(userId)) {
        socket.emit('club:history_error', { error: 'Not a club member' });
        return;
      }

      let messages = clubRoom.messages;

      // Filter by timestamp if 'before' is provided
      if (before) {
        messages = messages.filter(m => m.timestamp < before);
      }

      // Get last N messages
      const history = messages.slice(-limit);

      socket.emit('club:message_history', {
        messages: history,
        hasMore: messages.length > limit
      });
    } catch (error) {
      console.error('❌ [HISTORY ERROR]', error);
      socket.emit('club:history_error', { error: error.message });
    }
  }

  /**
   * Handle message deletion (admin/owner only)
   */
  handleDeleteMessage(socket, { clubId, userId, messageId, role }) {
    try {
      if (socket.userId && socket.userId !== userId) {
        socket.emit('club:delete_error', { error: 'Unauthorized user' });
        return;
      }

      const clubRoom = this.clubRooms.get(clubId);
      if (!clubRoom) return;

      // Verify user has permission (owner or admin)
      if (role !== 'owner' && role !== 'admin') {
        socket.emit('club:delete_error', { error: 'Insufficient permissions' });
        return;
      }

      // Find and mark message as deleted
      const message = clubRoom.messages.find(m => m.id === messageId);
      if (message) {
        message.deleted = true;
        message.message = '[Message deleted]';

        // Broadcast deletion
        this.io.to(`club:${clubId}`).emit('club:message_deleted', {
          messageId,
          timestamp: Date.now()
        });

        console.log(`🗑️ [DELETE] Message ${messageId} deleted by ${userId}`);
      }
    } catch (error) {
      console.error('❌ [DELETE ERROR]', error);
    }
  }

  /**
   * Handle heartbeat for online status
   */
  handleHeartbeat(socket, { clubId, userId }) {
    try {
      if (socket.userId && socket.userId !== userId) return;

      const clubRoom = this.clubRooms.get(clubId);
      if (!clubRoom) return;

      const member = clubRoom.members.get(userId);
      if (member) {
        member.lastSeen = Date.now();
        member.isOnline = true;
      }
    } catch (error) {
      console.error('❌ [HEARTBEAT ERROR]', error);
    }
  }

  /**
   * Handle joining voice slot
   */
  handleJoinVoiceSlot(socket, { clubId, userId, username, avatar, slotIndex }) {
    try {
      if (socket.userId && socket.userId !== userId) return;

      const clubRoom = this.clubRooms.get(clubId);
      if (!clubRoom) return;

      // Ensure user isn't already in another slot
      const existingSlotIndex = clubRoom.voiceSlots.findIndex(slot => slot && slot.userId === userId);
      if (existingSlotIndex !== -1) {
        clubRoom.voiceSlots[existingSlotIndex] = null;
      }

      // Assign to new slot
      if (slotIndex >= 0 && slotIndex < 10) {
        clubRoom.voiceSlots[slotIndex] = { userId, username, avatar, joinedAt: Date.now(), isMuted: false };
      }

      // Broadcast updated slots
      this.io.to(`club:${clubId}`).emit('club:voice_slots_update', {
        voiceSlots: clubRoom.voiceSlots
      });
      console.log(`🎤 [VOICE SLOT] ${username} joined slot ${slotIndex} in club ${clubId}`);
    } catch (error) {
      console.error('❌ [VOICE SLOT ERROR]', error);
    }
  }

  /**
   * Handle leaving voice slot
   */
  handleLeaveVoiceSlot(socket, { clubId, userId }) {
    try {
      if (socket.userId && socket.userId !== userId) return;

      const clubRoom = this.clubRooms.get(clubId);
      if (!clubRoom) return;

      const existingSlotIndex = clubRoom.voiceSlots.findIndex(slot => slot && slot.userId === userId);
      if (existingSlotIndex !== -1) {
        clubRoom.voiceSlots[existingSlotIndex] = null;
        
        // Broadcast updated slots
        this.io.to(`club:${clubId}`).emit('club:voice_slots_update', {
          voiceSlots: clubRoom.voiceSlots
        });
        console.log(`🎤 [VOICE SLOT] User ${userId} left voice slot in club ${clubId}`);
      }
    } catch (error) {
      console.error('❌ [VOICE SLOT ERROR]', error);
    }
  }

  /**
   * Handle disconnection
   */
  handleDisconnect(socket) {
    try {
      console.log(`❌ [DISCONNECT] Socket ${socket.id} disconnected`);

      const userInfo = this.userSockets.get(socket.id);
      if (!userInfo) return;

      const { userId, clubId, username } = userInfo;
      const clubRoom = this.clubRooms.get(clubId);

      if (clubRoom && clubRoom.members.has(userId)) {
        const member = clubRoom.members.get(userId);
        member.isOnline = false;
        member.lastSeen = Date.now();

        // Notify others
        socket.to(`club:${clubId}`).emit('club:member_offline', {
          userId,
          username,
          timestamp: Date.now()
        });

        // Broadcast updated online count
        this.broadcastOnlineCount(clubId);

        // Remove from voice slots if present
        const slotIndex = clubRoom.voiceSlots.findIndex(slot => slot && slot.userId === userId);
        if (slotIndex !== -1) {
          clubRoom.voiceSlots[slotIndex] = null;
          this.io.to(`club:${clubId}`).emit('club:voice_slots_update', {
            voiceSlots: clubRoom.voiceSlots
          });
        }

        // Auto-remove after 5 minutes if not reconnected
        setTimeout(() => {
          if (clubRoom.members.has(userId) && !clubRoom.members.get(userId).isOnline) {
            clubRoom.members.delete(userId);
            console.log(`🗑️ [AUTO REMOVE] ${username} removed from club ${clubId} after timeout`);

            if (clubRoom.members.size === 0) {
              this.clubRooms.delete(clubId);
            }
          }
        }, 300000); // 5 minutes
      }

      this.userSockets.delete(socket.id);
    } catch (error) {
      console.error('❌ [DISCONNECT ERROR]', error);
    }
  }

  /**
   * Broadcast online member count
   */
  broadcastOnlineCount(clubId) {
    const clubRoom = this.clubRooms.get(clubId);
    if (!clubRoom) return;

    const onlineCount = Array.from(clubRoom.members.values()).filter(m => m.isOnline).length;

    this.io.to(`club:${clubId}`).emit('club:online_count', {
      onlineCount,
      totalMembers: clubRoom.members.size,
      timestamp: Date.now()
    });
  }

  /**
   * Server-side rate limiter: max N messages per window per user
   */
  _checkRateLimit(userId) {
    const now = Date.now();
    const entry = this._rateLimitMap.get(userId) || { count: 0, windowStart: now };

    if (now - entry.windowStart > this._rateLimitWindowMs) {
      // Reset window
      entry.count = 1;
      entry.windowStart = now;
    } else {
      entry.count += 1;
    }

    this._rateLimitMap.set(userId, entry);

    if (entry.count > this._rateLimitMax) {
      console.warn(`⚠️ [RATE LIMIT] User ${userId} exceeded message rate limit`);
      return false;
    }
    return true;
  }

  /**
   * Start cleanup interval for stale connections
   */
  startCleanupInterval() {
    setInterval(() => {
      const now = Date.now();
      const STALE_THRESHOLD = 120000; // 2 minutes

      for (const [clubId, clubRoom] of this.clubRooms.entries()) {
        for (const [userId, member] of clubRoom.members.entries()) {
          if (member.isOnline && now - member.lastSeen > STALE_THRESHOLD) {
            member.isOnline = false;
            console.log(`⚠️ [STALE] User ${userId} marked offline in club ${clubId}`);

            this.io.to(`club:${clubId}`).emit('club:member_offline', {
              userId,
              username: member.username,
              timestamp: now
            });
          }
        }

        // Broadcast updated count
        this.broadcastOnlineCount(clubId);
      }
    }, 60000); // Check every minute
  }

  /**
   * Get club room stats (for debugging)
   */
  getClubStats(clubId) {
    const clubRoom = this.clubRooms.get(clubId);
    if (!clubRoom) return null;

    return {
      clubId,
      totalMembers: clubRoom.members.size,
      onlineMembers: Array.from(clubRoom.members.values()).filter(m => m.isOnline).length,
      messageCount: clubRoom.messages.length,
      createdAt: clubRoom.createdAt
    };
  }
}

module.exports = ClubChatServer;
