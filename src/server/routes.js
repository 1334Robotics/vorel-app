const express = require('express');
const router = express.Router();
const { fetchEventDetails, fetchTeamStatusAtEvent, fetchEventMatchResults, fetchTBAEventDetails, searchTBAEvents } = require('./api');
const crypto = require('crypto');

// GET /api/TBA-matches/test - Returns raw event data
// DO NOT UNCOMMENT THIS UNLESS YOU KNOW WHAT YOU'RE DOING AS THIS WILL ALLOW OTHERS TO EXPLOIT YOUR API KEY
// router.get('/test', async (req, res) => {
//   const { eventKey } = req.query;
//   const eventDetails = await fetchEventDetails(eventKey);
//   res.send(eventDetails);
// });

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

            // Debug output to see what's happening with ranking points
            
            // console.log('\n----- RANKING POINTS DEBUG -----');
            // console.log(`Match: ${match.label} (Key: ${matchKey})`);
            // console.log(`Team: ${teamKey} on ${allianceColor} alliance`);
            // console.log('TBA match data:', JSON.stringify({
            //   comp_level: tbaMatch.comp_level,
            //   match_number: tbaMatch.match_number,
            //   score_breakdown: tbaMatch.score_breakdown[allianceColor]
            // }, null, 2));

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
              
              // Debug output of calculated RPs
              // console.log('Calculated ranking points:', {
              //   total: match.rankingPoints.total,
              //   breakdown: match.rankingPoints.breakdown
              // });
              // console.log('----------------------------------\n');
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

// Add this function after processMatchDataWithTBAResults
function calculateRecordFromCompletedMatches(completedMatches) {
  let wins = 0, losses = 0, ties = 0;
  
  completedMatches.forEach(match => {
    if (match.result === 'win') wins++;
    else if (match.result === 'loss') losses++;
    else if (match.result === 'tie') ties++;
  });
  
  return { wins, losses, ties };
}

