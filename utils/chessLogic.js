/**
 * Chess Game Logic
 */
const {  BOARD_SIZE, COLORS, FILES, INITIAL_POSITIONS, PIECES  } = require('./chessConstants');

/**
 * Convert algebraic notation to coordinates
 */
exports.algebraicToCoords = (position) => {
  const file = position[0];
  const rank = parseInt(position[1]);
  const col = FILES.indexOf(file);
  const row = 8 - rank;
  return { row, col };
};

/**
 * Convert coordinates to algebraic notation
 */
exports.coordsToAlgebraic = (row, col) => {
  const file = FILES[col];
  const rank = 8 - row;
  return `${file}${rank}`;
};

/**
 * Initialize chess board with pieces
 */
exports.initializeChessGame = (playerColor = COLORS.WHITE) => {
  const pieces = [];
  
  // White pieces
  pieces.push({ type: PIECES.KING, color: COLORS.WHITE, position: 'e1', hasMoved: false });
  pieces.push({ type: PIECES.QUEEN, color: COLORS.WHITE, position: 'd1', hasMoved: false });
  INITIAL_POSITIONS.white.rooks.forEach(pos => {
    pieces.push({ type: PIECES.ROOK, color: COLORS.WHITE, position: pos, hasMoved: false });
  });
  INITIAL_POSITIONS.white.bishops.forEach(pos => {
    pieces.push({ type: PIECES.BISHOP, color: COLORS.WHITE, position: pos, hasMoved: false });
  });
  INITIAL_POSITIONS.white.knights.forEach(pos => {
    pieces.push({ type: PIECES.KNIGHT, color: COLORS.WHITE, position: pos, hasMoved: false });
  });
  INITIAL_POSITIONS.white.pawns.forEach(pos => {
    pieces.push({ type: PIECES.PAWN, color: COLORS.WHITE, position: pos, hasMoved: false });
  });
  
  // Black pieces
  pieces.push({ type: PIECES.KING, color: COLORS.BLACK, position: 'e8', hasMoved: false });
  pieces.push({ type: PIECES.QUEEN, color: COLORS.BLACK, position: 'd8', hasMoved: false });
  INITIAL_POSITIONS.black.rooks.forEach(pos => {
    pieces.push({ type: PIECES.ROOK, color: COLORS.BLACK, position: pos, hasMoved: false });
  });
  INITIAL_POSITIONS.black.bishops.forEach(pos => {
    pieces.push({ type: PIECES.BISHOP, color: COLORS.BLACK, position: pos, hasMoved: false });
  });
  INITIAL_POSITIONS.black.knights.forEach(pos => {
    pieces.push({ type: PIECES.KNIGHT, color: COLORS.BLACK, position: pos, hasMoved: false });
  });
  INITIAL_POSITIONS.black.pawns.forEach(pos => {
    pieces.push({ type: PIECES.PAWN, color: COLORS.BLACK, position: pos, hasMoved: false });
  });
  
  return {
    pieces,
    currentTurn: COLORS.WHITE,
    selectedPiece: null,
    legalMoves: [],
    capturedPieces: { white: [], black: [] },
    moveHistory: [],
    isCheck: false,
    isCheckmate: false,
    isStalemate: false,
    enPassantTarget: null,
    playerColor
  };
};

/**
 * Get piece at position
 */
exports.getPieceAt = (pieces, position) => {
  return pieces.find(p => p.position === position);
};

/**
 * Check if square is occupied by same color
 */
exports.isOccupiedBySameColor = (pieces, position, color) => {
  const piece = getPieceAt(pieces, position);
  return piece && piece.color === color;
};

/**
 * Check if square is occupied by opponent
 */
exports.isOccupiedByOpponent = (pieces, position, color) => {
  const piece = getPieceAt(pieces, position);
  return piece && piece.color !== color;
};

/**
 * Check if position is on board
 */
exports.isOnBoard = (row, col) => {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
};

/**
 * Get legal moves for a pawn
 */
