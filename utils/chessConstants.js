/**
 * Chess Game Constants
 */

// Board configuration
exports.BOARD_SIZE = 8;
exports.FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
exports.RANKS = [8, 7, 6, 5, 4, 3, 2, 1];

// Colors
exports.COLORS = {
  WHITE: 'white',
  BLACK: 'black'
};

// Piece types
exports.PIECES = {
  KING: 'king',
  QUEEN: 'queen',
  ROOK: 'rook',
  BISHOP: 'bishop',
  KNIGHT: 'knight',
  PAWN: 'pawn'
};

// Board colors
exports.BOARD_COLORS = {
  LIGHT: '#F0D9B5',
  DARK: '#B58863',
  SELECTED: '#7FC97F',
  LEGAL_MOVE: '#90EE90',
  CHECK: '#FF6B6B',
  LAST_MOVE: '#CDD26A'
};

// Piece Unicode symbols
exports.PIECE_SYMBOLS = {
  white: {
    king: '♔',
    queen: '♕',
    rook: '♖',
    bishop: '♗',
    knight: '♘',
    pawn: '♙'
  },
  black: {
    king: '♚',
    queen: '♛',
    rook: '♜',
    bishop: '♝',
    knight: '♞',
    pawn: '♟'
  }
};

// Initial piece positions
exports.INITIAL_POSITIONS = {
  white: {
    king: 'e1',
    queen: 'd1',
    rooks: ['a1', 'h1'],
    bishops: ['c1', 'f1'],
    knights: ['b1', 'g1'],
    pawns: ['a2', 'b2', 'c2', 'd2', 'e2', 'f2', 'g2', 'h2']
  },
  black: {
    king: 'e8',
    queen: 'd8',
    rooks: ['a8', 'h8'],
    bishops: ['c8', 'f8'],
    knights: ['b8', 'g8'],
    pawns: ['a7', 'b7', 'c7', 'd7', 'e7', 'f7', 'g7', 'h7']
  }
};

// Game status
exports.GAME_STATUS = {
  ACTIVE: 'active',
  CHECK: 'check',
  CHECKMATE: 'checkmate',
  STALEMATE: 'stalemate',
  DRAW: 'draw'
};