// GET / - Full page version with TBA data
router.get('/', async (req, res) => {
  const { teamKey, eventKey: rawEventKey } = req.query;
  const eventKey = rawEventKey ? rawEventKey.toLowerCase() : rawEventKey;
  
  // If teamKey or eventKey are not provided, render an input form
  if (!teamKey || !eventKey) {
    return res.render('pages/home');
  }
  
  // Format team number (remove "frc" prefix if present)
  const formattedTeamKey = teamKey.startsWith('frc') ? teamKey.substring(3) : teamKey;
  
  try {
    // Load match data
    const eventData = await fetchEventDetails(eventKey);
    if (!eventData) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    // Fetch event name from TBA
    let eventName = eventKey; // Default to eventKey if TBA fetch fails
    try {
      const tbaEventDetails = await fetchTBAEventDetails(eventKey);
      if (tbaEventDetails && tbaEventDetails.name) {
        eventName = tbaEventDetails.name;
      }
    } catch (error) {
      console.error('Error fetching event name from TBA:', error);
    }
    
    // Fetch team ranking data from TBA
    const formattedTBATeamKey = `frc${formattedTeamKey}`;
    const teamStatus = await fetchTeamStatusAtEvent(formattedTBATeamKey, eventKey);
    
    // Extract ranking information
    let teamRanking = null;

    if (teamStatus && teamStatus.qual && teamStatus.qual.ranking) {
      
      // For 2025 REEFSCAPE, we need to calculate the total RP correctly
      // First, check if ranking_points is directly available
      let totalRP = 0;
      
      if (teamStatus.qual.ranking.ranking_points !== undefined) {
        // If TBA provides ranking_points directly
        totalRP = teamStatus.qual.ranking.ranking_points;
      } else if (teamStatus.qual.ranking.extra_stats && teamStatus.qual.ranking.extra_stats.length > 0) {
        // Try extra_stats (sometimes TBA puts RP here)
        totalRP = teamStatus.qual.ranking.extra_stats[0] || 0;
      } else if (teamStatus.qual.ranking.sort_orders && teamStatus.qual.ranking.sort_orders.length > 0) {
        // Try sort_orders (another place TBA may put RP)
        totalRP = teamStatus.qual.ranking.sort_orders[0] || 0;
      }
      
      // Get matches played from TBA (fallback)
      const tbaMatchesPlayed = teamStatus.qual.ranking.matches_played || 0;
      
      // Rest of the existing code
      let matches = [...eventData.matches]; // Create a copy we can modify
      const nowQueuing = eventData.nowQueuing;
      
      // Sort matches by their sequence (match type then number)
      matches.sort((a, b) => {
        const aType = a.label.split(' ')[0];
        const bType = b.label.split(' ')[0];
        
        if (aType !== bType) return aType.localeCompare(bType);
        
        const aNum = parseInt(a.label.split(' ')[1]);
        const bNum = parseInt(b.label.split(' ')[1]);
        return aNum - bNum;
      });
      
      // Auto-complete logic: mark earlier "On field" match as "Completed" if a later one is "On field"
      for (let i = 0; i < matches.length - 1; i++) {
        if (matches[i].status === "On field") {
          for (let j = i + 1; j < matches.length; j++) {
            if (matches[j].status === "On field") {
              matches[i].status = "Completed";
              break;
            }
          }
        }
      }
      
      // Filter matches for the requested team
      const teamMatches = matches.filter(match => 
        Array.isArray(match.redTeams) && match.redTeams.includes(formattedTeamKey) || 
        Array.isArray(match.blueTeams) && match.blueTeams.includes(formattedTeamKey)
      );
      
      // Count all completed matches for the team from Nexus data (including non-qualification matches)
      const completedMatches = teamMatches.filter(match => 
        match.status === "Completed"
      ).length;
      
      // Use Nexus data for matches played count if available, otherwise fall back to TBA
      const matchesPlayed = completedMatches > 0 ? completedMatches : tbaMatchesPlayed;
      
      teamRanking = {
        rank: teamStatus.qual.ranking.rank,
        totalRP: totalRP,
        matches: teamStatus.qual.num_teams,
        record: `${teamStatus.qual.ranking.record.wins}-${teamStatus.qual.ranking.record.losses}-${teamStatus.qual.ranking.record.ties}`,
        matchesPlayed: matchesPlayed
      };
    }
    
    // Rest of the existing code
    let matches = [...eventData.matches]; // Create a copy we can modify
    const nowQueuing = eventData.nowQueuing;
    
    // Sort matches by their sequence (match type then number)
    matches.sort((a, b) => {
      const aType = a.label.split(' ')[0];
      const bType = b.label.split(' ')[0];
      
      if (aType !== bType) return aType.localeCompare(bType);
      
      const aNum = parseInt(a.label.split(' ')[1]);
      const bNum = parseInt(b.label.split(' ')[1]);
      return aNum - bNum;
    });
    
    // Auto-complete logic: mark earlier "On field" match as "Completed" if a later one is "On field"
    for (let i = 0; i < matches.length - 1; i++) {
      if (matches[i].status === "On field") {
        for (let j = i + 1; j < matches.length; j++) {
          if (matches[j].status === "On field") {
            matches[i].status = "Completed";
            break;
          }
        }
      }
    }
    
    // Filter matches for the requested team
    const teamMatches = matches.filter(match => 
      Array.isArray(match.redTeams) && match.redTeams.includes(formattedTeamKey) || 
      Array.isArray(match.blueTeams) && match.blueTeams.includes(formattedTeamKey)
    );
    
    // Add TBA data to matches
    const matchesWithResults = await processMatchDataWithTBAResults(teamMatches, formattedTeamKey, eventKey);
    
    // Group matches by type and separate completed matches
    const matchGroups = {};
    const completedMatches = [];
    matchesWithResults.forEach(match => {
      if (match.status === "Completed") {
        completedMatches.push(match);
      } else {
        const matchType = match.label.split(' ')[0];
        if (!matchGroups[matchType]) {
          matchGroups[matchType] = [];
        }
        matchGroups[matchType].push(match);
      }
    });

    // Calculate record from completed matches
    const nexusRecord = calculateRecordFromCompletedMatches(completedMatches);
    const nexusRecordString = `${nexusRecord.wins}-${nexusRecord.losses}-${nexusRecord.ties}`;

    // Use Nexus record instead of TBA record
    if (teamRanking) {
      teamRanking.record = nexusRecordString;
    }
    
    // Render the matches page with the match data and ranking info
    res.render('pages/matches', {
      teamKey,
      formattedTeamKey,
      eventKey,
      eventName,
      matchGroups,
      completedMatches,
      nowQueuing,
      teamRanking
    });
    
  } catch (error) {
    console.error('Error generating full page match data:', error);
    // Instead of returning error JSON, render the same page with empty data and error message
    res.render('pages/matches', {
      teamKey: teamKey || '',
      formattedTeamKey: teamKey ? (teamKey.startsWith('frc') ? teamKey.substring(3) : teamKey) : '',
      eventKey: eventKey || '',
      eventName: eventKey || 'Unknown Event',
      matchGroups: {},
      completedMatches: [],
      nowQueuing: null,
      teamRanking: null,
      errorMessage: `Failed to generate match data: ${error.message}`
    });
  }
});

