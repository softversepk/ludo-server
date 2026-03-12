# Ludo Club Server

Socket.IO based multiplayer game server for Ludo Club app.

## Features

- Real-time multiplayer game synchronization
- Club chat system
- Live leaderboard updates
- Room-based matchmaking
- Bot player support
- Rematch functionality

## Local Development

```bash
# Install dependencies
npm install

# Start server
npm start

# Development mode with auto-reload
npm run dev
```

Server will run on `http://localhost:3000`

## Deployment

### Render.com (Recommended - Free)

1. Push code to GitHub
2. Go to https://render.com
3. Create new Web Service
4. Connect your GitHub repository
5. Configure:
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node

### Railway.app

1. Go to https://railway.app
2. Deploy from GitHub
3. Set root directory to `/server`

### Heroku

```bash
heroku create ludo-club-server
git subtree push --prefix server heroku main
```

## Environment Variables

- `PORT` - Server port (automatically set by hosting platforms)
- `NODE_ENV` - Environment (production/development)

## API Endpoints

The server uses Socket.IO for real-time communication. No REST endpoints.

## Socket Events

### Client → Server
- `register_user` - Register user socket
- `create_room` - Create game room
- `join_room` - Join existing room
- `find_match` - Find random match
- `start_game` - Start game
- `update_game_state` - Update game state
- `rematch_request` - Request rematch
- `rematch_accepted` - Accept rematch
- `rematch_rejected` - Reject rematch

### Server → Client
- `room_update` - Room state changed
- `game_state_update` - Game state changed
- `rematch_request_received` - Received rematch request
- `rematch_accepted` - Rematch accepted
- `rematch_rejected` - Rematch rejected

## Tech Stack

- Node.js
- Express
- Socket.IO
- CORS

## License

Private
