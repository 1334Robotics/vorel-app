const { fetchEventMatchResults } = require('./api');

// Function to process match data with TBA results
async function processMatchDataWithTBAResults(matches, teamKey, eventKey) {
  try {
    // Ensure teamKey is in the right format for TBA
    const formattedTeamKey = teamKey.startsWith('frc') ? teamKey : `frc${teamKey}`;

    // Fetch match results from TBA
    const tbaMatches = await fetchEventMatchResults(eventKey);

    // Create a map of TBA match results for quick lookup
    const tbaMatchMap = {};
    tbaMatches.forEach(match => {
      // Add a separator to avoid ambiguity (e.g. qm1 vs qm10)
      const matchKey = match.comp_level + "_" + match.match_number;
      tbaMatchMap[matchKey] = match;
    });

    matches.forEach(match => {
      if (match.status === "Completed") {
        const [type, numberStr] = match.label.split(' ');
        const number = parseInt(numberStr);
        let compLevel;
        switch (type.toLowerCase()) {
          case 'qualification': compLevel = 'qm'; break;
          case 'quarterfinal': compLevel = 'qf'; break;
          case 'semifinal': compLevel = 'sf'; break;
          case 'final': compLevel = 'f'; break;
          case 'playoff': compLevel = 'pl'; break;
          case 'practice': compLevel = 'pr'; break;
          default: compLevel = 'xx';
        }

        // When looking up matches
        const matchKey = compLevel + "_" + number;
        const tbaMatch = tbaMatchMap[matchKey];

        // Only consider it a qualification match if it explicitly has "qualification" in the label
        // or if the comp_level is 'qm'
        const matchType = match.label.split(' ')[0].toLowerCase();
        const isQualificationMatch = matchType === 'qualification' || (tbaMatch && tbaMatch.comp_level === 'qm');

        if (tbaMatch && tbaMatch.alliances) {
          const isRed = match.redTeams.includes(teamKey.replace('frc', ''));
          const allianceColor = isRed ? 'red' : 'blue';
          const opposingColor = isRed ? 'blue' : 'red';

          const allianceScore = tbaMatch.alliances[allianceColor].score;
          const opposingScore = tbaMatch.alliances[opposingColor].score;

          if (tbaMatch.winning_alliance === allianceColor) {
            match.result = 'win';
          } else if (tbaMatch.winning_alliance === opposingColor) {
            match.result = 'loss';
          } else if (tbaMatch.winning_alliance === '') {
            match.result = 'tie';
          }

          match.score = {
            alliance: allianceScore,
            opposing: opposingScore
          };

          // Only calculate ranking points for qualification matches
          if (isQualificationMatch && tbaMatch.score_breakdown) {
            const rpBreakdown = tbaMatch.score_breakdown[allianceColor];

            if (rpBreakdown) {
              match.rankingPoints = {
                total: 0,
                breakdown: []
              };

              // For 2025, check the autoBonusAchieved field for Auto RP
              if (rpBreakdown.autoBonusAchieved) {
                match.rankingPoints.breakdown.push('Auto RP');
                match.rankingPoints.total += 1;
              }

              // End-game Barge RP check
              if (rpBreakdown.bargeBonusAchieved || 
                  rpBreakdown.endgameRankingPoint || 
                  rpBreakdown.bargeRankingPoint) {
                match.rankingPoints.breakdown.push('Barge RP');
                match.rankingPoints.total += 1;
              }

              // Ranking points for match results
              if (match.result === 'win') {
                match.rankingPoints.breakdown.push('Win');
                match.rankingPoints.total += 3;
              } else if (match.result === 'tie') {
                match.rankingPoints.breakdown.push('Tie');
                match.rankingPoints.total += 1;
              }

              // Try multiple possible field names for coral RP
              if (rpBreakdown.coralBonusAchieved !== undefined) {
                if (rpBreakdown.coralBonusAchieved) {
                  match.rankingPoints.breakdown.push('Coral RP');
                  match.rankingPoints.total += 1;
                }
              }

              // Coopertition bonus - try multiple possible field names
              if (rpBreakdown.coopertitionBonus) {
                match.rankingPoints.breakdown.push('Coopertition RP');
                match.rankingPoints.total += 1;
              }
            }
          }
        }
      }
    });

    return matches;
  } catch (error) {
    console.error('Error processing TBA match data:', error);
    return matches;
  }
}

// Calculate record from completed matches
function calculateRecordFromCompletedMatches(completedMatches) {
  let wins = 0, losses = 0, ties = 0;
  
  completedMatches.forEach(match => {
    if (match.result === 'win') wins++;
    else if (match.result === 'loss') losses++;
    else if (match.result === 'tie') ties++;
  });
  
  return { wins, losses, ties };
}

// Helper function to extract only the RP-relevant data from score breakdown
function extractRPRelevantData(breakdown) {
  if (!breakdown) return null;
  
  return {
    // Extract only the fields used for RP calculations
    autoPoints: breakdown.autoPoints,
    endGameBargePoints: breakdown.endGameBargePoints,
    endgameRankingPoint: breakdown.endgameRankingPoint,
    bargeRankingPoint: breakdown.bargeRankingPoint,
    coralBonusAchieved: breakdown.coralBonusAchieved,
    coopertitionBonus: breakdown.coopertitionBonus,
    coopertitionRankingPoint: breakdown.coopertitionRankingPoint,
    coopertitionRP: breakdown.coopertitionRP
  };
}

module.exports = {
  processMatchDataWithTBAResults,
  calculateRecordFromCompletedMatches,
  extractRPRelevantData
};