// GET /embed - Embeddable version of team match display
router.get('/embed', async (req, res) => {
  const { teamKey, eventKey: rawEventKey, height = '600' } = req.query;
  const eventKey = rawEventKey ? rawEventKey.toLowerCase() : rawEventKey;
  
  if (!teamKey) {
    return res.status(400).json({ error: 'Missing teamKey parameter' });
  }

  if (!eventKey) {
    return res.status(400).json({ error: 'Missing eventKey parameter' });
  }
  
  // Format team number (remove "frc" prefix if present)
  const formattedTeamKey = teamKey.startsWith('frc') ? teamKey.substring(3) : teamKey;
  
  // Set display options
  const containerHeight = parseInt(height) > 0 ? parseInt(height) : 600;
  
  try {
    // Load match data
    const eventData = await fetchEventDetails(eventKey);
    if (!eventData) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    // Fetch event name from TBA
    let eventName = eventKey; // Default to eventKey if TBA fetch fails
    try {
      const tbaEventDetails = await fetchTBAEventDetails(eventKey);
      if (tbaEventDetails && tbaEventDetails.name) {
        eventName = tbaEventDetails.name;
      }
    } catch (error) {
      console.error('Error fetching event name from TBA:', error);
    }
    
    // Fetch team ranking data from TBA
    const formattedTBATeamKey = `frc${formattedTeamKey}`;
    const teamStatus = await fetchTeamStatusAtEvent(formattedTBATeamKey, eventKey);
    
    // Extract ranking information
    let teamRanking = null;
    let totalRankingPoints = 0;

    if (teamStatus && teamStatus.qual && teamStatus.qual.ranking) {
      
      // For 2025 REEFSCAPE, we need to calculate the total RP correctly
      // First, check if ranking_points is directly available
      let totalRP = 0;
      
      if (teamStatus.qual.ranking.ranking_points !== undefined) {
        // If TBA provides ranking_points directly
        totalRP = teamStatus.qual.ranking.ranking_points;
      } else if (teamStatus.qual.ranking.extra_stats && teamStatus.qual.ranking.extra_stats.length > 0) {
        // Try extra_stats (sometimes TBA puts RP here)
        totalRP = teamStatus.qual.ranking.extra_stats[0] || 0;
      } else if (teamStatus.qual.ranking.sort_orders && teamStatus.qual.ranking.sort_orders.length > 0) {
        // Try sort_orders (another place TBA may put RP)
        totalRP = teamStatus.qual.ranking.sort_orders[0] || 0;
      }
      
      // Get matches played
      const matchesPlayed = teamStatus.qual.ranking.matches_played || 0;
      
      teamRanking = {
        rank: teamStatus.qual.ranking.rank,
        totalRP: totalRP,
        matches: teamStatus.qual.num_teams,
        record: `${teamStatus.qual.ranking.record.wins}-${teamStatus.qual.ranking.record.losses}-${teamStatus.qual.ranking.record.ties}`,
        matchesPlayed: matchesPlayed
      };
      
      totalRankingPoints = totalRP;
    }
    
    // Use these variables from the fetched data
    let matches = [...eventData.matches]; // Create a copy we can modify
    const nowQueuing = eventData.nowQueuing;
    
    // First, sort matches by their sequence
    matches.sort((a, b) => {
      // First sort by match type (Qualification, Playoff, etc.)
      const aType = a.label.split(' ')[0];
      const bType = b.label.split(' ')[0];
      
      if (aType !== bType) return aType.localeCompare(bType);
      
      // Then sort by match number
      const aNum = parseInt(a.label.split(' ')[1]);
      const bNum = parseInt(b.label.split(' ')[1]);
      return aNum - bNum;
    });
    
    // Apply the same auto-completion logic
    for (let i = 0; i < matches.length - 1; i++) {
      if (matches[i].status === "On field") {
        for (let j = i + 1; j < matches.length; j++) {
          if (matches[j].status === "On field") {
            matches[i].status = "Completed";
            break;
          }
        }
      }
    }
    
    // Filter matches for the requested team using the modified matches
    const teamMatches = matches.filter(match => 
      Array.isArray(match.redTeams) && match.redTeams.includes(formattedTeamKey) || 
      Array.isArray(match.blueTeams) && match.blueTeams.includes(formattedTeamKey)
    );
    
    // Add TBA data to matches
    const matchesWithResults = await processMatchDataWithTBAResults(teamMatches, formattedTeamKey, eventKey);
    
    // Group matches by type and separate completed matches
    const matchGroups = {};
    const completedMatches = []; 
    matchesWithResults.forEach(match => {
      if (match.status === "Completed") {
        completedMatches.push(match);
      } else {
        const matchType = match.label.split(' ')[0];
        if (!matchGroups[matchType]) {
          matchGroups[matchType] = [];
        }
        matchGroups[matchType].push(match);
      }
    });
    
    // Render the embed page with the match data and ranking info
    res.render('pages/embed', {
      teamKey,
      formattedTeamKey,
      eventKey,
      eventName,
      matchGroups,
      completedMatches,
      nowQueuing,
      containerHeight,
      teamRanking
    });
    
  } catch (error) {
    console.error('Error generating match data:', error);
    // Instead of returning error JSON, render the embed page with empty data and error message
    res.render('pages/embed', {
      teamKey,
      formattedTeamKey,
      eventKey,
      eventName: eventKey || 'Unknown Event',
      matchGroups: {},
      completedMatches: [],
      nowQueuing: null,
      containerHeight,
      teamRanking: null,
      errorMessage: `Failed to generate match data: ${error.message}`
    });
  }
});