const getPawnMoves = (piece, pieces) => {
  const moves = [];
  const { row, col } = algebraicToCoords(piece.position);
  const direction = piece.color === COLORS.WHITE ? -1 : 1;
  const startRank = piece.color === COLORS.WHITE ? 6 : 1;
  
  // Forward move
  const forwardRow = row + direction;
  if (isOnBoard(forwardRow, col)) {
    const forwardPos = coordsToAlgebraic(forwardRow, col);
    if (!getPieceAt(pieces, forwardPos)) {
      moves.push(forwardPos);
      
      // Double move from start
      if (row === startRank) {
        const doubleRow = row + (direction * 2);
        const doublePos = coordsToAlgebraic(doubleRow, col);
        if (!getPieceAt(pieces, doublePos)) {
          moves.push(doublePos);
        }
      }
    }
  }
  
  // Captures
  [-1, 1].forEach(colOffset => {
    const captureCol = col + colOffset;
    if (isOnBoard(forwardRow, captureCol)) {
      const capturePos = coordsToAlgebraic(forwardRow, captureCol);
      if (isOccupiedByOpponent(pieces, capturePos, piece.color)) {
        moves.push(capturePos);
      }
    }
  });
  
  return moves;
};

/**
 * Get legal moves for a rook
 */
const getRookMoves = (piece, pieces) => {
  const moves = [];
  const { row, col } = algebraicToCoords(piece.position);
  
  // Directions: up, down, left, right
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  
  directions.forEach(([dRow, dCol]) => {
    let newRow = row + dRow;
    let newCol = col + dCol;
    
    while (isOnBoard(newRow, newCol)) {
      const newPos = coordsToAlgebraic(newRow, newCol);
      
      if (isOccupiedBySameColor(pieces, newPos, piece.color)) {
        break;
      }
      
      moves.push(newPos);
      
      if (isOccupiedByOpponent(pieces, newPos, piece.color)) {
        break;
      }
      
      newRow += dRow;
      newCol += dCol;
    }
  });
  
  return moves;
};

/**
 * Get legal moves for a bishop
 */
const getBishopMoves = (piece, pieces) => {
  const moves = [];
  const { row, col } = algebraicToCoords(piece.position);
  
  // Diagonal directions
  const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  
  directions.forEach(([dRow, dCol]) => {
    let newRow = row + dRow;
    let newCol = col + dCol;
    
    while (isOnBoard(newRow, newCol)) {
      const newPos = coordsToAlgebraic(newRow, newCol);
      
      if (isOccupiedBySameColor(pieces, newPos, piece.color)) {
        break;
      }
      
      moves.push(newPos);
      
      if (isOccupiedByOpponent(pieces, newPos, piece.color)) {
        break;
      }
      
      newRow += dRow;
      newCol += dCol;
    }
  });
  
  return moves;
};

/**
 * Get legal moves for a knight
 */
const getKnightMoves = (piece, pieces) => {
  const moves = [];
  const { row, col } = algebraicToCoords(piece.position);
  
  // L-shaped moves
  const offsets = [
    [-2, -1], [-2, 1], [-1, -2], [-1, 2],
    [1, -2], [1, 2], [2, -1], [2, 1]
  ];
  
  offsets.forEach(([dRow, dCol]) => {
    const newRow = row + dRow;
    const newCol = col + dCol;
    
    if (isOnBoard(newRow, newCol)) {
      const newPos = coordsToAlgebraic(newRow, newCol);
      if (!isOccupiedBySameColor(pieces, newPos, piece.color)) {
        moves.push(newPos);
      }
    }
  });
  
  return moves;
};

/**
 * Get legal moves for a queen
 */
const getQueenMoves = (piece, pieces) => {
  return [...getRookMoves(piece, pieces), ...getBishopMoves(piece, pieces)];
};

/**
 * Get legal moves for a king
 */
