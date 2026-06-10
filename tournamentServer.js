const admin = require('firebase-admin');

// In-memory active tournaments
const activeTournaments = {};

const STAGE_CONFIG = {
  1: { playersPerMatch: 4, matchesCount: 4 },
  2: { playersPerMatch: 2, matchesCount: 2 },
  3: { playersPerMatch: 2, matchesCount: 1 }
};

function generateTournamentMatches(stage, players) {
  let matches = [];
  const config = STAGE_CONFIG[stage];
  if (!config) return matches;

  let shuffled = [...players].sort(() => Math.random() - 0.5);
  
  for (let i = 0; i < config.matchesCount; i++) {
    const matchPlayers = shuffled.slice(i * config.playersPerMatch, (i + 1) * config.playersPerMatch);
    if (matchPlayers.length > 0) {
      matches.push({
        id: `m${stage}_${i}`,
        players: matchPlayers,
        status: 'pending',
        winner: null
      });
    }
  }
  return matches;
}

class TournamentServer {
  static createTournament(tournamentId, betAmount, players) {
    const tournament = {
      id: tournamentId,
      betAmount,
      stage: 1,
      players,
      matches: generateTournamentMatches(1, players),
      status: 'active',
      createdAt: Date.now()
    };
    activeTournaments[tournamentId] = tournament;
    return tournament;
  }

  static getTournament(tournamentId) {
    return activeTournaments[tournamentId];
  }

  static async reportMatchResult(tournamentId, matchId, winnerId) {
    const tournament = activeTournaments[tournamentId];
    if (!tournament) return { error: 'Tournament not found' };

    const match = tournament.matches.find(m => m.id === matchId);
    if (!match) return { error: 'Match not found' };

    const winner = match.players.find(p => p.uid === winnerId || p.id === winnerId);
    if (!winner) return { error: 'Winner not in match' };

    match.status = 'finished';
    match.winner = winner;

    // Simulate bot matches securely
    tournament.matches.forEach(m => {
      if (m.status === 'pending') {
        const hasRealPlayer = m.players.some(p => !p.isBot);
        if (!hasRealPlayer) {
          const botWinnerIndex = Math.floor(Math.random() * m.players.length);
          m.winner = m.players[botWinnerIndex];
          m.status = 'finished';
        }
      }
    });

    // Check if all matches in stage are finished
    const allFinished = tournament.matches.every(m => m.status === 'finished');
    if (allFinished) {
      const winners = tournament.matches.map(m => m.winner);
      tournament.stage += 1;
      
      if (tournament.stage > 3) {
        tournament.status = 'completed';
      } else {
        tournament.players = winners;
        tournament.matches = generateTournamentMatches(tournament.stage, winners);
      }
    }

    return { success: true, tournament };
  }
}

module.exports = TournamentServer;