// Add a health endpoint for Docker healthchecks
router.get('/api/health', (req, res) => {
  res.status(200).send('OK');
});

// Add a data-check endpoint to detect changes
router.get('/api/data-check', async (req, res) => {
  let { eventKey: rawEventKey, teamKey, lastUpdate } = req.query;
  const eventKey = rawEventKey ? rawEventKey.toLowerCase() : rawEventKey;

  try {
    // Fetch Nexus data
    const eventData = await fetchEventDetails(eventKey);
    if (!eventData) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Fetch TBA data if teamKey is provided
    let tbaMatchData = [];
    let teamRankingData = null;
    if (teamKey) {
      // Format team key for TBA
      const formattedTeamKey = teamKey.startsWith('frc') ? teamKey : `frc${teamKey}`;
      
      // Get TBA match results
      tbaMatchData = await fetchEventMatchResults(eventKey);
      
      // Get team ranking from TBA
      const teamStatus = await fetchTeamStatusAtEvent(formattedTeamKey, eventKey);
      if (teamStatus && teamStatus.qual && teamStatus.qual.ranking) {
        teamRankingData = teamStatus.qual.ranking;
      }
    }

    // Create a copy of matches for modification
    const modifiedMatches = [...eventData.matches];

    // Sort matches by their sequence
    modifiedMatches.sort((a, b) => {
      const aType = a.label.split(' ')[0];
      const bType = b.label.split(' ')[0];
      if (aType !== bType) return aType.localeCompare(bType);

      const aNum = parseInt(a.label.split(' ')[1]);
      const bNum = parseInt(b.label.split(' ')[1]);
      return aNum - bNum;
    });

    // Mark earlier matches as completed if a later match is "On field"
    for (let i = 0; i < modifiedMatches.length - 1; i++) {
      if (modifiedMatches[i].status === "On field") {
        for (let j = i + 1; j < modifiedMatches.length; j++) {
          if (modifiedMatches[j].status === "On field") {
            modifiedMatches[i].status = "Completed";
            break;
          }
        }
      }
    }

    // Create a hash that includes both Nexus and TBA data
    const dataObj = {
      // Nexus data
      nowQueuing: eventData.nowQueuing || null,
      matchStatuses: modifiedMatches.map(m => ({
        id: m.label.replace(/\s+/g, '-'),
        status: m.status.trim()
      })).sort((a, b) => a.id.localeCompare(b.id)),
      
      // TBA data with more complete match details
      tbaMatches: tbaMatchData.map(m => ({
        key: m.key,
        comp_level: m.comp_level,
        match_number: m.match_number,
        alliances: m.alliances ? {
          red: { score: m.alliances.red.score },
          blue: { score: m.alliances.blue.score }
        } : null,
        winning_alliance: m.winning_alliance,
        // Include actual score breakdown data for RP calculations
        score_breakdown: m.score_breakdown ? {
          red: extractRPRelevantData(m.score_breakdown.red),
          blue: extractRPRelevantData(m.score_breakdown.blue)
        } : null
      })),
      
      // Team ranking data
      ranking: teamRankingData ? {
        rank: teamRankingData.rank,
        matches_played: teamRankingData.matches_played,
        sort_orders: teamRankingData.sort_orders,
        extra_stats: teamRankingData.extra_stats,
        wins: teamRankingData.record.wins,
        losses: teamRankingData.record.losses,
        ties: teamRankingData.record.ties
      } : null
    };

    const dataHash = JSON.stringify(dataObj);
    
    const currentHash = crypto
      .createHash('md5')
      .update(dataHash)
      .digest('hex');

    // If lastUpdate is empty, assume it's the initial load and don't trigger a refresh
    if (!lastUpdate) {
      lastUpdate = currentHash;
    }

    const hasChanged = lastUpdate !== currentHash;

    res.json({
      changed: hasChanged,
      hash: currentHash,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Error checking for updates:', error);
    res.status(500).json({ error: 'Failed to check for updates' });
  }
});

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

// Event search endpoint
router.get('/api/events/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    
    if (query.length < 3) {
      return res.json([]);
    }
    
    // Get current year
    const currentYear = new Date().getFullYear();
    
    // Search events from current and next year
    const [currentYearEvents, nextYearEvents] = await Promise.all([
      searchTBAEvents(query, currentYear),
      searchTBAEvents(query, currentYear + 1)
    ]);
    
    // Combine and limit results
    const combinedEvents = [...nextYearEvents, ...currentYearEvents];
    
    // Return top 10 results
    res.json(combinedEvents.slice(0, 10));
  } catch (error) {
    console.error('Error searching events:', error);
    res.status(500).json({ error: 'Failed to search events' });
  }
});

module.exports = router;