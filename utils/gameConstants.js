/**
 * Game Constants - Core game configuration
 */

// Board dimensions
exports.BOARD_SIZE = 15;
exports.CELL_COUNT = 52; // Main track cells (restored to 52 - added 4 corner cells back)
exports.HOME_STRETCH_LENGTH = 6;

// Player colors
exports.PLAYER_COLORS = {
  RED: "#E53935",
  GREEN: "#43A047",
  YELLOW: "#FDD835",
  BLUE: "#1E88E5",
};

// Player positions on board (starting corners)
// homeEntry: the last cell on main track before entering home stretch
// Updated for 52-cell track (restored 4 corner cells at top/right/bottom/left)
exports.PLAYER_POSITIONS = {
  RED: { corner: "top-left", startCell: 0, homeEntry: 50 },
  GREEN: { corner: "top-right", startCell: 13, homeEntry: 11 },
  YELLOW: { corner: "bottom-right", startCell: 26, homeEntry: 24 },
  BLUE: { corner: "bottom-left", startCell: 39, homeEntry: 37 },
};

// Home entry lock positions (for Quick Arrow mode)
// These are the positions where tokens must have killed an opponent to enter home stretch
exports.HOME_ENTRY_LOCKS = {
  RED: 50,    // Position before entering RED home stretch (row 7, col 0)
  GREEN: 11,  // Position before entering GREEN home stretch (row 0, col 7)
  YELLOW: 24, // Position before entering YELLOW home stretch (row 7, col 14)
  BLUE: 37,   // Position before entering BLUE home stretch (row 14, col 7)
};

// Safe zones (cells where tokens cannot be killed)
// Updated for 52-cell track (restored 4 corner cells)
// Start cells: 0(RED), 13(GREEN), 26(YELLOW), 39(BLUE)
// Star cells  : 8(row2,col6), 20(row6,col11), 33(row11,col8), 45(row8,col4)
exports.SAFE_ZONES = [0, 8, 13, 20, 26, 33, 39, 45];

// Token states
exports.TOKEN_STATE = {
  HOME: "home",
  ACTIVE: "active",
  FINISHED: "finished",
};

// Game states
exports.GAME_STATE = {
  WAITING: "waiting",
  ROLLING: "rolling",
  MOVING: "moving",
  FINISHED: "finished",
};

// Game modes
exports.GAME_MODE = {
  LOCAL_VS_AI: "local_vs_ai",
  ONLINE_RANDOM: "online_random",
  PRIVATE_ROOM: "private_room",
};

// AI difficulty levels
exports.AI_DIFFICULTY = {
  EASY: "easy",
  MEDIUM: "medium",
  HARD: "hard",
};

// Animation durations (ms)
exports.ANIMATION = {
  DICE_ROLL: 800,
  TOKEN_MOVE: 300,
  TOKEN_KILL: 500,
  WIN_CELEBRATION: 2000,
};

// Board themes
exports.BOARD_THEMES = {
  CLASSIC: {
    id: "classic",
    name: "Classic",
    background: "#F5E6D3",
    border: "#8B4513",
    cellBorder: "#D4A574",
  },
  MODERN: {
    id: "modern",
    name: "Modern",
    background: "#2C3E50",
    border: "#1ABC9C",
    cellBorder: "#34495E",
  },
  NEON: {
    id: "neon",
    name: "Neon",
    background: "#0D0D0D",
    border: "#FF00FF",
    cellBorder: "#00FFFF",
  },
  NATURE: {
    id: "nature",
    name: "Nature",
    background: "#E8F5E9",
    border: "#2E7D32",
    cellBorder: "#81C784",
  },
};

// Token skins
exports.TOKEN_SKINS = {
  CLASSIC: { id: "classic", name: "Classic", style: "circle" },
  STAR: { id: "star", name: "Star", style: "star" },
  DIAMOND: { id: "diamond", name: "Diamond", style: "diamond" },
  CROWN: { id: "crown", name: "Crown", style: "crown" },
};

// Rewards
exports.REWARDS = {
  WIN_GAME: 100,
  KILL_TOKEN: 10,
  FINISH_TOKEN: 25,
  DAILY_LOGIN: 50,
  CLUB_CHALLENGE_WIN: 200,
};