const getKingMoves = (piece, pieces) => {
  const moves = [];
  const { row, col } = algebraicToCoords(piece.position);
  
  // All 8 directions
  const directions = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, -1], [1, 0], [1, 1]
  ];
  
  directions.forEach(([dRow, dCol]) => {
    const newRow = row + dRow;
    const newCol = col + dCol;
    
    if (isOnBoard(newRow, newCol)) {
      const newPos = coordsToAlgebraic(newRow, newCol);
      if (!isOccupiedBySameColor(pieces, newPos, piece.color)) {
        moves.push(newPos);
      }
    }
  });
  
  return moves;
};

/**
 * Get all legal moves for a piece
 */
exports.getLegalMoves = (piece, pieces) => {
  if (!piece) return [];
  
  switch (piece.type) {
    case PIECES.PAWN:
      return getPawnMoves(piece, pieces);
    case PIECES.ROOK:
      return getRookMoves(piece, pieces);
    case PIECES.BISHOP:
      return getBishopMoves(piece, pieces);
    case PIECES.KNIGHT:
      return getKnightMoves(piece, pieces);
    case PIECES.QUEEN:
      return getQueenMoves(piece, pieces);
    case PIECES.KING:
      return getKingMoves(piece, pieces);
    default:
      return [];
  }
};

/**
 * Check if king is in check
 */
exports.isKingInCheck = (pieces, color) => {
  const king = pieces.find(p => p.type === PIECES.KING && p.color === color);
  if (!king) return false;
  
  // Check if any opponent piece can attack the king
  const opponentPieces = pieces.filter(p => p.color !== color);
  
  for (const piece of opponentPieces) {
    const moves = getLegalMoves(piece, pieces);
    if (moves.includes(king.position)) {
      return true;
    }
  }
  
  return false;
};

/**
 * Move piece and return new game state
 */
exports.movePiece = (gameState, fromPos, toPos) => {
  const { pieces, currentTurn, capturedPieces, moveHistory = [] } = gameState;
  
  const movingPiece = getPieceAt(pieces, fromPos);
  if (!movingPiece || movingPiece.color !== currentTurn) {
    return gameState;
  }
  
  const capturedPiece = getPieceAt(pieces, toPos);
  
  // Create new pieces array
  const newPieces = pieces
    .filter(p => p.position !== toPos) // Remove captured piece if any
    .map(p => {
      if (p.position === fromPos) {
        return { ...p, position: toPos, hasMoved: true };
      }
      return p;
    });
  
  const newCapturedPieces = { ...capturedPieces };
  if (capturedPiece) {
    newCapturedPieces[capturedPiece.color].push(capturedPiece);
  }
  
  const newTurn = currentTurn === COLORS.WHITE ? COLORS.BLACK : COLORS.WHITE;
  const isCheck = isKingInCheck(newPieces, newTurn);
  
  // Ensure moveHistory is an array
  const safeHistory = Array.isArray(moveHistory) ? moveHistory : [];
  
  return {
    ...gameState,
    pieces: newPieces,
    currentTurn: newTurn,
    selectedPiece: null,
    legalMoves: [],
    capturedPieces: newCapturedPieces,
    moveHistory: [...safeHistory, { from: fromPos, to: toPos, piece: movingPiece.type }],
    isCheck,
    lastMove: { from: fromPos, to: toPos }
  };
};

/**
 * Check if checkmate
 */
exports.isCheckmate = (pieces, color) => {
  if (!isKingInCheck(pieces, color)) return false;
  
  // Check if any move can get out of check
  const playerPieces = pieces.filter(p => p.color === color);
  
  for (const piece of playerPieces) {
    const moves = getLegalMoves(piece, pieces);
    for (const move of moves) {
      // Simulate move
      const testPieces = pieces.map(p => {
        if (p.position === piece.position) {
          return { ...p, position: move };
        }
        return p;
      }).filter(p => p.position !== move || p === piece);
      
      if (!isKingInCheck(testPieces, color)) {
        return false;
      }
    }
  }
  
  return true;
};
